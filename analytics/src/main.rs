use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use analytics::consumer::Consumer;
use analytics::http::{AppState, router};
use analytics::store::Store;
use tokio::sync::watch;
use tracing_subscriber::EnvFilter;

const DEFAULT_HTTP_ADDR: &str = "0.0.0.0:8090";
const DEFAULT_MONGODB_URI: &str = "mongodb://localhost:27017";
const DEFAULT_MONGODB_DATABASE: &str = "results";
const DEFAULT_RABBITMQ_URI: &str = "amqp://guest:guest@localhost:5672/%2f";

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_owned())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    if let Err(e) = run().await {
        tracing::error!(error = %e, "analytics service stopped");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    // Cloud Run fija PORT; tiene prioridad sobre ANALYTICS_HTTP_ADDR.
    let http_addr = match std::env::var("PORT") {
        Ok(port) if !port.is_empty() => format!("0.0.0.0:{port}"),
        _ => env_or("ANALYTICS_HTTP_ADDR", DEFAULT_HTTP_ADDR),
    };
    let prefetch: u16 = env_or("ANALYTICS_PREFETCH", "16").parse()?;

    let store = Store::connect(
        &env_or("ANALYTICS_MONGODB_URI", DEFAULT_MONGODB_URI),
        &env_or("ANALYTICS_MONGODB_DATABASE", DEFAULT_MONGODB_DATABASE),
    )
    .await?;
    store.ensure_indexes().await?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let ready = Arc::new(AtomicBool::new(false));
    let consumer = Consumer {
        uri: env_or("ANALYTICS_RABBITMQ_URI", DEFAULT_RABBITMQ_URI),
        prefetch,
        store: store.clone(),
        ready: ready.clone(),
    };
    let consumer_task = tokio::spawn(consumer.run(shutdown_rx.clone()));

    tokio::spawn(async move {
        shutdown_signal().await;
        tracing::info!("shutting down");
        let _ = shutdown_tx.send(true);
    });

    let app = router(AppState {
        store,
        consumer_ready: ready,
    });
    let listener = tokio::net::TcpListener::bind(&http_addr).await?;
    tracing::info!(addr = %http_addr, "analytics http listening");
    let mut http_shutdown = shutdown_rx;
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = http_shutdown.changed().await;
        })
        .await?;
    consumer_task.await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;
}
