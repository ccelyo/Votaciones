// Package publisher publishes tally.completed to RabbitMQ with publisher
// confirms, persistent messages and bounded retries.
package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/ccelyo/Votaciones/tally/internal/events"
)

// ErrUnavailable means the broker could not accept the event.
var ErrUnavailable = errors.New("rabbitmq unavailable")

// Publisher is the port used by the tally service; tests provide a fake.
type Publisher interface {
	Publish(ctx context.Context, envelope events.Envelope) error
	Ping(ctx context.Context) error
	Close() error
}

// Rabbit is a lazily connected AMQP publisher. A mutex serializes publishes,
// which is fine for one scrutiny at a time and makes confirms unambiguous.
type Rabbit struct {
	uri      string
	exchange string
	attempts int

	mu   sync.Mutex
	conn *amqp.Connection
	ch   *amqp.Channel
	ret  chan amqp.Return
}

// NewRabbit builds a publisher. The connection is opened on first use so the
// service can start while the broker finishes booting.
func NewRabbit(uri, exchange string, attempts int) *Rabbit {
	if attempts < 1 {
		attempts = 1
	}
	return &Rabbit{uri: uri, exchange: exchange, attempts: attempts}
}

// Publish sends the envelope and waits for the broker confirmation.
func (p *Rabbit) Publish(ctx context.Context, envelope events.Envelope) error {
	body, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt < p.attempts; attempt++ {
		if attempt > 0 {
			if err := sleep(ctx, backoff(attempt)); err != nil {
				return err
			}
		}
		err := p.publishOnce(ctx, envelope, body)
		if err == nil {
			return nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = ErrUnavailable
	}
	return fmt.Errorf("%w: %v", ErrUnavailable, lastErr)
}

func (p *Rabbit) publishOnce(ctx context.Context, envelope events.Envelope, body []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	channel, err := p.channelLocked()
	if err != nil {
		return err
	}
	confirmation, err := channel.PublishWithDeferredConfirmWithContext(
		ctx,
		p.exchange,
		events.TypeTallyCompleted,
		true,  // mandatory: fail if no queue is bound
		false, // immediate
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			MessageId:    envelope.EventID,
			Type:         envelope.EventType,
			AppId:        events.Producer,
			Timestamp:    envelope.OccurredAt,
			Body:         body,
		},
	)
	if err != nil {
		p.resetLocked()
		return fmt.Errorf("publish: %w", err)
	}

	acked, err := confirmation.WaitContext(ctx)
	if err != nil {
		p.resetLocked()
		return err
	}
	if !acked {
		p.resetLocked()
		return errors.New("broker rejected the event (nack or channel closed)")
	}

	// With mandatory=true RabbitMQ returns unroutable messages (basic.return)
	// before the confirm. A returned event must not be considered delivered.
	select {
	case returned := <-p.ret:
		p.resetLocked()
		return fmt.Errorf("event was unroutable (%d %s)", returned.ReplyCode, returned.ReplyText)
	default:
		return nil
	}
}

// Ping opens the connection if needed; it backs /readyz.
func (p *Rabbit) Ping(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, err := p.channelLocked()
	return err
}

// Close releases the AMQP channel and connection.
func (p *Rabbit) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resetLocked()
	return nil
}

func (p *Rabbit) channelLocked() (*amqp.Channel, error) {
	if p.conn != nil && !p.conn.IsClosed() && p.ch != nil && !p.ch.IsClosed() {
		return p.ch, nil
	}
	p.resetLocked()

	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := amqp.DialConfig(p.uri, amqp.Config{
		Heartbeat: 10 * time.Second,
		Locale:    "en_US",
		Dial:      dialer.Dial,
	})
	if err != nil {
		return nil, fmt.Errorf("dial rabbitmq: %w", err)
	}
	channel, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("open rabbitmq channel: %w", err)
	}
	if err := channel.ExchangeDeclare(p.exchange, amqp.ExchangeTopic, true, false, false, false, nil); err != nil {
		_ = channel.Close()
		_ = conn.Close()
		return nil, fmt.Errorf("declare exchange %q: %w", p.exchange, err)
	}
	if err := channel.Confirm(false); err != nil {
		_ = channel.Close()
		_ = conn.Close()
		return nil, fmt.Errorf("enable publisher confirms: %w", err)
	}
	p.conn = conn
	p.ch = channel
	p.ret = channel.NotifyReturn(make(chan amqp.Return, 1))
	return channel, nil
}

func (p *Rabbit) resetLocked() {
	if p.ch != nil {
		_ = p.ch.Close()
	}
	if p.conn != nil {
		_ = p.conn.Close()
	}
	p.ch = nil
	p.conn = nil
	p.ret = nil
}

func backoff(attempt int) time.Duration {
	delay := 200 * time.Millisecond << (attempt - 1)
	if delay > 5*time.Second {
		delay = 5 * time.Second
	}
	return delay
}

func sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
