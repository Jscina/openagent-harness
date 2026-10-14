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

impl AgentConfig {
    pub fn new(name: String, model: String, fallback_models: Vec<String>) -> Self {
        Self {
            name,
            model,
            fallback_models,
        }
    }
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
            return AgentConfig::new(name.to_string(), String::new(), vec![]);
        }
    };

    let end = match after_first.find("\n---") {
        Some(pos) => pos,
        None => {
            return AgentConfig::new(name.to_string(), String::new(), vec![]);
        }
    };

    let frontmatter = &after_first[..end];

    let mut model = String::new();
    let mut fallback_models: Vec<String> = vec![];
    let mut in_fallback_models = false;

    // Only top-level (column 0) keys are inspected, so nested blocks such as the
    // v2 `permissions:` rule list (`- action: ... / resource: ... / effect: ...`)
    // are skipped without being misread as `model` or fallback entries.
    for line in frontmatter.lines() {
        if let Some(val) = line.strip_prefix("model:") {
            model = clean_scalar(val);
            in_fallback_models = false;
        } else if let Some(val) = line.strip_prefix("fallback_models:") {
            let val = val.trim();
            if let Some(inline) = val.strip_prefix('[') {
                // Flow style: `fallback_models: [a/b, c/d]`.
                let inline = inline.split(']').next().unwrap_or("");
                fallback_models.extend(
                    inline
                        .split(',')
                        .map(clean_scalar)
                        .filter(|item| !item.is_empty()),
                );
                in_fallback_models = false;
            } else {
                in_fallback_models = true;
            }
        } else if in_fallback_models {
            if let Some(item) = line.trim_start().strip_prefix("- ") {
                let item = clean_scalar(item);
                if !item.is_empty() {
                    fallback_models.push(item);
                }
            } else if !line.starts_with(' ') && !line.is_empty() {
                // A non-indented, non-empty line ends the fallback_models block.
                in_fallback_models = false;
            }
        }
    }

    AgentConfig::new(name.to_string(), model, fallback_models)
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
pub fn all_agent_configs() -> Vec<AgentConfig> {
    AGENTS
        .iter()
        .map(|(name, content)| parse_agent_frontmatter(name, content))
        .collect()
}

/// Serializes all agent configs as a JSON object keyed by agent name.
///
/// Consumed by the WASM export `agent_fallback_configs_json`.
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
            "reviewer",
            "consultant",
            "debugger",
            "docs-writer",
        ] {
            assert!(names.contains(&expected), "missing agent: {expected}");
        }
    }

    #[test]
    fn parse_agent_frontmatter_with_fallback_models() {
        let md = "---\nmodel: anthropic/claude-opus-4-6\nfallback_models:\n  - openai/gpt-5.4\n  - ollama/qwen3-coder:30b\n---\n\nBody text here.\n";
        let cfg = parse_agent_frontmatter("planner", md);
        assert_eq!(cfg.name, "planner");
        assert_eq!(cfg.model, "anthropic/claude-opus-4-6");
        assert_eq!(
            cfg.fallback_models,
            vec!["openai/gpt-5.4", "ollama/qwen3-coder:30b"]
        );
    }

    #[test]
    fn parse_agent_frontmatter_without_fallback_models() {
        let md = "---\nmodel: anthropic/claude-sonnet-4-6\ndescription: A simple agent.\n---\n\nBody text.\n";
        let cfg = parse_agent_frontmatter("explorer", md);
        assert_eq!(cfg.name, "explorer");
        assert_eq!(cfg.model, "anthropic/claude-sonnet-4-6");
        assert!(cfg.fallback_models.is_empty());
    }

    const V2_SAMPLE: &str = "---\nmodel: anthropic/claude-opus-5#high\nfallback_models:\n  - openai/gpt-5.4#low\n  - ollama/qwen3-coder:30b\ndescription: v2 agent.\nmode: subagent\npermissions:\n  - action: edit\n    resource: \"*\"\n    effect: deny\n  - action: subagent\n    resource: explorer\n    effect: allow\n  - action: skill\n    resource: caveman\n    effect: allow\n---\n\nBody.\n";

    #[test]
    fn parse_agent_frontmatter_v2_sample_ignores_permissions_and_keeps_variant() {
        let cfg = parse_agent_frontmatter("planner", V2_SAMPLE);
        assert_eq!(cfg.model, "anthropic/claude-opus-5#high");
        assert_eq!(
            cfg.fallback_models,
            vec!["openai/gpt-5.4#low", "ollama/qwen3-coder:30b"]
        );
    }

    #[test]
    fn parse_agent_frontmatter_permissions_directly_after_fallbacks() {
        // No key between the fallback list and `permissions:`; its rules must not
        // be treated as fallback entries.
        let md = "---\nmodel: a/b\nfallback_models:\n  - c/d\npermissions:\n  - action: edit\n    resource: \"*\"\n    effect: deny\n---\n";
        let cfg = parse_agent_frontmatter("x", md);
        assert_eq!(cfg.model, "a/b");
        assert_eq!(cfg.fallback_models, vec!["c/d"]);
    }

    #[test]
    fn parse_agent_frontmatter_ignores_nested_model_keys() {
        let md = "---\nmodel: a/b\npermissions:\n  - action: model\n    resource: \"*\"\n    effect: allow\n  model: ignored/x\n---\n";
        let cfg = parse_agent_frontmatter("x", md);
        assert_eq!(cfg.model, "a/b");
    }

    #[test]
    fn parse_agent_frontmatter_handles_comments_quotes_and_flow_lists() {
        let md =
            "---\nmodel: \"a/b#max\" # primary\nfallback_models: [c/d, 'e/f#low'] # chain\n---\n";
        let cfg = parse_agent_frontmatter("x", md);
        assert_eq!(cfg.model, "a/b#max");
        assert_eq!(cfg.fallback_models, vec!["c/d", "e/f#low"]);
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
            for fallback in &cfg.fallback_models {
                assert!(
                    fallback.contains('/'),
                    "agent '{name}' fallback should use provider/model format: '{fallback}'"
                );
            }
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
