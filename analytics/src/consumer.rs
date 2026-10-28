//! Consumidor RabbitMQ: declara la topología, aplica cada evento en Mongo y
//! recalcula el informe de la elección afectada.
//!
//! - Mensaje mal formado o desconocido → nack sin reencolar → `analytics.events.dlq`.
//! - Fallo de Mongo → se libera el event_id y se reencola tras una pausa.
//! - Entrega repetida (mismo event_id) → ack sin volver a aplicarlo.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use lapin::options::{
    BasicAckOptions, BasicConsumeOptions, BasicNackOptions, BasicQosOptions,
    ExchangeDeclareOptions, QueueBindOptions, QueueDeclareOptions,
};
use lapin::types::{AMQPValue, FieldTable};
use lapin::{Channel, Connection, ConnectionProperties, ExchangeKind};
use tokio::sync::watch;

use crate::events::{self, BINDINGS, Envelope, Event};
use crate::store::Store;

pub const QUEUE: &str = "analytics.events";
pub const DEAD_LETTER_EXCHANGE: &str = "analytics.dlx";
pub const DEAD_LETTER_QUEUE: &str = "analytics.events.dlq";

const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// Declara exchanges, cola, DLQ y bindings. Es idempotente: cualquier servicio
/// puede declarar los mismos exchanges con las mismas opciones.
pub async fn declare_topology(channel: &Channel) -> lapin::Result<()> {
    let durable_exchange = ExchangeDeclareOptions {
        durable: true,
        ..Default::default()
    };
    for exchange in [
        events::ELECTION_EXCHANGE,
        events::VOTES_EXCHANGE,
        events::IDENTITY_EXCHANGE,
    ] {
        channel
            .exchange_declare(
                exchange,
                ExchangeKind::Topic,
                durable_exchange,
                FieldTable::default(),
            )
            .await?;
    }
    channel
        .exchange_declare(
            DEAD_LETTER_EXCHANGE,
            ExchangeKind::Fanout,
            durable_exchange,
            FieldTable::default(),
        )
        .await?;

    let durable_queue = QueueDeclareOptions {
        durable: true,
        ..Default::default()
    };
    channel
        .queue_declare(DEAD_LETTER_QUEUE, durable_queue, FieldTable::default())
        .await?;
    channel
        .queue_bind(
            DEAD_LETTER_QUEUE,
            DEAD_LETTER_EXCHANGE,
            "",
            QueueBindOptions::default(),
            FieldTable::default(),
        )
        .await?;

    let mut args = FieldTable::default();
    args.insert(
        "x-dead-letter-exchange".into(),
        AMQPValue::LongString(DEAD_LETTER_EXCHANGE.into()),
    );
    channel.queue_declare(QUEUE, durable_queue, args).await?;
    for (exchange, routing_key) in BINDINGS {
        channel
            .queue_bind(
                QUEUE,
                exchange,
                routing_key,
                QueueBindOptions::default(),
                FieldTable::default(),
            )
            .await?;
    }
    Ok(())
}

/// Aplica un evento ya decodificado y recalcula el informe si corresponde.
pub async fn apply(store: &Store, envelope: &Envelope, event: &Event) -> crate::store::Result<()> {
    if !store
        .claim_event(&envelope.event_id, &envelope.event_type)
        .await?
    {
        tracing::debug!(event_id = %envelope.event_id, "duplicate event skipped");
        return Ok(());
    }
    let result = async {
        let election_id = match event {
            Event::ElectionCreated(e) => {
                store.apply_election_created(e).await?;
                &e.election_id
            }
            Event::ElectionClosed(e) => {
                store.apply_election_closed(e).await?;
                &e.election_id
            }
            Event::CensusUpdated(e) => {
                store.apply_census_updated(e).await?;
                &e.election_id
            }
            Event::BallotCast(e) => {
                store.apply_ballot_cast(e).await?;
                &e.election_id
            }
            Event::TallyCompleted(e) => {
                store.apply_tally_completed(e, &envelope.event_id).await?;
                &e.election_id
            }
        };
        if let Some(report) = store.recompute(election_id).await? {
            tracing::info!(
                election_id,
                total_ballots = report.totals.total_ballots,
                "report updated"
            );
        }
        Ok(())
    }
    .await;
    if result.is_err()
        && let Err(e) = store.release_event(&envelope.event_id).await
    {
        tracing::warn!(error = %e, "could not release event claim");
    }
    result
}

pub struct Consumer {
    pub uri: String,
    pub prefetch: u16,
    pub store: Store,
    pub ready: Arc<AtomicBool>,
}

impl Consumer {
    /// Consume hasta que `shutdown` cambie, reconectando con backoff exponencial.
    pub async fn run(self, mut shutdown: watch::Receiver<bool>) {
        let mut backoff = Duration::from_secs(1);
        loop {
            let session = self.consume(&mut shutdown);
            match session.await {
                Ok(()) => break,
                Err(e) => {
                    self.ready.store(false, Ordering::Relaxed);
                    tracing::warn!(error = %e, retry_in = ?backoff, "rabbitmq connection lost");
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(backoff) => {}
                _ = shutdown.changed() => break,
            }
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
        self.ready.store(false, Ordering::Relaxed);
    }

    async fn consume(&self, shutdown: &mut watch::Receiver<bool>) -> lapin::Result<()> {
        let connection = Connection::connect(&self.uri, ConnectionProperties::default()).await?;
        let channel = connection.create_channel().await?;
        declare_topology(&channel).await?;
        channel
            .basic_qos(self.prefetch, BasicQosOptions::default())
            .await?;
        let mut deliveries = channel
            .basic_consume(
                QUEUE,
                "analytics",
                BasicConsumeOptions::default(),
                FieldTable::default(),
            )
            .await?;
        self.ready.store(true, Ordering::Relaxed);
        tracing::info!(queue = QUEUE, "consuming events");

        loop {
            let delivery = tokio::select! {
                next = deliveries.next() => match next {
                    Some(delivery) => delivery?,
                    None => return Err(lapin::Error::InvalidChannelState(lapin::ChannelState::Closed)),
                },
                _ = shutdown.changed() => {
                    let _ = connection.close(200, "shutdown").await;
                    return Ok(());
                }
            };

            match events::decode(&delivery.data) {
                Err(e) => {
                    tracing::warn!(error = %e, routing_key = %delivery.routing_key, "rejected event, sent to DLQ");
                    delivery
                        .nack(BasicNackOptions {
                            requeue: false,
                            ..Default::default()
                        })
                        .await?;
                }
                Ok((envelope, event)) => match apply(&self.store, &envelope, &event).await {
                    Ok(()) => delivery.ack(BasicAckOptions::default()).await?,
                    Err(e) => {
                        tracing::error!(error = %e, event_id = %envelope.event_id, "event processing failed, requeueing");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        delivery
                            .nack(BasicNackOptions {
                                requeue: true,
                                ..Default::default()
                            })
                            .await?;
                    }
                },
            }
        }
    }
}
