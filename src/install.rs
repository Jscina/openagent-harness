use anyhow::{Context, Result};

/// Write all embedded agent configs to `~/.config/opencode/agents/`.
pub fn run(force: bool) -> Result<()> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| anyhow::anyhow!("cannot determine config directory"))?;
    let agents_dir = config_dir.join("opencode").join("agents");

    std::fs::create_dir_all(&agents_dir)
        .with_context(|| format!("failed to create {}", agents_dir.display()))?;

    let mut installed = 0usize;
    let mut skipped = 0usize;

    for (name, content) in crate::AGENTS {
        let path = agents_dir.join(format!("{}.md", name));
        if path.exists() && !force {
            skipped += 1;
            continue;
        }
        std::fs::write(&path, content)
            .with_context(|| format!("failed to write {}", path.display()))?;
        installed += 1;
        println!("  installed {}", path.display());
    }

    println!(
        "\n{} agents installed to {}",
        installed,
        agents_dir.display()
    );
    if skipped > 0 {
        println!(
            "{} agents skipped (already exist — use --force to overwrite)",
            skipped
        );
    }

    Ok(())
}
