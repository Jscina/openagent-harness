use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

// opencode v2 discovery paths (verified against opencode.ai/v2/docs/agents and
// /v2/docs/skills): global agents live in `~/.config/opencode/agents/<name>.md`
// and global skills in `~/.config/opencode/skills/<id>/SKILL.md`.
fn agents_install_dir_from_home(home_dir: &Path) -> PathBuf {
    home_dir.join(".config").join("opencode").join("agents")
}

#[cfg(test)]
fn skills_install_dir_from_home(home_dir: &Path) -> PathBuf {
    home_dir.join(".config").join("opencode").join("skills")
}

/// Returns `true` when `content` is an opencode v1-format agent file.
///
/// v1 agents declare a top-level `permission:` map in their frontmatter; v2
/// replaced it with a `permissions:` rule list and rejects/misreads the old key.
/// Only the frontmatter block is inspected, and only column-0 keys, so a
/// `permission:` mention in the body or a nested key is not treated as stale.
pub fn is_stale_v1_agent(content: &str) -> bool {
    let Some(rest) = content.strip_prefix("---\n") else {
        return false;
    };
    let frontmatter = match rest.find("\n---") {
        Some(end) => &rest[..end],
        None => return false,
    };
    frontmatter
        .lines()
        .any(|line| line.trim_end() == "permission:" || line.starts_with("permission: "))
}

#[derive(Debug, Default, PartialEq, Eq)]
struct AgentInstallStats {
    installed: usize,
    /// Existing v1-format files overwritten even without `--force`.
    upgraded: usize,
    skipped: usize,
}

/// Write `agents` into `agents_dir`.
///
/// Existing files are kept unless `force` is set or they are stale v1-format
/// agents (see [`is_stale_v1_agent`]), which are always overwritten.
fn install_agents_into(
    agents_dir: &Path,
    agents: &[(&str, &str)],
    force: bool,
) -> Result<AgentInstallStats> {
    std::fs::create_dir_all(agents_dir)
        .with_context(|| format!("failed to create {}", agents_dir.display()))?;

    let mut stats = AgentInstallStats::default();

    for (name, content) in agents {
        let path = agents_dir.join(format!("{}.md", name));
        let mut upgrade = false;
        if path.exists() && !force {
            let stale = std::fs::read_to_string(&path)
                .map(|existing| is_stale_v1_agent(&existing))
                .unwrap_or(false);
            if !stale {
                stats.skipped += 1;
                continue;
            }
            upgrade = true;
            println!(
                "  {} uses the opencode v1 `permission:` format; overwriting with the v2 format",
                path.display()
            );
        }
        std::fs::write(&path, content)
            .with_context(|| format!("failed to write {}", path.display()))?;
        if upgrade {
            stats.upgraded += 1;
        } else {
            stats.installed += 1;
        }
        println!("  installed {}", path.display());
    }

    Ok(stats)
}

/// Write all embedded agent configs to `~/.config/opencode/agents/`.
pub fn run(force: bool) -> Result<()> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let agents_dir = agents_install_dir_from_home(&home_dir);

    let stats = install_agents_into(&agents_dir, crate::AGENTS, force)?;

    println!(
        "\n{} agents installed to {}",
        stats.installed + stats.upgraded,
        agents_dir.display()
    );
    if stats.upgraded > 0 {
        println!(
            "{} stale v1-format agents upgraded to the v2 format",
            stats.upgraded
        );
    }
    if stats.skipped > 0 {
        println!(
            "{} agents skipped (already exist — use --force to overwrite)",
            stats.skipped
        );
    }

    // Install skills.
    crate::skills::install(force)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn scratch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "openagent-harness-install-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    const V1: &str = "---\nmodel: a/b\npermission:\n  edit: deny\n  bash: deny\n---\n\nBody.\n";
    const V2: &str = "---\nmodel: a/b\npermissions:\n  - action: edit\n    resource: \"*\"\n    effect: deny\n---\n\nBody.\n";

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

    #[test]
    fn detects_v1_permission_map_as_stale() {
        assert!(is_stale_v1_agent(V1));
        assert!(is_stale_v1_agent(
            "---\nmodel: a/b\npermission: allow\n---\nBody\n"
        ));
    }

    #[test]
    fn v2_and_unrelated_content_are_not_stale() {
        assert!(!is_stale_v1_agent(V2));
        assert!(!is_stale_v1_agent("no frontmatter\npermission:\n"));
        // `permission:` in the body or nested under another key is not a v1 marker.
        assert!(!is_stale_v1_agent(
            "---\nmodel: a/b\n---\n\npermission:\n  edit: deny\n"
        ));
        assert!(!is_stale_v1_agent(
            "---\nmodel: a/b\nmeta:\n  permission:\n    x: y\n---\n"
        ));
        // `permissions:` (v2) must not match the v1 key prefix.
        assert!(!is_stale_v1_agent("---\npermissions:\n  - x\n---\n"));
    }

    #[test]
    fn embedded_agents_are_not_stale() {
        for (name, content) in crate::AGENTS {
            assert!(!is_stale_v1_agent(content), "agent '{name}' looks like v1");
        }
    }

    #[test]
    fn overwrites_stale_v1_agent_without_force_but_keeps_v2_edits() {
        let dir = scratch_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stale.md"), V1).unwrap();
        let customised = format!("{V2}\nuser edit\n");
        std::fs::write(dir.join("custom.md"), &customised).unwrap();

        let new_content = "---\nmodel: x/y\npermissions: []\n---\nNew.\n";
        let agents = [
            ("stale", new_content),
            ("custom", new_content),
            ("fresh", new_content),
        ];
        let stats = install_agents_into(&dir, &agents, false).unwrap();

        assert_eq!(
            stats,
            AgentInstallStats {
                installed: 1,
                upgraded: 1,
                skipped: 1
            }
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("stale.md")).unwrap(),
            new_content
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("custom.md")).unwrap(),
            customised
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("fresh.md")).unwrap(),
            new_content
        );

        // `--force` overwrites everything, counted as plain installs.
        let stats = install_agents_into(&dir, &agents, true).unwrap();
        assert_eq!(stats.installed, 3);
        assert_eq!(
            std::fs::read_to_string(dir.join("custom.md")).unwrap(),
            new_content
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
