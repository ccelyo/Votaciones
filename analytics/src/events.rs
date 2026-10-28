//! Contratos de los eventos que consume analytics (ver CONTRACTS.md).
//!
//! Todos los mensajes llegan con el mismo sobre JSON; la routing key de
//! RabbitMQ coincide con `event_type`.

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde::de::DeserializeOwned;

pub const ELECTION_EXCHANGE: &str = "election.events";
pub const VOTES_EXCHANGE: &str = "votes.events";
pub const IDENTITY_EXCHANGE: &str = "identity.events";

/// (exchange, routing key) a los que se enlaza la cola de analytics.
pub const BINDINGS: &[(&str, &str)] = &[
    (ELECTION_EXCHANGE, "election.created"),
    (ELECTION_EXCHANGE, "election.closed"),
    (IDENTITY_EXCHANGE, "census.updated"),
    (VOTES_EXCHANGE, "ballot.cast"),
    (VOTES_EXCHANGE, "tally.completed"),
];

#[derive(Debug, Deserialize)]
pub struct Envelope {
    pub event_id: String,
    pub event_type: String,
    pub occurred_at: DateTime<Utc>,
    #[serde(default)]
    pub producer: Option<String>,
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub data: serde_json::Value,
}

fn default_schema_version() -> u32 {
    1
}

#[derive(Debug, Clone, Deserialize)]
pub struct ElectionCreated {
    pub election_id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub options: Vec<String>,
    #[serde(default)]
    pub blank_option: Option<String>,
    pub opens_at: DateTime<Utc>,
    pub closes_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ElectionClosed {
    pub election_id: String,
    pub closed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CensusUpdated {
    pub election_id: String,
    pub eligible_voters: u64,
}

/// Solo la elección y el instante; nunca token, recibo ni votante.
#[derive(Debug, Clone, Deserialize)]
pub struct BallotCast {
    pub election_id: String,
    pub cast_at: DateTime<Utc>,
}

/// Mismo formato que `GET /v1/elections/{id}/results` de ballot.
#[derive(Debug, Clone, Deserialize)]
pub struct TallyCompleted {
    pub election_id: String,
    pub total_ballots: u64,
    pub invalid_ballots: u64,
    pub results: Vec<OptionVotes>,
    pub tallied_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize, PartialEq)]
pub struct OptionVotes {
    pub option: String,
    pub votes: u64,
}

#[derive(Debug)]
pub enum Event {
    ElectionCreated(ElectionCreated),
    ElectionClosed(ElectionClosed),
    CensusUpdated(CensusUpdated),
    BallotCast(BallotCast),
    TallyCompleted(TallyCompleted),
}

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("invalid envelope: {0}")]
    Envelope(serde_json::Error),
    #[error("unsupported schema_version {0}")]
    SchemaVersion(u32),
    #[error("unknown event_type {0}")]
    UnknownType(String),
    #[error("invalid data for {event_type}: {source}")]
    Data {
        event_type: String,
        source: serde_json::Error,
    },
    #[error("inconsistent data: {0}")]
    Inconsistent(&'static str),
}

pub fn decode(body: &[u8]) -> Result<(Envelope, Event), DecodeError> {
    let envelope: Envelope = serde_json::from_slice(body).map_err(DecodeError::Envelope)?;
    if envelope.schema_version != 1 {
        return Err(DecodeError::SchemaVersion(envelope.schema_version));
    }
    let event = match envelope.event_type.as_str() {
        "election.created" => Event::ElectionCreated(data(&envelope)?),
        "election.closed" => Event::ElectionClosed(data(&envelope)?),
        "census.updated" => Event::CensusUpdated(data(&envelope)?),
        "ballot.cast" => Event::BallotCast(data(&envelope)?),
        "tally.completed" => Event::TallyCompleted(data(&envelope)?),
        other => return Err(DecodeError::UnknownType(other.to_owned())),
    };
    validate(&event)?;
    Ok((envelope, event))
}

fn data<T: DeserializeOwned>(envelope: &Envelope) -> Result<T, DecodeError> {
    serde_json::from_value(envelope.data.clone()).map_err(|source| DecodeError::Data {
        event_type: envelope.event_type.clone(),
        source,
    })
}

fn validate(event: &Event) -> Result<(), DecodeError> {
    let election_id = match event {
        Event::ElectionCreated(e) => &e.election_id,
        Event::ElectionClosed(e) => &e.election_id,
        Event::CensusUpdated(e) => &e.election_id,
        Event::BallotCast(e) => &e.election_id,
        Event::TallyCompleted(e) => &e.election_id,
    };
    if election_id.trim().is_empty() {
        return Err(DecodeError::Inconsistent("election_id is empty"));
    }
    match event {
        Event::ElectionCreated(e) => {
            if e.options.is_empty() {
                return Err(DecodeError::Inconsistent("options is empty"));
            }
            if e.closes_at <= e.opens_at {
                return Err(DecodeError::Inconsistent(
                    "closes_at must be after opens_at",
                ));
            }
            if let Some(blank) = &e.blank_option
                && !e.options.contains(blank)
            {
                return Err(DecodeError::Inconsistent(
                    "blank_option is not one of options",
                ));
            }
        }
        Event::TallyCompleted(t) => {
            let valid: u64 = t.results.iter().map(|r| r.votes).sum();
            if valid.checked_add(t.invalid_ballots) != Some(t.total_ballots) {
                return Err(DecodeError::Inconsistent(
                    "sum(results.votes) + invalid_ballots must equal total_ballots",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_tally_completed() {
        let body = br#"{
            "event_id": "7b0c", "event_type": "tally.completed",
            "occurred_at": "2026-10-20T18:00:05Z", "producer": "tally",
            "data": {"election_id": "e1", "total_ballots": 4, "invalid_ballots": 1,
                     "results": [{"option": "a", "votes": 2}, {"option": "b", "votes": 1}],
                     "tallied_at": "2026-10-20T18:00:00Z"}
        }"#;
        let (envelope, event) = decode(body).unwrap();
        assert_eq!(envelope.event_id, "7b0c");
        assert!(matches!(event, Event::TallyCompleted(t) if t.total_ballots == 4));
    }

    #[test]
    fn rejects_inconsistent_tally() {
        let body = br#"{
            "event_id": "1", "event_type": "tally.completed", "occurred_at": "2026-10-20T18:00:05Z",
            "data": {"election_id": "e1", "total_ballots": 9, "invalid_ballots": 0,
                     "results": [{"option": "a", "votes": 2}], "tallied_at": "2026-10-20T18:00:00Z"}
        }"#;
        assert!(matches!(decode(body), Err(DecodeError::Inconsistent(_))));
    }

    #[test]
    fn rejects_unknown_type_and_version() {
        let unknown = br#"{"event_id":"1","event_type":"x.y","occurred_at":"2026-10-20T18:00:05Z","data":{}}"#;
        assert!(matches!(decode(unknown), Err(DecodeError::UnknownType(_))));
        let version = br#"{"event_id":"1","event_type":"ballot.cast","schema_version":2,"occurred_at":"2026-10-20T18:00:05Z","data":{}}"#;
        assert!(matches!(
            decode(version),
            Err(DecodeError::SchemaVersion(2))
        ));
    }
}
