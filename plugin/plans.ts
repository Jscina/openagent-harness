// ─── Plan artifact persistence ────────────────────────────────────────────────

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

import type { PlanArtifact, PlanSaveInput } from "./types.js";

const INVALID_PLAN_ID_MESSAGE = 'must not contain "/", "\\" or ".."';

export function plansDirectory(): string {
  const dir = join(process.cwd(), ".opencode", "plans");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function validatePlanId(planId: string): void {
  if (planId.includes("/") || planId.includes("\\") || planId.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid plan artifact id: ${planId} (${INVALID_PLAN_ID_MESSAGE})`);
  }
}

function planNotFoundError(planId: string): Error {
  return new Error(`plan artifact not found: ${planId}`);
}

function isPlanNotFoundError(error: unknown, planId: string): boolean {
  return error instanceof Error && error.message === planNotFoundError(planId).message;
}

function generatePlanId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function planArtifactPath(planId: string): string {
  validatePlanId(planId);
  return join(plansDirectory(), `${planId}.json`);
}

export function createPlanArtifact({
  plan_id,
  summary,
  recommendations,
  tasks,
}: PlanSaveInput): PlanArtifact {
  const id = plan_id ?? generatePlanId();

  let created_at = new Date().toISOString();
  if (plan_id) {
    try {
      created_at = loadPlanArtifact(plan_id).created_at;
    } catch (error) {
      if (!isPlanNotFoundError(error, plan_id)) {
        throw error;
      }
    }
  }

  return {
    id,
    created_at,
    summary,
    recommendations,
    tasks,
  };
}

export function savePlanArtifact(artifact: PlanArtifact): string {
  const path = planArtifactPath(artifact.id);
  const persisted: PlanArtifact = {
    id: artifact.id,
    created_at: artifact.created_at,
    summary: artifact.summary,
    recommendations: artifact.recommendations,
    tasks: artifact.tasks,
  };
  writeFileSync(path, JSON.stringify(persisted, null, 2), "utf8");
  return path;
}

export function loadPlanArtifact(planId: string): PlanArtifact {
  const path = planArtifactPath(planId);
  if (!existsSync(path)) {
    throw planNotFoundError(planId);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as PlanArtifact;
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error(`invalid plan artifact: ${planId}`);
  }
  return parsed;
}
