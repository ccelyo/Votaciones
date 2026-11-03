//go:build integration

package main_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/ccelyo/Votaciones/tally/internal/events"
	"github.com/ccelyo/Votaciones/tally/internal/publisher"
)

// Run with:
//
//	TALLY_TEST_RABBITMQ_URI=amqp://guest:guest@localhost:5672/ go test -tags integration ./...
func TestPublishTallyCompletedToRabbitMQ(t *testing.T) {
	uri := os.Getenv("TALLY_TEST_RABBITMQ_URI")
	if uri == "" {
		t.Skip("TALLY_TEST_RABBITMQ_URI is not set")
	}
	exchange := "tally.test.events"
	queue := "tally.test.events.q"

	conn, err := amqp.Dial(uri)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	channel, err := conn.Channel()
	if err != nil {
		t.Fatal(err)
	}
	defer channel.Close()
	if err := channel.ExchangeDeclare(exchange, amqp.ExchangeTopic, true, false, false, false, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := channel.QueueDeclare(queue, false, true, false, false, nil); err != nil {
		t.Fatal(err)
	}
	if err := channel.QueueBind(queue, "tally.completed", exchange, false, nil); err != nil {
		t.Fatal(err)
	}

	broker := publisher.NewRabbit(uri, exchange, 3)
	defer broker.Close()
	envelope := events.NewCompleted(
		"e2e-election",
		"digest",
		3,
		0,
		[]events.OptionVotes{{Option: "a", Votes: 2}, {Option: "b", Votes: 1}},
		time.Now(),
	)
	if err := broker.Publish(context.Background(), envelope); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		message, ok, err := channel.Get(queue, true)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			var decoded events.Envelope
			if err := json.Unmarshal(message.Body, &decoded); err != nil {
				t.Fatal(err)
			}
			if decoded.EventID != envelope.EventID || decoded.EventType != events.TypeTallyCompleted {
				t.Fatalf("unexpected message: %+v", decoded)
			}
			if decoded.Data.TotalBallots != 3 || len(decoded.Data.Results) != 2 {
				t.Fatalf("unexpected payload: %+v", decoded.Data)
			}
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("timed out waiting for tally.completed")
		case <-time.After(50 * time.Millisecond):
		}
	}
}
