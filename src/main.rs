use openagent_harness::install;

fn main() {
    let args: Vec<String> = std::env::args().collect();

    match args.get(1).map(String::as_str) {
        Some("install") => {
            let force = args.contains(&"--force".to_string());
            if let Err(e) = install::run(force) {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("Usage: openagent-harness install [--force]");
            std::process::exit(1);
        }
    }
}
