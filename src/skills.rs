use anyhow::{Context, Result};

/// All skill files baked in at compile time.
///
/// Each entry is `(skill_name, filename, content)`.
///
/// Used by the native `install` subcommand (`cargo run -- install`).
pub const SKILLS: &[(&str, &str, &str)] = &[
    (
        "caveman",
        "SKILL.md",
        include_str!("../skills/caveman/SKILL.md"),
    ),
    (
        "memory",
        "SKILL.md",
        include_str!("../skills/memory/SKILL.md"),
    ),
    (
        "memory-card",
        "SKILL.md",
        include_str!("../skills/memory-card/SKILL.md"),
    ),
    (
        "memory-trace",
        "SKILL.md",
        include_str!("../skills/memory-trace/SKILL.md"),
    ),
    (
        "memory-context",
        "SKILL.md",
        include_str!("../skills/memory-context/SKILL.md"),
    ),
    (
        "memory-promote",
        "SKILL.md",
        include_str!("../skills/memory-promote/SKILL.md"),
    ),
];

/// Write all embedded skill files to `~/.config/opencode/skills/<skill_name>/`.
pub fn install(force: bool) -> Result<()> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let skills_dir = home_dir.join(".config").join("opencode").join("skills");

    std::fs::create_dir_all(&skills_dir)
        .with_context(|| format!("failed to create {}", skills_dir.display()))?;

    let mut installed = 0usize;
    let mut skipped = 0usize;

    for (skill_name, filename, content) in SKILLS {
        let skill_subdir = skills_dir.join(skill_name);
        std::fs::create_dir_all(&skill_subdir)
            .with_context(|| format!("failed to create {}", skill_subdir.display()))?;

        let path = skill_subdir.join(filename);
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
        "\n{} skills installed to {}",
        installed,
        skills_dir.display()
    );
    if skipped > 0 {
        println!(
            "{} skills skipped (already exist — use --force to overwrite)",
            skipped
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_has_expected_entries() {
        assert_eq!(SKILLS.len(), 6);
        let names: Vec<&str> = SKILLS.iter().map(|(n, _, _)| *n).collect();
        assert!(names.contains(&"caveman"), "missing skill: caveman");
        assert!(names.contains(&"memory"), "missing skill: memory");
        assert!(names.contains(&"memory-card"), "missing skill: memory-card");
        assert!(names.contains(&"memory-trace"), "missing skill: memory-trace");
        assert!(
            names.contains(&"memory-context"),
            "missing skill: memory-context"
        );
        assert!(
            names.contains(&"memory-promote"),
            "missing skill: memory-promote"
        );
    }

    #[test]
    fn all_skills_have_yaml_frontmatter() {
        for (name, _filename, content) in SKILLS {
            assert!(
                content.starts_with("---\n"),
                "skill '{name}' missing YAML frontmatter"
            );
        }
    }
}
