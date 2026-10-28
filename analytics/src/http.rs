//! API REST/JSON de analytics. Se consume a través del API Gateway, que valida
//! el JWT; este servicio no expone nada de una elección que no haya cerrado.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::report::{
    ElectionReport, ElectionSummary, LiveParticipation, OptionResult, TimelinePoint,
    daily_timeline, live_participation, summarize,
};
use crate::store::Store;

const MAX_PAGE: u64 = 100;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub consumer_ready: Arc<AtomicBool>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route(
            "/healthz",
            get(|| async { Json(json!({ "status": "ok" })) }),
        )
        .route("/readyz", get(readyz))
        .route("/v1/analytics/summary", get(global_summary))
        .route("/v1/analytics/elections", get(list_elections))
        .route(
            "/v1/analytics/elections/{election_id}",
            get(election_report),
        )
        .route(
            "/v1/analytics/elections/{election_id}/results",
            get(election_results),
        )
        .route(
            "/v1/analytics/elections/{election_id}/participation",
            get(election_participation),
        )
        .route(
            "/v1/analytics/elections/{election_id}/turnout",
            get(election_turnout),
        )
        .route(
            "/v1/analytics/elections/{election_id}/recompute",
            post(recompute),
        )
        .with_state(state)
}

pub enum ApiError {
    NotFound,
    NotClosed,
    TallyPending,
    BadRequest(&'static str),
    Internal(mongodb::error::Error),
}

impl From<mongodb::error::Error> for ApiError {
    fn from(e: mongodb::error::Error) -> Self {
        Self::Internal(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::NotFound => (StatusCode::NOT_FOUND, "election_not_found"),
            Self::NotClosed => (StatusCode::CONFLICT, "election_not_closed"),
            Self::TallyPending => (StatusCode::CONFLICT, "tally_pending"),
            Self::BadRequest(code) => (StatusCode::BAD_REQUEST, code),
            Self::Internal(e) => {
                tracing::error!(error = %e, "mongodb error");
                (StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable")
            }
        };
        (status, Json(json!({ "error": code }))).into_response()
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

async fn readyz(State(state): State<AppState>) -> Response {
    let mongo = state.store.ping().await.is_ok();
    let rabbitmq = state.consumer_ready.load(Ordering::Relaxed);
    let status = if mongo && rabbitmq {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({ "mongodb": mongo, "rabbitmq": rabbitmq })),
    )
        .into_response()
}

/// Informe de una elección o, si no existe, por qué todavía no.
async fn load_report(store: &Store, election_id: &str) -> Result<ElectionReport, ApiError> {
    if let Some(report) = store.report(election_id).await? {
        return Ok(report);
    }
    match store.election_meta(election_id).await? {
        None => Err(ApiError::NotFound),
        Some(meta)
            if meta.closed_at.is_some() || meta.closes_at.is_some_and(|c| c <= Utc::now()) =>
        {
            Err(ApiError::TallyPending)
        }
        Some(_) => Err(ApiError::NotClosed),
    }
}

async fn election_report(
    State(state): State<AppState>,
    Path(election_id): Path<String>,
) -> ApiResult<ElectionReport> {
    load_report(&state.store, &election_id).await.map(Json)
}

#[derive(Serialize)]
struct ResultsResponse {
    election_id: String,
    total_ballots: u64,
    valid_ballots: u64,
    invalid_ballots: u64,
    blank_ballots: Option<u64>,
    winner: Option<String>,
    tie: bool,
    results: Vec<OptionResult>,
}

async fn election_results(
    State(state): State<AppState>,
    Path(election_id): Path<String>,
) -> ApiResult<ResultsResponse> {
    let r = load_report(&state.store, &election_id).await?;
    Ok(Json(ResultsResponse {
        election_id: r.election_id,
        total_ballots: r.totals.total_ballots,
        valid_ballots: r.totals.valid_ballots,
        invalid_ballots: r.totals.invalid_ballots,
        blank_ballots: r.totals.blank_ballots,
        winner: r.outcome.winner,
        tie: r.outcome.tie,
        results: r.results,
    }))
}

/// Disponible también con la urna abierta: solo cuenta papeletas, sin resultados.
async fn election_participation(
    State(state): State<AppState>,
    Path(election_id): Path<String>,
) -> ApiResult<LiveParticipation> {
    let meta = state.store.election_meta(&election_id).await?;
    let buckets = state.store.hour_buckets(&election_id).await?;
    if meta.is_none() && buckets.is_empty() {
        return Err(ApiError::NotFound);
    }
    let has_tally = state.store.has_tally(&election_id).await?;
    Ok(Json(live_participation(
        &election_id,
        meta.as_ref(),
        &buckets,
        has_tally,
        Utc::now(),
    )))
}

#[derive(Deserialize)]
struct TurnoutQuery {
    bucket: Option<String>,
}

#[derive(Serialize)]
struct TurnoutResponse {
    election_id: String,
    bucket: String,
    eligible_voters: Option<u64>,
    total_ballots: u64,
    turnout: Option<f64>,
    abstention: Option<f64>,
    recorded_ballots: u64,
    matches_tally: bool,
    peak: Option<TimelinePoint>,
    by_hour_of_day_utc: Vec<u64>,
    timeline: Vec<TimelinePoint>,
}

async fn election_turnout(
    State(state): State<AppState>,
    Path(election_id): Path<String>,
    Query(query): Query<TurnoutQuery>,
) -> ApiResult<TurnoutResponse> {
    let bucket = query.bucket.unwrap_or_else(|| "hour".into());
    if bucket != "hour" && bucket != "day" {
        return Err(ApiError::BadRequest("invalid_bucket"));
    }
    let r = load_report(&state.store, &election_id).await?;
    let p = r.participation;
    let timeline = if bucket == "day" {
        daily_timeline(&p.timeline, r.totals.eligible_voters)
    } else {
        p.timeline
    };
    let peak = if bucket == "day" {
        timeline
            .iter()
            .fold(None::<&TimelinePoint>, |best, t| match best {
                Some(b) if b.ballots >= t.ballots => Some(b),
                _ => Some(t),
            })
            .cloned()
    } else {
        p.peak
    };
    Ok(Json(TurnoutResponse {
        election_id: r.election_id,
        bucket,
        eligible_voters: r.totals.eligible_voters,
        total_ballots: r.totals.total_ballots,
        turnout: r.rates.turnout,
        abstention: r.rates.abstention,
        recorded_ballots: p.recorded_ballots,
        matches_tally: p.matches_tally,
        peak,
        by_hour_of_day_utc: p.by_hour_of_day_utc,
        timeline,
    }))
}

#[derive(Deserialize)]
struct PageQuery {
    limit: Option<u64>,
    offset: Option<u64>,
}

#[derive(Serialize)]
struct ElectionList {
    total: u64,
    limit: u64,
    offset: u64,
    items: Vec<ElectionSummary>,
}

async fn list_elections(
    State(state): State<AppState>,
    Query(page): Query<PageQuery>,
) -> ApiResult<ElectionList> {
    let limit = page.limit.unwrap_or(20);
    if limit == 0 || limit > MAX_PAGE {
        return Err(ApiError::BadRequest("invalid_limit"));
    }
    let offset = page.offset.unwrap_or(0);
    let reports = state.store.reports(offset, Some(limit as i64)).await?;
    Ok(Json(ElectionList {
        total: state.store.count_reports().await?,
        limit,
        offset,
        items: reports.iter().map(ElectionSummary::from).collect(),
    }))
}

async fn global_summary(State(state): State<AppState>) -> ApiResult<crate::report::GlobalSummary> {
    let reports = state.store.reports(0, None).await?;
    Ok(Json(summarize(&reports, Utc::now())))
}

async fn recompute(
    State(state): State<AppState>,
    Path(election_id): Path<String>,
) -> ApiResult<ElectionReport> {
    match state.store.recompute(&election_id).await? {
        Some(report) => Ok(Json(report)),
        None => load_report(&state.store, &election_id).await.map(Json),
    }
}
