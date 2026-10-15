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
    ("reviewer", include_str!("../agents/reviewer.md")),
    ("consultant", include_str!("../agents/consultant.md")),
    ("debugger", include_str!("../agents/debugger.md")),
    ("docs-writer", include_str!("../agents/docs-writer.md")),
];

/// Parsed configuration extracted from an agent's YAML frontmatter.
#[derive(Debug, Clone, Serialize)]
pub struct AgentConfig {
    /// Agent name, matching the filename stem (e.g. `"planner"`).
    pub name: String,
    /// Primary model string in `provider/model` format.
    pub model: String,
}

impl AgentConfig {
    pub fn new(name: String, model: String) -> Self {
        Self { name, model }
    }
}

/// Parse the `model` field from an agent's YAML frontmatter.
///
/// Returns an `AgentConfig` with empty `model` when the content has no valid
/// `---` frontmatter block.
#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_agent_frontmatter(name: &str, content: &str) -> AgentConfig {
    // Find the frontmatter block between the first two `---` delimiters.
    let after_first = match content.strip_prefix("---\n") {
        Some(rest) => rest,
        None => {
            return AgentConfig::new(name.to_string(), String::new());
        }
    };

    let end = match after_first.find("\n---") {
        Some(pos) => pos,
        None => {
            return AgentConfig::new(name.to_string(), String::new());
        }
    };

    let frontmatter = &after_first[..end];

    let mut model = String::new();

    // Only top-level (column 0) keys are inspected, so nested blocks such as the
    // v2 `permissions:` rule list (`- action: ... / resource: ... / effect: ...`)
    // are skipped without being misread as `model`.
    for line in frontmatter.lines() {
        if let Some(val) = line.strip_prefix("model:") {
            model = clean_scalar(val);
        }
    }

    AgentConfig::new(name.to_string(), model)
}

/// Normalise a YAML scalar: trim, drop a trailing ` # comment`, strip matching quotes.
///
/// A `#` not preceded by whitespace is part of the value, so the v2
/// `provider/model#variant` form is preserved.
fn clean_scalar(raw: &str) -> String {
    let mut val = raw.trim();
    if let Some(pos) = val.find(" #") {
        val = val[..pos].trim_end();
    }
    for quote in ['"', '\''] {
        if let Some(inner) = val
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
        {
            return inner.to_string();
        }
    }
    val.to_string()
}

/// Returns an `AgentConfig` for every embedded agent.
#[cfg_attr(not(test), allow(dead_code))]
pub fn all_agent_configs() -> Vec<AgentConfig> {
    AGENTS
        .iter()
        .map(|(name, content)| parse_agent_frontmatter(name, content))
        .collect()
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
            "reviewer",
            "consultant",
            "debugger",
            "docs-writer",
        ] {
            assert!(names.contains(&expected), "missing agent: {expected}");
        }
    }

    #[test]
    fn parse_agent_frontmatter_reads_model() {
        let md = "---\nmodel: anthropic/claude-sonnet-4-6\ndescription: A simple agent.\n---\n\nBody text.\n";
        let cfg = parse_agent_frontmatter("explorer", md);
        assert_eq!(cfg.name, "explorer");
        assert_eq!(cfg.model, "anthropic/claude-sonnet-4-6");
    }

    const V2_SAMPLE: &str = "---\nmodel: anthropic/claude-opus-5#high\ndescription: v2 agent.\nmode: subagent\npermissions:\n  - action: edit\n    resource: \"*\"\n    effect: deny\n  - action: subagent\n    resource: explorer\n    effect: allow\n  - action: skill\n    resource: caveman\n    effect: allow\n---\n\nBody.\n";

    #[test]
    fn parse_agent_frontmatter_v2_sample_ignores_permissions_and_keeps_variant() {
        let cfg = parse_agent_frontmatter("planner", V2_SAMPLE);
        assert_eq!(cfg.model, "anthropic/claude-opus-5#high");
    }

    #[test]
    fn parse_agent_frontmatter_ignores_nested_model_keys() {
        let md = "---\nmodel: a/b\npermissions:\n  - action: model\n    resource: \"*\"\n    effect: allow\n  model: ignored/x\n---\n";
        let cfg = parse_agent_frontmatter("x", md);
        assert_eq!(cfg.model, "a/b");
    }

    #[test]
    fn parse_agent_frontmatter_handles_comments_and_quotes() {
        let md = "---\nmodel: \"a/b#max\" # primary\n---\n";
        let cfg = parse_agent_frontmatter("x", md);
        assert_eq!(cfg.model, "a/b#max");
    }

    #[test]
    fn embedded_agents_have_no_fallback_models_key() {
        for (name, content) in AGENTS {
            assert!(
                !content.contains("fallback_models"),
                "agent '{name}' still declares fallback_models"
            );
        }
    }

    #[test]
    fn embedded_agents_use_v2_frontmatter() {
        for (name, content) in AGENTS {
            let end = content[4..].find("\n---").expect("frontmatter end") + 4;
            let fm = &content[..end];
            assert!(
                fm.contains("\npermissions:\n"),
                "agent '{name}' missing v2 `permissions:` list"
            );
            for stale in [
                "\npermission:",
                "\ntools:",
                "\nmcp:",
                "\nskills:",
                "\nprompt:",
            ] {
                assert!(
                    !fm.contains(stale),
                    "agent '{name}' frontmatter has v1 key {stale:?}"
                );
            }
            for stale in ["bash", "task", "write", "patch"] {
                assert!(
                    !fm.contains(&format!("action: {stale}\n")),
                    "agent '{name}' uses v1 action name '{stale}'"
                );
            }
        }
    }

    #[test]
    fn planner_agent_is_subagent_mode() {
        let planner = AGENTS
            .iter()
            .find(|(name, _)| *name == "planner")
            .map(|(_, content)| *content)
            .expect("planner agent should be embedded");
        assert!(
            planner.contains("mode: subagent"),
            "planner agent frontmatter should contain 'mode: subagent'"
        );
    }

    #[test]
    fn all_embedded_agent_model_references_use_provider_prefixes() {
        for (name, content) in AGENTS {
            let cfg = parse_agent_frontmatter(name, content);
            assert!(
                cfg.model.contains('/'),
                "agent '{name}' model should use provider/model format: '{}'",
                cfg.model
            );
        }
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
}
