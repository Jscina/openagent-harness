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

/// Model provider selection for installed agent markdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Provider {
    #[default]
    Anthropic,
    Openai,
    Mixed,
}

/// Accepted `--provider` values, in `Provider` declaration order.
pub const PROVIDER_VALUES: &[&str] = &["anthropic", "openai", "mixed"];

impl Provider {
    pub fn parse(s: &str) -> Option<Provider> {
        match s {
            "anthropic" => Some(Provider::Anthropic),
            "openai" => Some(Provider::Openai),
            "mixed" => Some(Provider::Mixed),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::Openai => "openai",
            Provider::Mixed => "mixed",
        }
    }
}

/// Per-agent model for each provider: `(agent, anthropic, openai, mixed)`.
pub const AGENT_MODELS: &[(&str, &str, &str, &str)] = &[
    (
        "orchestrator",
        "anthropic/claude-sonnet-5-5",
        "openai/gpt-6.1-sol",
        "anthropic/claude-sonnet-5-5",
    ),
    (
        "planner",
        "anthropic/claude-opus-5-5",
        "openai/gpt-6-astra",
        "anthropic/claude-opus-5-5",
    ),
    (
        "consultant",
        "anthropic/claude-opus-5-5",
        "openai/gpt-6-astra",
        "anthropic/claude-opus-5-5",
    ),
    (
        "debugger",
        "anthropic/claude-opus-5-5",
        "openai/gpt-6-astra",
        "anthropic/claude-opus-5-5",
    ),
    (
        "builder",
        "anthropic/claude-sonnet-5-5",
        "openai/gpt-6.1-sol",
        "openai/gpt-6.1-sol",
    ),
    (
        "builder-junior",
        "anthropic/claude-sonnet-5-5",
        "openai/gpt-5.4-mini",
        "openai/gpt-5.4-mini",
    ),
    (
        "reviewer",
        "anthropic/claude-sonnet-5-5",
        "openai/gpt-6.1-sol",
        "openai/gpt-6.1-sol",
    ),
    (
        "explorer",
        "anthropic/claude-haiku-5-5",
        "openai/gpt-6-luna",
        "openai/gpt-6-luna",
    ),
    (
        "researcher",
        "anthropic/claude-haiku-5-5",
        "openai/gpt-6.1-terra",
        "openai/gpt-6.1-terra",
    ),
    (
        "docs-writer",
        "anthropic/claude-haiku-5-5",
        "openai/gpt-6.1-terra",
        "openai/gpt-6.1-terra",
    ),
    (
        "vision",
        "anthropic/claude-haiku-4-5",
        "openai/gpt-6.1-terra",
        "openai/gpt-6.1-terra",
    ),
];

/// Model string for `agent` under `provider`, or `None` for an unknown agent.
pub fn model_for(agent: &str, provider: Provider) -> Option<&'static str> {
    AGENT_MODELS
        .iter()
        .find(|(name, ..)| *name == agent)
        .map(|&(_, anthropic, openai, mixed)| match provider {
            Provider::Anthropic => anthropic,
            Provider::Openai => openai,
            Provider::Mixed => mixed,
        })
}

/// Replace column-0 `model:` lines inside the frontmatter block only.
///
/// Returns `content` unchanged when there is no frontmatter or no such line.
pub fn rewrite_model_line(content: &str, new_model: &str) -> String {
    let Some(after_first) = content.strip_prefix("---\n") else {
        return content.to_string();
    };
    let Some(end) = after_first.find("\n---") else {
        return content.to_string();
    };
    let (frontmatter, tail) = after_first.split_at(end);

    let mut out = String::with_capacity(content.len() + new_model.len());
    out.push_str("---\n");
    for line in frontmatter.split_inclusive('\n') {
        if line.starts_with("model:") {
            let body_len = line.trim_end_matches(['\r', '\n']).len();
            out.push_str("model: ");
            out.push_str(new_model);
            out.push_str(&line[body_len..]);
        } else {
            out.push_str(line);
        }
    }
    out.push_str(tail);
    out
}

