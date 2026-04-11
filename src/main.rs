mod acp;
mod dag;
mod events;
mod server;
mod tmux;
mod types;

use crate::acp::AcpClient;
use crate::dag::AppState;

use anyhow::{Context, Result};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "openagent_harness=info".parse().unwrap()),
        )
        .init();

    tracing::info!("openagent-harness starting");

    let acp_port: u16 = std::env::var("OPENCODE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4096);
    let acp_password = std::env::var("OPENCODE_SERVER_PASSWORD").ok();
    let harness_port: u16 = std::env::var("HARNESS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(7837);

    let acp_base_url = format!("http://127.0.0.1:{}", acp_port);
    let acp = AcpClient::new(acp_base_url.clone(), acp_password.clone());

    let _opencode_child = if !acp.health_check().await {
        tracing::info!("OpenCode not reachable at {}, starting process...", acp_base_url);
        let mut cmd = tokio::process::Command::new("opencode");
        cmd.args(["serve", "--port", &acp_port.to_string()]);
        if let Some(ref pw) = acp_password {
            cmd.env("OPENCODE_SERVER_PASSWORD", pw);
        }
        let child = cmd.spawn().context("failed to spawn opencode process")?;

        tracing::info!("waiting for OpenCode to become ready...");
        let mut attempts = 0u32;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if acp.health_check().await {
                tracing::info!("OpenCode ready");
                break;
            }
            attempts += 1;
            if attempts >= 30 {
                anyhow::bail!("OpenCode did not become ready within 30s");
            }
        }
        Some(child)
    } else {
        tracing::info!("OpenCode already running at {}", acp_base_url);
        None
    };

    let state = Arc::new(AppState::new(acp));
    let cancel = CancellationToken::new();

    let tick_handle = tokio::spawn(dag::run_tick_loop(
        Arc::clone(&state),
        cancel.clone(),
    ));

    let app = server::router(Arc::clone(&state));
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", harness_port))
        .await
        .context("failed to bind harness listener")?;

    tracing::info!("harness listening on 0.0.0.0:{}", harness_port);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(cancel.clone()))
        .await
        .context("axum serve error")?;

    tick_handle.await?;

    tracing::info!("openagent-harness shut down");
    Ok(())
}

async fn shutdown_signal(cancel: CancellationToken) {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received");
    cancel.cancel();
}
