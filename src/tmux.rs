use anyhow::{Context, Result};
use std::process::Command;

pub fn spawn_pane(session_id: &str) -> Result<()> {
    let attach_cmd = format!("opencode attach {}", session_id);
    let output = Command::new("tmux")
        .args(["split-window", "-h", &attach_cmd])
        .output()
        .context("tmux: failed to run split-window")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("tmux split-window failed: {}", stderr);
    }

    tracing::info!(session_id, "spawned tmux pane");
    Ok(())
}
