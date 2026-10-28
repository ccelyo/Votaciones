//! Persistencia en la base MongoDB «Results» de analytics.
//!
//! Colecciones:
//! - `elections`         metadatos de la elección (election.created/closed, census.updated)
//! - `tallies`           conteo final recibido de tally (uno por elección)
//! - `turnout_hourly`    papeletas por hora, sin ningún dato del votante
//! - `reports`           informe analítico final, recalculado al llegar datos
//! - `processed_events`  event_id ya aplicados, para que la entrega repetida sea inocua

use bson::{Bson, DateTime as BsonDateTime, Document, doc};
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use mongodb::error::{ErrorKind, WriteFailure};
use mongodb::options::{FindOptions, IndexOptions, ReplaceOptions};
use mongodb::{Client, Collection, Database, IndexModel};
use serde::{Deserialize, Serialize};

use crate::events::{
    CensusUpdated, ElectionClosed, ElectionCreated, OptionVotes, TallyCompleted, VoteCast,
};
use crate::report::{ElectionMeta, ElectionReport, HourBucket, Tally, build_report, hour_start};

pub type Result<T> = std::result::Result<T, mongodb::error::Error>;

#[derive(Clone)]
pub struct Store {
    db: Database,
    elections: Collection<Document>,
    tallies: Collection<TallyDoc>,
    turnout: Collection<Document>,
    reports: Collection<Document>,
    processed: Collection<Document>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TallyDoc {
    #[serde(rename = "_id")]
    election_id: String,
    total_ballots: i64,
    invalid_ballots: i64,
    results: Vec<OptionVotes>,
    tallied_at: BsonDateTime,
    event_id: String,
}

fn bson_time(at: DateTime<Utc>) -> BsonDateTime {
    BsonDateTime::from_chrono(at)
}

fn time_field(doc: &Document, key: &str) -> Option<DateTime<Utc>> {
    doc.get_datetime(key).ok().map(|d| d.to_chrono())
}

fn is_duplicate_key(error: &mongodb::error::Error) -> bool {
    matches!(&*error.kind, ErrorKind::Write(WriteFailure::WriteError(e)) if e.code == 11000)
}

impl Store {
    pub async fn connect(uri: &str, database: &str) -> Result<Self> {
        let client = Client::with_uri_str(uri).await?;
        let db = client.database(database);
        Ok(Self {
            elections: db.collection("elections"),
            tallies: db.collection("tallies"),
            turnout: db.collection("turnout_hourly"),
            reports: db.collection("reports"),
            processed: db.collection("processed_events"),
            db,
        })
    }

    pub fn database(&self) -> &Database {
        &self.db
    }

    /// Ids de las elecciones conocidas que aún no tienen conteo final.
    pub async fn pending_election_ids(&self) -> Result<Vec<String>> {
        let known: Vec<Document> = self.elections.find(doc! {}).await?.try_collect().await?;
        let mut ids = Vec::new();
        for election in known {
            if let Ok(id) = election.get_str("_id")
                && self.tallies.count_documents(doc! { "_id": id }).await? == 0
            {
                ids.push(id.to_owned());
            }
        }
        Ok(ids)
    }

    pub async fn ensure_indexes(&self) -> Result<()> {
        self.turnout
            .create_index(
                IndexModel::builder()
                    .keys(doc! { "election_id": 1, "hour": 1 })
                    .options(IndexOptions::builder().unique(true).build())
                    .build(),
            )
            .await?;
        self.reports
            .create_index(
                IndexModel::builder()
                    .keys(doc! { "tallied_at": -1 })
                    .build(),
            )
            .await?;
        Ok(())
    }

    pub async fn ping(&self) -> Result<()> {
        self.db.run_command(doc! { "ping": 1 }).await.map(|_| ())
    }

