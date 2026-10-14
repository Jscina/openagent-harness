/**
 * agent-install.ts — first-boot agent file installation.
 *
 * Mirrors `src/install.rs` (`is_stale_v1_agent` / `install_agents_into`):
 * existing agent files are preserved unless they are stale opencode v1 files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * True when `content` is an opencode v1-format agent file: a top-level
 * `permission:` key inside the frontmatter block. Body mentions and nested
 * keys are ignored; `permissions:` (v2) never matches. Same rules as the Rust
 * `is_stale_v1_agent`.
 */
export function isStaleV1Agent(content: string): boolean {
  if (!content.startsWith("---\n")) return false;
  const rest = content.slice(4);
  const end = rest.indexOf("\n---");
  if (end === -1) return false;
  return rest
    .slice(0, end)
    .split("\n")
    .some((line) => line.trimEnd() === "permission:" || line.startsWith("permission: "));
}

/**
 * Write `configs` (name → markdown) into `agentsDir`. Missing files are
 * created; existing files are kept, except stale v1 files which are
 * overwritten with a log message. Returns the number of files written.
 */
export function installAgentsInto(
  agentsDir: string,
  configs: Record<string, string>,
  log: (message: string) => void = console.log,
): number {
  mkdirSync(agentsDir, { recursive: true });
  let written = 0;
  for (const [name, content] of Object.entries(configs)) {
    const dest = join(agentsDir, `${name}.md`);
    if (existsSync(dest)) {
      let stale = false;
      try {
        stale = isStaleV1Agent(readFileSync(dest, "utf8"));
      } catch {
        // Unreadable file: leave it alone, like the Rust installer.
      }
      if (!stale) continue;
      log(
        `[harness-plugin] ${dest} uses the opencode v1 \`permission:\` format; overwriting with the v2 format`,
      );
    }
    writeFileSync(dest, content, "utf8");
    written++;
  }
  return written;
}
