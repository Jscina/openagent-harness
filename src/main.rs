use openagent_harness::Provider;
use openagent_harness::agents::PROVIDER_VALUES;
use openagent_harness::install;

#[derive(Debug, PartialEq, Eq)]
struct InstallArgs {
    force: bool,
    provider: Provider,
}

fn usage() -> String {
    format!(
        "Usage: openagent-harness install [--force] [--provider {}]\n  --provider defaults to {}",
        PROVIDER_VALUES.join("|"),
        Provider::default().as_str()
    )
}

fn parse_provider(value: &str) -> Result<Provider, String> {
    Provider::parse(value).ok_or_else(|| {
        format!(
            "invalid provider '{value}' (valid: {})",
            PROVIDER_VALUES.join(", ")
        )
    })
}

/// `args` starts at the `install` subcommand token.
fn parse_install_args(args: &[String]) -> Result<InstallArgs, String> {
    let mut force = false;
    let mut provider = Provider::default();
    let mut rest = args.iter().skip(1);

    while let Some(arg) = rest.next() {
        if arg == "--force" {
            force = true;
        } else if arg == "--provider" {
            match rest.next() {
                Some(value) if !value.starts_with('-') => provider = parse_provider(value)?,
                _ => {
                    return Err(format!(
                        "--provider requires a value (valid: {})",
                        PROVIDER_VALUES.join(", ")
                    ));
                }
            }
        } else if let Some(value) = arg.strip_prefix("--provider=") {
            provider = parse_provider(value)?;
        } else {
            return Err(format!("unknown argument '{arg}'"));
        }
    }

    Ok(InstallArgs { force, provider })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    match args.first().map(String::as_str) {
        Some("install") => {
            let parsed = match parse_install_args(&args) {
                Ok(parsed) => parsed,
                Err(msg) => {
                    eprintln!("error: {msg}\n{}", usage());
                    std::process::exit(1);
                }
            };
            if let Err(e) = install::run(parsed.force, parsed.provider) {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("{}", usage());
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<InstallArgs, String> {
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        parse_install_args(&owned)
    }

    fn ok(force: bool, provider: Provider) -> Result<InstallArgs, String> {
        Ok(InstallArgs { force, provider })
    }

    #[test]
    fn defaults_to_anthropic_without_force() {
        assert_eq!(parse(&["install"]), ok(false, Provider::Anthropic));
    }

    #[test]
    fn force_flag_is_recognised() {
        assert_eq!(
            parse(&["install", "--force"]),
            ok(true, Provider::Anthropic)
        );
    }

    #[test]
    fn provider_space_and_equals_forms() {
        assert_eq!(
            parse(&["install", "--provider", "openai"]),
            ok(false, Provider::Openai)
        );
        assert_eq!(
            parse(&["install", "--provider=mixed"]),
            ok(false, Provider::Mixed)
        );
    }

    #[test]
    fn force_and_provider_in_either_order() {
        assert_eq!(
            parse(&["install", "--force", "--provider", "openai"]),
            ok(true, Provider::Openai)
        );
        assert_eq!(
            parse(&["install", "--provider", "openai", "--force"]),
            ok(true, Provider::Openai)
        );
    }

    #[test]
    fn provider_missing_value_is_error() {
        assert!(parse(&["install", "--provider"]).is_err());
        assert!(parse(&["install", "--provider", "--force"]).is_err());
        assert!(parse(&["install", "--provider="]).is_err());
    }

    #[test]
    fn invalid_provider_error_lists_valid_values() {
        let err = parse(&["install", "--provider", "bogus"]).unwrap_err();
        assert!(err.contains("bogus"), "{err}");
        for value in PROVIDER_VALUES {
            assert!(err.contains(value), "{err}");
        }
    }

    #[test]
    fn provider_is_case_sensitive() {
        assert!(parse(&["install", "--provider", "Anthropic"]).is_err());
    }

    #[test]
    fn unknown_arguments_are_errors() {
        let err = parse(&["install", "--forse"]).unwrap_err();
        assert_eq!(err, "unknown argument '--forse'");
        assert!(parse(&["install", "-provider", "openai"]).is_err());
        let err = parse(&["install", "--provider", "openai", "junk"]).unwrap_err();
        assert_eq!(err, "unknown argument 'junk'");
    }

    #[test]
    fn usage_lists_providers_and_default() {
        let text = usage();
        assert!(text.starts_with(
            "Usage: openagent-harness install [--force] [--provider anthropic|openai|mixed]\n"
        ));
        assert!(text.contains("defaults to anthropic"));
    }
}
