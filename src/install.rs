use anyhow::{Context, Result};

const AGENTS: &[(&str, &str)] = &[
    ("planner", include_str!("../agents/planner.md")),
    ("explorer", include_str!("../agents/explorer.md")),
    ("researcher", include_str!("../agents/researcher.md")),
    ("vision", include_str!("../agents/vision.md")),
    ("builder", include_str!("../agents/builder.md")),
    (
        "builder-junior",
        include_str!("../agents/builder-junior.md"),
    ),
    ("consultant", include_str!("../agents/consultant.md")),
    ("reviewer", include_str!("../agents/reviewer.md")),
    ("debugger", include_str!("../agents/debugger.md")),
    ("docs-writer", include_str!("../agents/docs-writer.md")),
];

pub fn run(force: bool) -> Result<()> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| anyhow::anyhow!("cannot determine config directory"))?;
    let agents_dir = config_dir.join("opencode").join("agent");

    std::fs::create_dir_all(&agents_dir)
        .with_context(|| format!("failed to create {}", agents_dir.display()))?;

    let mut installed = 0usize;
    let mut skipped = 0usize;

    for (name, content) in AGENTS {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_agent_files_are_embedded() {
        assert_eq!(AGENTS.len(), 10);
        let names: Vec<&str> = AGENTS.iter().map(|(n, _)| *n).collect();
        assert!(names.contains(&"planner"));
        assert!(names.contains(&"explorer"));
        assert!(names.contains(&"researcher"));
        assert!(names.contains(&"vision"));
        assert!(names.contains(&"builder"));
        assert!(names.contains(&"builder-junior"));
        assert!(names.contains(&"consultant"));
        assert!(names.contains(&"reviewer"));
        assert!(names.contains(&"debugger"));
        assert!(names.contains(&"docs-writer"));
    }

    #[test]
    fn all_agent_contents_are_non_empty() {
        for (name, content) in AGENTS {
            assert!(!content.is_empty(), "agent '{}' has empty content", name);
            assert!(
                content.starts_with("---\n"),
                "agent '{}' missing YAML frontmatter",
                name
            );
        }
    }
}