    /// Reserva un event_id. Devuelve false si ya se había procesado.
    pub async fn claim_event(&self, event_id: &str, event_type: &str) -> Result<bool> {
        let marker =
            doc! { "_id": event_id, "event_type": event_type, "processed_at": BsonDateTime::now() };
        match self.processed.insert_one(marker).await {
            Ok(_) => Ok(true),
            Err(e) if is_duplicate_key(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Libera la reserva si el procesamiento falló, para que el reintento lo aplique.
    pub async fn release_event(&self, event_id: &str) -> Result<()> {
        self.processed
            .delete_one(doc! { "_id": event_id })
            .await
            .map(|_| ())
    }

    async fn upsert_election(&self, election_id: &str, set: Document) -> Result<()> {
        self.elections
            .update_one(doc! { "_id": election_id }, doc! { "$set": set })
            .upsert(true)
            .await
            .map(|_| ())
    }

    pub async fn apply_election_created(&self, e: &ElectionCreated) -> Result<()> {
        let mut set = doc! {
            "options": &e.options,
            "opens_at": bson_time(e.opens_at),
            "closes_at": bson_time(e.closes_at),
            "blank_option": e.blank_option.clone().map_or(Bson::Null, Bson::String),
        };
        if let Some(name) = &e.name {
            set.insert("name", name);
        }
        self.upsert_election(&e.election_id, set).await
    }

    pub async fn apply_election_closed(&self, e: &ElectionClosed) -> Result<()> {
        self.upsert_election(&e.election_id, doc! { "closed_at": bson_time(e.closed_at) })
            .await
    }

    pub async fn apply_census_updated(&self, e: &CensusUpdated) -> Result<()> {
        let eligible = i64::try_from(e.eligible_voters).unwrap_or(i64::MAX);
        self.upsert_election(&e.election_id, doc! { "eligible_voters": eligible })
            .await
    }

    pub async fn apply_vote_cast(&self, e: &VoteCast) -> Result<()> {
        let hour = hour_start(e.cast_at);
        self.turnout
            .update_one(
                doc! { "election_id": &e.election_id, "hour": bson_time(hour) },
                doc! { "$inc": { "ballots": 1_i64 } },
            )
            .upsert(true)
            .await
            .map(|_| ())
    }

    pub async fn apply_tally_completed(&self, e: &TallyCompleted, event_id: &str) -> Result<()> {
        let tally = TallyDoc {
            election_id: e.election_id.clone(),
            total_ballots: e.total_ballots as i64,
            invalid_ballots: e.invalid_ballots as i64,
            results: e.results.clone(),
            tallied_at: bson_time(e.tallied_at),
            event_id: event_id.to_owned(),
        };
        self.tallies
            .replace_one(doc! { "_id": &e.election_id }, tally)
            .with_options(ReplaceOptions::builder().upsert(true).build())
            .await?;
        // El conteo solo existe con la urna cerrada: fija closed_at si aún no llegó.
        self.elections
            .update_one(
                doc! { "_id": &e.election_id, "closed_at": { "$exists": false } },
                doc! { "$set": { "closed_at": bson_time(e.tallied_at) } },
            )
            .await?;
        Ok(())
    }

    pub async fn election_meta(&self, election_id: &str) -> Result<Option<ElectionMeta>> {
        let Some(doc) = self.elections.find_one(doc! { "_id": election_id }).await? else {
            return Ok(None);
        };
        Ok(Some(ElectionMeta {
            election_id: election_id.to_owned(),
            name: doc.get_str("name").ok().map(str::to_owned),
            options: doc
                .get_array("options")
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            blank_option: doc.get_str("blank_option").ok().map(str::to_owned),
            opens_at: time_field(&doc, "opens_at"),
            closes_at: time_field(&doc, "closes_at"),
            closed_at: time_field(&doc, "closed_at"),
            eligible_voters: doc.get_i64("eligible_voters").ok().map(|n| n.max(0) as u64),
        }))
    }

    async fn tally(&self, election_id: &str) -> Result<Option<Tally>> {
        Ok(self
            .tallies
            .find_one(doc! { "_id": election_id })
            .await?
            .map(|t| Tally {
                total_ballots: t.total_ballots.max(0) as u64,
                invalid_ballots: t.invalid_ballots.max(0) as u64,
                results: t.results,
                tallied_at: t.tallied_at.to_chrono(),
            }))
    }

    pub async fn hour_buckets(&self, election_id: &str) -> Result<Vec<HourBucket>> {
        let docs: Vec<Document> = self
            .turnout
            .find(doc! { "election_id": election_id })
            .await?
            .try_collect()
            .await?;
        Ok(docs
            .iter()
            .filter_map(|d| {
                Some(HourBucket {
                    start: time_field(d, "hour")?,
                    ballots: d.get_i64("ballots").ok()?.max(0) as u64,
                })
            })
            .collect())
    }

    /// Recalcula y guarda el informe si ya hay conteo. Devuelve el informe nuevo.
    pub async fn recompute(&self, election_id: &str) -> Result<Option<ElectionReport>> {
        let Some(tally) = self.tally(election_id).await? else {
            return Ok(None);
        };
        let meta = self
            .election_meta(election_id)
            .await?
            .unwrap_or_else(|| ElectionMeta {
                election_id: election_id.to_owned(),
                ..Default::default()
            });
        let buckets = self.hour_buckets(election_id).await?;
        let report = build_report(&meta, &tally, &buckets, Utc::now());

        let mut document = bson::to_document(&report)?;
        document.insert("_id", election_id);
        self.reports
            .replace_one(doc! { "_id": election_id }, document)
            .with_options(ReplaceOptions::builder().upsert(true).build())
            .await?;
        Ok(Some(report))
    }

    pub async fn has_tally(&self, election_id: &str) -> Result<bool> {
        Ok(self
            .tallies
            .count_documents(doc! { "_id": election_id })
            .await?
            > 0)
    }

    pub async fn report(&self, election_id: &str) -> Result<Option<ElectionReport>> {
        match self.reports.find_one(doc! { "_id": election_id }).await? {
            Some(document) => Ok(Some(bson::from_document(document)?)),
            None => Ok(None),
        }
    }

    /// Informes ordenados del más reciente al más antiguo.
    pub async fn reports(&self, skip: u64, limit: Option<i64>) -> Result<Vec<ElectionReport>> {
        let options = FindOptions::builder()
            .sort(doc! { "tallied_at": -1, "_id": 1 })
            .skip(skip)
            .limit(limit)
            .build();
        let docs: Vec<Document> = self
            .reports
            .find(doc! {})
            .with_options(options)
            .await?
            .try_collect()
            .await?;
        docs.into_iter()
            .map(|d| bson::from_document(d).map_err(Into::into))
            .collect()
    }

    pub async fn count_reports(&self) -> Result<u64> {
        self.reports.count_documents(doc! {}).await
    }
}
