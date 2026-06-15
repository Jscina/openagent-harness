use anyhow::{Context, Result};

fn agents_install_dir_from_home(home_dir: &std::path::Path) -> std::path::PathBuf {
    home_dir.join(".config").join("opencode").join("agents")
}

#[cfg(test)]
fn skills_install_dir_from_home(home_dir: &std::path::Path) -> std::path::PathBuf {
    home_dir.join(".config").join("opencode").join("skills")
}

/// Write all embedded agent configs to `~/.config/opencode/agents/`.
pub fn run(force: bool) -> Result<()> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let agents_dir = agents_install_dir_from_home(&home_dir);

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

    // Install skills.
    crate::skills::install(force)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::agents_install_dir_from_home;
    use super::skills_install_dir_from_home;
    use std::path::Path;

    #[test]
    fn computes_agents_path_from_home_directory() {
        let home = Path::new("/tmp/test-home");
        let path = agents_install_dir_from_home(home);

        assert_eq!(path, home.join(".config").join("opencode").join("agents"));
    }

    #[test]
    fn computes_skills_path_from_home_directory() {
        let home = Path::new("/tmp/test-home");
        let path = skills_install_dir_from_home(home);
        assert_eq!(path, home.join(".config").join("opencode").join("skills"));
    }
}
