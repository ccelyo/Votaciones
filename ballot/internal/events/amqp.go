package events

import (
	"context"
	"fmt"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// Publisher sends votes.cast to the votes.events topic exchange.
// A channel is not safe for concurrent publishes, so VoteCast serializes them.
type Publisher struct {
	conn     *amqp.Connection
	channel  *amqp.Channel
	confirms <-chan amqp.Confirmation
	exchange string
	mu       sync.Mutex
}

// Dial connects to RabbitMQ and declares the durable votes.events exchange.
func Dial(uri string) (*Publisher, error) {
	conn, err := amqp.Dial(uri)
	if err != nil {
		return nil, fmt.Errorf("rabbitmq dial: %w", err)
	}
	channel, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("rabbitmq channel: %w", err)
	}
	if err := channel.ExchangeDeclare(VotesExchange, "topic", true, false, false, false, nil); err != nil {
		_ = channel.Close()
		_ = conn.Close()
		return nil, fmt.Errorf("rabbitmq exchange: %w", err)
	}
	if err := channel.Confirm(false); err != nil {
		_ = channel.Close()
		_ = conn.Close()
		return nil, fmt.Errorf("rabbitmq confirms: %w", err)
	}
	return &Publisher{
		conn:     conn,
		channel:  channel,
		confirms: channel.NotifyPublish(make(chan amqp.Confirmation, 1)),
		exchange: VotesExchange,
	}, nil
}

// VoteCast publishes one accepted ballot. The body is only election and minute.
func (p *Publisher) VoteCast(ctx context.Context, electionID string, at time.Time) error {
	if p == nil || p.channel == nil {
		return fmt.Errorf("rabbitmq publisher is not connected")
	}
	body, err := MarshalVoteCast(electionID, at)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.channel.PublishWithContext(ctx, p.exchange, VoteCastType, false, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		Timestamp:    at.UTC(),
		Body:         body,
	}); err != nil {
		return err
	}
	select {
	case confirm, ok := <-p.confirms:
		if !ok || !confirm.Ack {
			return fmt.Errorf("votes.cast was not confirmed by the broker")
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close releases the channel and the connection.
func (p *Publisher) Close() error {
	if p == nil {
		return nil
	}
	var err error
	if p.channel != nil {
		err = p.channel.Close()
	}
	if p.conn != nil {
		if closeErr := p.conn.Close(); err == nil {
			err = closeErr
		}
	}
	return err
}
