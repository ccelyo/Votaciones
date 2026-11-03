package events

import (
	"context"
	"errors"
	"fmt"

	amqp "github.com/rabbitmq/amqp091-go"
)

// ElectionConsumer reads election.created and election.closed from election.events.
type ElectionConsumer struct {
	conn    *amqp.Connection
	channel *amqp.Channel
}

// DialElectionConsumer declares the durable exchange, the ballot queue and its bindings.
func DialElectionConsumer(uri string) (*ElectionConsumer, error) {
	conn, err := amqp.Dial(uri)
	if err != nil {
		return nil, fmt.Errorf("rabbitmq dial: %w", err)
	}
	channel, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("rabbitmq channel: %w", err)
	}
	if err := channel.ExchangeDeclare(ElectionExchange, "topic", true, false, false, false, nil); err != nil {
		_ = channel.Close()
		_ = conn.Close()
		return nil, fmt.Errorf("rabbitmq exchange: %w", err)
	}
	if _, err := channel.QueueDeclare(ElectionQueue, true, false, false, false, nil); err != nil {
		_ = channel.Close()
		_ = conn.Close()
		return nil, fmt.Errorf("rabbitmq queue: %w", err)
	}
	for _, key := range []string{electionCreated, electionClosed} {
		if err := channel.QueueBind(ElectionQueue, key, ElectionExchange, false, nil); err != nil {
			_ = channel.Close()
			_ = conn.Close()
			return nil, fmt.Errorf("rabbitmq bind: %w", err)
		}
	}
	if err := channel.Qos(8, 0, false); err != nil {
		_ = channel.Close()
		_ = conn.Close()
		return nil, fmt.Errorf("rabbitmq qos: %w", err)
	}
	return &ElectionConsumer{conn: conn, channel: channel}, nil
}

// Run applies each delivery until the context is canceled or the broker closes the channel.
// Invalid events are acknowledged so they do not block the queue. A store outage is requeued once.
func (c *ElectionConsumer) Run(ctx context.Context, apply func(context.Context, []byte) error) error {
	if c == nil || c.channel == nil {
		return errors.New("election consumer is not connected")
	}
	deliveries, err := c.channel.Consume(ElectionQueue, "ballot", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("rabbitmq consume: %w", err)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case delivery, ok := <-deliveries:
			if !ok {
				return errors.New("election consumer channel closed")
			}
			err := apply(ctx, delivery.Body)
			if err != nil && !permanentElectionError(err) {
				_ = delivery.Nack(false, !delivery.Redelivered)
				continue
			}
			_ = delivery.Ack(false)
		}
	}
}

func permanentElectionError(err error) bool {
	return errors.Is(err, ErrMetadataOnly) || errors.Is(err, ErrElectionNotRegistered) || errors.Is(err, ErrPermanentEvent)
}

// Close releases the channel and the connection.
func (c *ElectionConsumer) Close() error {
	if c == nil {
		return nil
	}
	var err error
	if c.channel != nil {
		err = c.channel.Close()
	}
	if c.conn != nil {
		if closeErr := c.conn.Close(); err == nil {
			err = closeErr
		}
	}
	return err
}
