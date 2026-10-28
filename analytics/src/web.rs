//! Panel web de analytics: páginas y recursos embebidos en el binario, login
//! con email y contraseña, y la API de datos protegida por sesión.
//!
//! Protección CSRF: la cookie es `SameSite=Strict` y toda petición que no sea
//! GET a `/dashboard/api` debe traer la cabecera `X-Requested-With`, que un
//! formulario de otro sitio no puede enviar sin una preflight CORS.

use std::sync::OnceLock;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::auth::{DashboardUser, LoginError, token_from_cookies};
use crate::http::{ApiError, AppState, data_routes};
use crate::report::{LiveParticipation, live_participation};

pub const CSRF_HEADER: &str = "x-requested-with";

const CSP: &str = "default-src 'self'; script-src 'self'; \
    style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; \
    font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; \
    frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

struct Asset {
    path: &'static str,
    content_type: &'static str,
    body: &'static [u8],
}

const ASSETS: &[Asset] = &[
    Asset {
        path: "app.css",
        content_type: "text/css; charset=utf-8",
        body: include_bytes!("../web/app.css"),
    },
    Asset {
        path: "app.js",
        content_type: "text/javascript; charset=utf-8",
        body: include_bytes!("../web/app.js"),
    },
    Asset {
        path: "charts.js",
        content_type: "text/javascript; charset=utf-8",
        body: include_bytes!("../web/charts.js"),
    },
    Asset {
        path: "login.js",
        content_type: "text/javascript; charset=utf-8",
        body: include_bytes!("../web/login.js"),
    },
    Asset {
        path: "logo.png",
        content_type: "image/png",
        body: include_bytes!("../web/logo.png"),
    },
];

const INDEX_HTML: &str = include_str!("../web/index.html");
const LOGIN_HTML: &str = include_str!("../web/login.html");

/// Las páginas enlazan los recursos con `?v=<hash del contenido>`, así un
/// despliegue nuevo nunca reutiliza un CSS o JS viejo de la caché del navegador.
fn versioned(page: &'static str, cell: &'static OnceLock<String>) -> &'static str {
    cell.get_or_init(|| {
        let mut hasher = Sha256::new();
        for asset in ASSETS {
            hasher.update(asset.body);
        }
        let version = hex::encode(hasher.finalize());
        page.replace("{{v}}", &version[..12])
    })
}

fn index_html() -> &'static str {
    static CELL: OnceLock<String> = OnceLock::new();
    versioned(INDEX_HTML, &CELL)
}

fn login_html() -> &'static str {
    static CELL: OnceLock<String> = OnceLock::new();
    versioned(LOGIN_HTML, &CELL)
}

pub fn routes(state: AppState) -> Router<AppState> {
    let protected = data_routes()
        .route("/me", get(me))
        .route("/logout", post(logout))
        .route("/live", get(live))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ));

    Router::new()
        .route("/", get(|| async { Redirect::to("/dashboard") }))
        .route("/dashboard", get(dashboard_page))
        .route("/dashboard/", get(|| async { Redirect::to("/dashboard") }))
        .route("/dashboard/login", get(login_page))
        .route("/dashboard/assets/{file}", get(asset))
        .route("/dashboard/api/login", post(login))
        .nest("/dashboard/api", protected)
        .layer(middleware::from_fn(security_headers))
}

async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    response
}

async fn current_user(state: &AppState, headers: &HeaderMap) -> Option<DashboardUser> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    let token = token_from_cookies(cookies)?;
    state.auth.session_user(token).await.ok().flatten()
}

fn html(body: &'static str) -> Response {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

async fn dashboard_page(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match current_user(&state, &headers).await {
        Some(_) => html(index_html()),
        None => Redirect::to("/dashboard/login").into_response(),
    }
}

async fn login_page(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match current_user(&state, &headers).await {
        Some(_) => Redirect::to("/dashboard").into_response(),
        None => html(login_html()),
    }
}

async fn asset(axum::extract::Path(file): axum::extract::Path<String>) -> Response {
    match ASSETS.iter().find(|a| a.path == file) {
        Some(a) => (
            [
                (header::CONTENT_TYPE, a.content_type),
                (header::CACHE_CONTROL, "public, max-age=300"),
            ],
            a.body,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

async fn require_session(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    if request.method() != Method::GET && !request.headers().contains_key(CSRF_HEADER) {
        return error(StatusCode::FORBIDDEN, "csrf_header_missing");
    }
    match current_user(&state, request.headers()).await {
        Some(user) => {
            request.extensions_mut().insert(user);
            next.run(request).await
        }
        None => error(StatusCode::UNAUTHORIZED, "unauthenticated"),
    }
}

#[derive(Deserialize)]
struct LoginBody {
    email: String,
    password: String,
}

async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<LoginBody>>,
) -> Response {
    if !headers.contains_key(CSRF_HEADER) {
        return error(StatusCode::FORBIDDEN, "csrf_header_missing");
    }
    let Some(Json(body)) = body else {
        return error(StatusCode::BAD_REQUEST, "invalid_body");
    };
    match state.auth.login(&body.email, &body.password).await {
        Ok((token, user)) => {
            tracing::info!(email = %user.email, "dashboard login");
            (
                [(header::SET_COOKIE, state.auth.session_cookie(&token))],
                Json(json!({ "user": user })),
            )
                .into_response()
        }
        Err(LoginError::InvalidCredentials) => {
            error(StatusCode::UNAUTHORIZED, "invalid_credentials")
        }
        Err(LoginError::Locked) => error(StatusCode::TOO_MANY_REQUESTS, "too_many_attempts"),
        Err(LoginError::Storage) => error(StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"),
    }
}

async fn me(Extension(user): Extension<DashboardUser>) -> Json<serde_json::Value> {
    Json(json!({ "user": user }))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = headers
        .get(header::COOKIE)
        .and_then(|c| c.to_str().ok())
        .and_then(token_from_cookies)
        && let Err(e) = state.auth.logout(token).await
    {
        tracing::warn!(error = %e, "could not delete session");
    }
    (
        [(header::SET_COOKIE, state.auth.clear_cookie())],
        StatusCode::NO_CONTENT,
    )
        .into_response()
}

/// Participación en tiempo real de las elecciones que aún no tienen conteo final.
async fn live(State(state): State<AppState>) -> Result<Json<Vec<LiveParticipation>>, ApiError> {
    let now = Utc::now();
    let mut items = Vec::new();
    for id in state.store.pending_election_ids().await? {
        let meta = state.store.election_meta(&id).await?;
        let buckets = state.store.hour_buckets(&id).await?;
        items.push(live_participation(&id, meta.as_ref(), &buckets, false, now));
    }
    items.sort_by(|a, b| a.closes_at.cmp(&b.closes_at));
    Ok(Json(items))
}
