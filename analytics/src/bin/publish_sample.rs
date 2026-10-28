//! Publica en RabbitMQ los eventos de tres elecciones de ejemplo, para probar
//! analytics y su panel sin los demás servicios:
//!
//! - `consejo-superior-2026`: finalizada, 950 papeletas, con censo y voto en blanco.
//! - `representante-estudiantil-2026`: finalizada con empate en el primer puesto.
//! - `decanatura-ingenieria-2026`: abierta ahora mismo (participación en vivo).
//!
//!   cargo run --bin publish-sample
//!   docker compose exec analytics /publish-sample

use analytics::consumer::declare_topology;
use analytics::events::{ELECTION_EXCHANGE, IDENTITY_EXCHANGE, VOTES_EXCHANGE};
use chrono::{DateTime, Duration, DurationRound, TimeZone, Utc};
use lapin::options::{BasicPublishOptions, ConfirmSelectOptions};
use lapin::{BasicProperties, Channel, Connection, ConnectionProperties};
use serde_json::{Value, json};

struct Scenario {
    id: &'static str,
    name: &'static str,
    options: &'static [(&'static str, u64)],
    blank: Option<&'static str>,
    invalid: u64,
    eligible: u64,
    opens_at: DateTime<Utc>,
    hours: i64,
    /// Reparto de las papeletas por hora de jornada (suma 1.0).
    hourly_share: &'static [f64],
    finished: bool,
}

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

async fn publish_scenario(channel: &Channel, s: &Scenario) -> lapin::Result<u64> {
    let closes_at = s.opens_at + Duration::hours(s.hours);
    let options: Vec<&str> = s.options.iter().map(|(o, _)| *o).collect();
    publish(
        channel,
        ELECTION_EXCHANGE,
        "election.created",
        json!({
            "election_id": s.id, "name": s.name, "options": options, "blank_option": s.blank,
            "opens_at": s.opens_at, "closes_at": closes_at,
        }),
    )
    .await?;
    publish(
        channel,
        IDENTITY_EXCHANGE,
        "census.updated",
        json!({
            "election_id": s.id, "eligible_voters": s.eligible,
        }),
    )
    .await?;

    let total: u64 = s.options.iter().map(|(_, v)| v).sum::<u64>() + s.invalid;
    let mut sent = 0u64;
    for (hour, share) in s.hourly_share.iter().enumerate() {
        let last = hour == s.hourly_share.len() - 1;
        let in_hour = if last {
            total - sent
        } else {
            (total as f64 * share).round() as u64
        };
        for i in 0..in_hour {
            let cast_at = s.opens_at
                + Duration::hours(hour as i64)
                + Duration::seconds((i * 3600 / in_hour.max(1)) as i64);
            publish(
                channel,
                VOTES_EXCHANGE,
                "votes.cast",
                json!({ "election_id": s.id, "cast_at": cast_at }),
            )
            .await?;
        }
        sent += in_hour;
    }

    if s.finished {
        publish(
            channel,
            ELECTION_EXCHANGE,
            "election.closed",
            json!({
                "election_id": s.id, "closed_at": closes_at,
            }),
        )
        .await?;
        let results: Vec<Value> = s
            .options
            .iter()
            .map(|(o, v)| json!({ "option": o, "votes": v }))
            .collect();
        publish(
            channel,
            VOTES_EXCHANGE,
            "tally.completed",
            json!({
                "election_id": s.id, "total_ballots": total, "invalid_ballots": s.invalid,
                "results": results, "tallied_at": closes_at + Duration::minutes(2),
            }),
        )
        .await?;
    }
    Ok(sent)
}

#[tokio::main]
async fn main() -> lapin::Result<()> {
    let uri = std::env::var("ANALYTICS_RABBITMQ_URI")
        .unwrap_or_else(|_| "amqp://guest:guest@localhost:5672/%2f".into());
    let connection = Connection::connect(&uri, ConnectionProperties::default()).await?;
    let channel = connection.create_channel().await?;
    channel
        .confirm_select(ConfirmSelectOptions::default())
        .await?;
    declare_topology(&channel).await?;

    // La elección en curso abrió hace 3 horas y cierra dentro de 5.
    let live_open = Utc::now()
        .duration_trunc(Duration::hours(1))
        .expect("trunc")
        - Duration::hours(3);
    let scenarios = [
        Scenario {
            id: "consejo-superior-2026",
            name: "Consejo Superior Universitario 2026",
            options: &[
                ("candidata-1", 412),
                ("candidato-2", 365),
                ("candidato-3", 98),
                ("voto-en-blanco", 57),
            ],
            blank: Some("voto-en-blanco"),
            invalid: 18,
            eligible: 1500,
            opens_at: Utc.with_ymd_and_hms(2026, 10, 20, 13, 0, 0).unwrap(),
            hours: 8,
            hourly_share: &[0.06, 0.11, 0.17, 0.14, 0.09, 0.12, 0.16, 0.15],
            finished: true,
        },
        Scenario {
            id: "representante-estudiantil-2026",
            name: "Representante estudiantil 2026",
            options: &[
                ("lista-a", 134),
                ("lista-b", 134),
                ("lista-c", 61),
                ("voto-en-blanco", 22),
            ],
            blank: Some("voto-en-blanco"),
            invalid: 9,
            eligible: 620,
            opens_at: Utc.with_ymd_and_hms(2026, 10, 14, 13, 0, 0).unwrap(),
            hours: 30,
            hourly_share: &[
                0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5,
            ],
            finished: true,
        },
        Scenario {
            id: "decanatura-ingenieria-2026",
            name: "Decanatura Facultad de Ingeniería 2026",
            options: &[
                ("candidata-a", 0),
                ("candidato-b", 0),
                ("voto-en-blanco", 0),
            ],
            blank: Some("voto-en-blanco"),
            invalid: 0,
            eligible: 800,
            opens_at: live_open,
            hours: 8,
            hourly_share: &[],
            finished: false,
        },
    ];

    for s in &scenarios {
        let sent = publish_scenario(&channel, s).await?;
        println!(
            "{}: {} votes.cast{}",
            s.id,
            sent,
            if s.finished { " + tally.completed" } else { "" }
        );
    }

    // Votos de la elección en curso: tres horas completas y la actual.
    let live = &scenarios[2];
    for (hour, count) in [(0i64, 41u64), (1, 66), (2, 52), (3, 17)] {
        for i in 0..count {
            let cast_at = live.opens_at
                + Duration::hours(hour)
                + Duration::seconds((i * 3000 / count) as i64);
            if cast_at > Utc::now() {
                break;
            }
            publish(
                &channel,
                VOTES_EXCHANGE,
                "votes.cast",
                json!({ "election_id": live.id, "cast_at": cast_at }),
            )
            .await?;
        }
    }
    println!("{}: votes.cast en vivo publicados", live.id);
    connection.close(200, "done").await
}