/// Apply `provider`'s model for agent `name` to its markdown `content`.
///
/// `Provider::Anthropic` and unknown agents return `content` unchanged.
pub fn apply_provider(name: &str, content: &str, provider: Provider) -> String {
    if provider == Provider::Anthropic {
        return content.to_string();
    }
    match model_for(name, provider) {
        Some(model) => rewrite_model_line(content, model),
        None => content.to_string(),
    }
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
    fn rewrite_model_line_replaces_frontmatter_model_only() {
        let md = "---\nmodel: a/b\ndescription: x\n---\n\nBody.\n";
        assert_eq!(
            rewrite_model_line(md, "c/d"),
            "---\nmodel: c/d\ndescription: x\n---\n\nBody.\n"
        );
    }

    #[test]
    fn rewrite_model_line_preserves_crlf_line_ending_of_model_line() {
        let md = "---\nmodel: a/b\r\ndescription: x\n---\n";
        assert_eq!(
            rewrite_model_line(md, "c/d"),
            "---\nmodel: c/d\r\ndescription: x\n---\n"
        );
    }

    #[test]
    fn rewrite_model_line_without_model_line_is_unchanged() {
        let md = "---\ndescription: x\n---\n\nBody.\n";
        assert_eq!(rewrite_model_line(md, "c/d"), md);
    }

    #[test]
    fn rewrite_model_line_without_frontmatter_is_unchanged() {
        let md = "model: a/b\n\nBody.\n";
        assert_eq!(rewrite_model_line(md, "c/d"), md);
        let unterminated = "---\nmodel: a/b\n";
        assert_eq!(rewrite_model_line(unterminated, "c/d"), unterminated);
    }

    #[test]
    fn rewrite_model_line_ignores_nested_and_body_model_lines() {
        let md =
            "---\nmodel: a/b\npermissions:\n  model: nested/x\n---\n\nmodel: body/y\nmodel: z\n";
        assert_eq!(
            rewrite_model_line(md, "c/d"),
            "---\nmodel: c/d\npermissions:\n  model: nested/x\n---\n\nmodel: body/y\nmodel: z\n"
        );
    }

    #[test]
    fn apply_provider_round_trips_through_parser() {
        for provider in [Provider::Openai, Provider::Mixed] {
            for (name, content) in AGENTS {
                let rewritten = apply_provider(name, content, provider);
                let expected = model_for(name, provider).unwrap();
                assert_eq!(
                    parse_agent_frontmatter(name, &rewritten).model,
                    expected,
                    "agent '{name}' provider {provider:?}"
                );
                let before = content.split_once("\n---").unwrap().1;
                let after = rewritten.split_once("\n---").unwrap().1;
                assert_eq!(before, after, "agent '{name}' body changed");
            }
        }
    }

    #[test]
    fn apply_provider_anthropic_is_byte_identical() {
        for (name, content) in AGENTS {
            assert_eq!(apply_provider(name, content, Provider::Anthropic), *content);
        }
    }

    #[test]
    fn apply_provider_unknown_agent_is_unchanged() {
        let md = "---\nmodel: a/b\n---\n";
        assert_eq!(apply_provider("nope", md, Provider::Openai), md);
    }

    #[test]
    fn agent_models_cover_exactly_the_embedded_agents() {
        for (name, _) in AGENTS {
            assert!(
                AGENT_MODELS.iter().any(|(n, ..)| n == name),
                "AGENT_MODELS missing '{name}'"
            );
        }
        for (name, ..) in AGENT_MODELS {
            assert!(
                AGENTS.iter().any(|(n, _)| n == name),
                "AGENT_MODELS has extra '{name}'"
            );
        }
        assert_eq!(AGENT_MODELS.len(), AGENTS.len());
    }

    #[test]
    fn agent_models_anthropic_column_matches_embedded_markdown() {
        for (name, content) in AGENTS {
            let parsed = parse_agent_frontmatter(name, content).model;
            assert_eq!(
                model_for(name, Provider::Anthropic),
                Some(parsed.as_str()),
                "agent '{name}' drifted from agents/{name}.md"
            );
        }
    }

    #[test]
    fn agent_models_mixed_is_anthropic_or_openai() {
        for (name, anthropic, openai, mixed) in AGENT_MODELS {
            assert!(
                mixed == anthropic || mixed == openai,
                "agent '{name}' mixed value '{mixed}' matches neither column"
            );
        }
    }

    #[test]
    fn agent_models_columns_use_expected_prefixes() {
        for (name, anthropic, openai, _) in AGENT_MODELS {
            assert!(anthropic.starts_with("anthropic/"), "agent '{name}'");
            assert!(openai.starts_with("openai/"), "agent '{name}'");
        }
    }

    #[test]
    fn provider_parse_accepts_only_exact_lowercase_values() {
        assert_eq!(Provider::parse("anthropic"), Some(Provider::Anthropic));
        assert_eq!(Provider::parse("openai"), Some(Provider::Openai));
        assert_eq!(Provider::parse("mixed"), Some(Provider::Mixed));
        for bad in ["", "Anthropic", "gpt", "OPENAI", " mixed", "mixed "] {
            assert_eq!(Provider::parse(bad), None, "{bad:?}");
        }
        for value in PROVIDER_VALUES {
            assert_eq!(Provider::parse(value).unwrap().as_str(), *value);
        }
        assert_eq!(Provider::default(), Provider::Anthropic);
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
