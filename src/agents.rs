use std::collections::HashMap;

/// All agent markdown files baked in at compile time.
///
/// Used by:
/// * The WASM `get_agent_configs()` export (TypeScript installs them on boot).
/// * The native `install` subcommand (`cargo run -- install`).
pub const AGENTS: &[(&str, &str)] = &[
    ("orchestrator", include_str!("../agents/orchestrator.md")),
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

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn agent_configs_json() -> String {
    let map: HashMap<&str, &str> = AGENTS.iter().copied().collect();
    serde_json::to_string(&map).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_configs_are_valid_json_with_all_entries() {
        let json = agent_configs_json();
        let map: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(map.is_object());
        assert_eq!(map.as_object().unwrap().len(), AGENTS.len());
        assert!(map["builder"].is_string());
    }

    #[test]
    fn all_agents_embedded_with_frontmatter() {
        assert_eq!(AGENTS.len(), 11);
        for (name, content) in AGENTS {
            assert!(
                content.starts_with("---\n"),
                "agent '{name}' missing YAML frontmatter"
            );
        }
        let names: Vec<&str> = AGENTS.iter().map(|(n, _)| *n).collect();
        for expected in [
            "orchestrator",
            "planner",
            "explorer",
            "researcher",
            "vision",
            "builder",
            "builder-junior",
            "consultant",
            "reviewer",
            "debugger",
            "docs-writer",
        ] {
            assert!(names.contains(&expected), "missing agent: {expected}");
        }
    }
}
