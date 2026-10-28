//! Publica en RabbitMQ los eventos de una elección ya terminada, para probar
//! analytics sin los demás servicios:
//!
//!   cargo run --bin publish-sample            # elección «consejo-superior-2026»
//!   cargo run --bin publish-sample -- mi-id   # otro election_id

use analytics::consumer::declare_topology;
use analytics::events::{ELECTION_EXCHANGE, IDENTITY_EXCHANGE, VOTES_EXCHANGE};
use chrono::{Duration, TimeZone, Utc};
use lapin::options::{BasicPublishOptions, ConfirmSelectOptions};
use lapin::{BasicProperties, Channel, Connection, ConnectionProperties};
use serde_json::{Value, json};

const OPTIONS: [(&str, u64); 4] = [
    ("candidata-1", 412),
    ("candidato-2", 365),
    ("candidato-3", 98),
    ("voto-en-blanco", 57),
];
const INVALID: u64 = 18;
const ELIGIBLE: u64 = 1500;
// Reparto de las papeletas en las 8 horas de jornada (suma 1.0).
const HOURLY_SHARE: [f64; 8] = [0.06, 0.11, 0.17, 0.14, 0.09, 0.12, 0.16, 0.15];

async fn publish(
    channel: &Channel,
    exchange: &str,
    event_type: &str,
    data: Value,
) -> lapin::Result<()> {
    let body = json!({
        "event_id": uuid::Uuid::new_v4().to_string(),
        "event_type": event_type,
        "occurred_at": Utc::now(),
        "producer": "publish-sample",
        "schema_version": 1,
        "data": data,
    });
    channel
        .basic_publish(
            exchange,
            event_type,
            BasicPublishOptions::default(),
            &serde_json::to_vec(&body).expect("json"),
            BasicProperties::default()
                .with_content_type("application/json".into())
                .with_delivery_mode(2),
        )
        .await?
        .await?;
    Ok(())
}

#[tokio::main]
async fn main() -> lapin::Result<()> {
    let election_id = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "consejo-superior-2026".into());
    let uri = std::env::var("ANALYTICS_RABBITMQ_URI")
        .unwrap_or_else(|_| "amqp://guest:guest@localhost:5672/%2f".into());
    let connection = Connection::connect(&uri, ConnectionProperties::default()).await?;
    let channel = connection.create_channel().await?;
    channel
        .confirm_select(ConfirmSelectOptions::default())
        .await?;
    declare_topology(&channel).await?;

    let opens_at = Utc.with_ymd_and_hms(2026, 10, 20, 13, 0, 0).unwrap();
    let closes_at = opens_at + Duration::hours(8);
    let options: Vec<&str> = OPTIONS.iter().map(|(o, _)| *o).collect();

    publish(
        &channel,
        ELECTION_EXCHANGE,
        "election.created",
        json!({
            "election_id": election_id, "name": "Consejo Superior Universitario 2026",
            "options": options, "blank_option": "voto-en-blanco",
            "opens_at": opens_at, "closes_at": closes_at,
        }),
    )
    .await?;
    publish(
        &channel,
        IDENTITY_EXCHANGE,
        "census.updated",
        json!({
            "election_id": election_id, "eligible_voters": ELIGIBLE,
        }),
    )
    .await?;

    let total: u64 = OPTIONS.iter().map(|(_, v)| v).sum::<u64>() + INVALID;
    let mut sent = 0u64;
    for (hour, share) in HOURLY_SHARE.iter().enumerate() {
        let in_hour = if hour == HOURLY_SHARE.len() - 1 {
            total - sent
        } else {
            (total as f64 * share).round() as u64
        };
        for i in 0..in_hour {
            let cast_at = opens_at
                + Duration::hours(hour as i64)
                + Duration::seconds((i * 3600 / in_hour.max(1)) as i64);
            publish(
                &channel,
                VOTES_EXCHANGE,
                "ballot.cast",
                json!({ "election_id": election_id, "cast_at": cast_at }),
            )
            .await?;
        }
        sent += in_hour;
    }

    publish(
        &channel,
        ELECTION_EXCHANGE,
        "election.closed",
        json!({
            "election_id": election_id, "closed_at": closes_at,
        }),
    )
    .await?;
    let results: Vec<Value> = OPTIONS
        .iter()
        .map(|(o, v)| json!({ "option": o, "votes": v }))
        .collect();
    publish(
        &channel,
        VOTES_EXCHANGE,
        "tally.completed",
        json!({
            "election_id": election_id, "total_ballots": total, "invalid_ballots": INVALID,
            "results": results, "tallied_at": closes_at + Duration::minutes(2),
        }),
    )
    .await?;

    println!(
        "published {} ballot.cast + 4 lifecycle events for {election_id}",
        sent
    );
    connection.close(200, "done").await
}
