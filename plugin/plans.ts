// ─── Plan artifact persistence ────────────────────────────────────────────────

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

import type { PlanArtifact } from "./types.js";

export function plansDirectory(): string {
  const dir = join(process.cwd(), ".opencode", "plans");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function planArtifactPath(planId: string): string {
  return join(plansDirectory(), `${planId}.json`);
}

export function savePlanArtifact(artifact: PlanArtifact): string {
  const path = planArtifactPath(artifact.id);
  writeFileSync(path, JSON.stringify(artifact, null, 2), "utf8");
  return path;
}

export function loadPlanArtifact(planId: string): PlanArtifact {
  const path = planArtifactPath(planId);
  if (!existsSync(path)) {
    throw new Error(`plan artifact not found: ${planId}`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as PlanArtifact;
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error(`invalid plan artifact: ${planId}`);
  }
  return parsed;
}
