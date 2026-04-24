use std::collections::HashMap;

use serde::Serialize;

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

/// Parsed configuration extracted from an agent's YAML frontmatter.
///
/// Used at startup to register per-agent fallback chains via `DagEngine::set_agent_fallbacks`.
#[derive(Debug, Clone, Serialize)]
pub struct AgentConfig {
    /// Agent name, matching the filename stem (e.g. `"planner"`).
    pub name: String,
    /// Primary model string in `provider/model` format.
    pub model: String,
    /// Ordered fallback model chain; empty if none are declared in frontmatter.
    pub fallback_models: Vec<String>,
}

/// Parse the `model` and `fallback_models` fields from an agent's YAML frontmatter.
///
/// Returns an `AgentConfig` with empty `model` and no `fallback_models` when the
/// content has no valid `---` frontmatter block.  The `model` field is required
/// for the agent to be dispatched; `fallback_models` is optional.
pub fn parse_agent_frontmatter(name: &str, content: &str) -> AgentConfig {
    // Find the frontmatter block between the first two `---` delimiters.
    let after_first = match content.strip_prefix("---\n") {
        Some(rest) => rest,
        None => {
            return AgentConfig {
                name: name.to_string(),
                model: String::new(),
                fallback_models: vec![],
            };
        }
    };

    let end = match after_first.find("\n---") {
        Some(pos) => pos,
        None => {
            return AgentConfig {
                name: name.to_string(),
                model: String::new(),
                fallback_models: vec![],
            };
        }
    };

    let frontmatter = &after_first[..end];

    let mut model = String::new();
    let mut fallback_models: Vec<String> = vec![];
    let mut in_fallback_models = false;

    for line in frontmatter.lines() {
        if let Some(val) = line.strip_prefix("model:") {
            model = val.trim().to_string();
            in_fallback_models = false;
        } else if line.starts_with("fallback_models:") {
            in_fallback_models = true;
        } else if in_fallback_models {
            if let Some(item) = line.strip_prefix("  - ") {
                fallback_models.push(item.trim().to_string());
            } else if !line.starts_with(' ') && !line.is_empty() {
                // A non-indented, non-empty line ends the fallback_models block.
                in_fallback_models = false;
            }
        } else {
            in_fallback_models = false;
        }
    }

    AgentConfig {
        name: name.to_string(),
        model,
        fallback_models,
    }
}

/// Returns an `AgentConfig` for every embedded agent.
pub fn all_agent_configs() -> Vec<AgentConfig> {
    AGENTS
        .iter()
        .map(|(name, content)| parse_agent_frontmatter(name, content))
        .collect()
}

/// Serializes all agent configs as a JSON object keyed by agent name.
///
/// Consumed by the WASM export `get_agent_fallback_configs`.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn agent_fallback_configs_json() -> String {
    let map: HashMap<String, AgentConfig> = all_agent_configs()
        .into_iter()
        .map(|cfg| (cfg.name.clone(), cfg))
        .collect();
    serde_json::to_string(&map).unwrap_or_else(|_| "{}".to_string())
}

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

    #[test]
    fn parse_agent_frontmatter_with_fallback_models() {
        let md = "---\nmodel: anthropic/claude-opus-4-6\nfallback_models:\n  - google/gemini-3.1-pro-preview\n  - openai/gpt-5.4\n---\n\nBody text here.\n";
        let cfg = parse_agent_frontmatter("planner", md);
        assert_eq!(cfg.name, "planner");
        assert_eq!(cfg.model, "anthropic/claude-opus-4-6");
        assert_eq!(
            cfg.fallback_models,
            vec!["google/gemini-3.1-pro-preview", "openai/gpt-5.4"]
        );
    }

    #[test]
    fn parse_agent_frontmatter_without_fallback_models() {
        let md = "---\nmodel: google/gemini-2.5-flash\ndescription: A simple agent.\n---\n\nBody text.\n";
        let cfg = parse_agent_frontmatter("explorer", md);
        assert_eq!(cfg.name, "explorer");
        assert_eq!(cfg.model, "google/gemini-2.5-flash");
        assert!(cfg.fallback_models.is_empty());
    }

    #[test]
    fn all_agent_configs_returns_11_with_nonempty_models() {
        let configs = all_agent_configs();
        assert_eq!(configs.len(), 11);
        for cfg in &configs {
            assert!(
                !cfg.model.is_empty(),
                "agent '{}' has empty model",
                cfg.name
            );
        }
    }

    #[test]
    fn all_agent_configs_have_fallback_models() {
        let configs = all_agent_configs();
        for cfg in &configs {
            assert!(
                !cfg.fallback_models.is_empty(),
                "agent '{}' has no fallback_models",
                cfg.name
            );
        }
    }

    #[test]
    fn agent_fallback_configs_json_is_valid_object() {
        let json = agent_fallback_configs_json();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(val.is_object());
        let obj = val.as_object().unwrap();
        assert_eq!(obj.len(), 11);
        // Spot-check a known agent.
        assert!(obj["planner"]["model"].is_string());
        assert!(obj["planner"]["fallback_models"].is_array());
    }
}
