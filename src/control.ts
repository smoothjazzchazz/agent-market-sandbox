import { classify } from "../analysis/classify";
import type { SealedRecord, TrialScore } from "../analysis/score";
import { score } from "../analysis/score";
import type { Hono } from "hono";
import { catalog, findTask, taskBook } from "./catalog";
import type { AppContext } from "./env";
import { evaluateOracle } from "./oracle";
import { resetWorld } from "./ready";
import { eventsForTrial } from "./telemetry";

type TrialRow = {
  id: string;
  model: SealedRecord["model"];
  prompt_text: string;
  task_id: string;
  task_version: string;
  seed_version: string;
  status: string;
  started_at: number;
  closed_at: number | null;
  oracle_pass: number | null;
  oracle_reason: string | null;
  oracle_detail_json: string | null;
  self_reported_tokens: number | null;
  frozen_through_ts: number | null;
};

const MODELS = new Set(["claude", "gpt", "human"]);

function authorized(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length);
  if (presented.length !== token.length) return false;
  let mismatch = 0;
  for (let index = 0; index < presented.length; index += 1) {
    mismatch |= presented.charCodeAt(index) ^ token.charCodeAt(index);
  }
  return mismatch === 0;
}

function sealedFrom(trial: TrialRow): SealedRecord | null {
  const task = findTask(trial.task_id);
  if (!task || trial.oracle_pass == null || trial.oracle_reason == null) return null;
  return {
    model: trial.model,
    prompt_text: trial.prompt_text,
    task_id: trial.task_id,
    task_type: task.type,
    labeled_intent: task.labeled_intent,
    expected_listing_ids: task.expected_listing_ids,
    oracle_pass: trial.oracle_pass === 1,
    oracle_reason: trial.oracle_reason,
    self_reported_tokens: trial.self_reported_tokens,
    budgets: task.budgets,
  };
}

export function registerControl(app: Hono<AppContext>): void {
  app.use("/_control/*", async (c, next) => {
    if (!authorized(c.req.header("authorization"), c.env.CONTROL_TOKEN)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.post("/_control/trials", async (c) => {
    const body = await c.req.json<{
      model?: string;
      prompt_text?: string;
      task_id?: string;
      self_reported_tokens?: number;
    }>().catch(() => null);
    if (!body) return c.json({ error: "bad_request" }, 400);
    const model = body.model ?? "";
    const prompt = typeof body.prompt_text === "string" ? body.prompt_text.trim() : "";
    const task = body.task_id ? findTask(body.task_id) : undefined;
    if (!MODELS.has(model) || !prompt || !task) return c.json({ error: "bad_request" }, 400);
    const tokens =
      typeof body.self_reported_tokens === "number" && Number.isFinite(body.self_reported_tokens)
        ? Math.max(0, Math.floor(body.self_reported_tokens))
        : null;
    await resetWorld(c.env);
    const id = crypto.randomUUID();
    const started = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO trials (
        id, model, prompt_text, task_id, task_version, seed_version, status, started_at, self_reported_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
      .bind(id, model, prompt, task.id, taskBook.task_version, catalog.seed_version, started, tokens)
      .run();
    const url = new URL(`/t/${id}`, c.req.url);
    return c.json({ trial_id: id, url: url.toString() }, 201);
  });

  app.post("/_control/trials/:id/close", async (c) => {
    const trial = await c.env.DB.prepare("SELECT * FROM trials WHERE id = ?").bind(c.req.param("id")).first<TrialRow>();
    if (!trial) return c.json({ error: "not_found" }, 404);
    if (trial.status === "closed") return c.json({ trial_id: trial.id, status: "closed" });
    const task = findTask(trial.task_id);
    if (!task) return c.json({ error: "bad_request" }, 400);
    const events = await eventsForTrial(c.env.DB, trial.id, null);
    const oracle = await evaluateOracle(c.env.DB, task, events);
    const closedAt = Date.now();
    await c.env.DB.prepare(
      `UPDATE trials
       SET status = 'closed', closed_at = ?, oracle_pass = ?, oracle_reason = ?, oracle_detail_json = ?, frozen_through_ts = ?
       WHERE id = ?`,
    )
      .bind(closedAt, oracle.pass ? 1 : 0, oracle.reason, JSON.stringify(oracle.detail), closedAt, trial.id)
      .run();
    return c.json({ trial_id: trial.id, status: "closed" });
  });

  app.get("/_control/trials/:id", async (c) => {
    const trial = await c.env.DB.prepare("SELECT * FROM trials WHERE id = ?").bind(c.req.param("id")).first<TrialRow>();
    if (!trial) return c.json({ error: "not_found" }, 404);
    const task = findTask(trial.task_id);
    const end = trial.closed_at ?? Date.now();
    const events = await eventsForTrial(c.env.DB, trial.id, trial.frozen_through_ts);
    const unassigned = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE trial_id IS NULL AND ts >= ? AND ts <= ?",
    )
      .bind(trial.started_at, end)
      .first<{ n: number }>();
    let classification = null;
    let trialScore: TrialScore | null = null;
    const sealed = sealedFrom(trial);
    if (trial.status === "closed" && sealed) {
      classification = classify(events);
      trialScore = score(classification, sealed);
    }
    return c.json({
      sealed: {
        trial_id: trial.id,
        model: trial.model,
        prompt_text: trial.prompt_text,
        task_id: trial.task_id,
        task_type: task?.type ?? null,
        labeled_intent: task?.labeled_intent ?? null,
        expected_listing_ids: task?.expected_listing_ids ?? [],
        task_version: trial.task_version,
        seed_version: trial.seed_version,
        self_reported_tokens: trial.self_reported_tokens,
        oracle_pass: trial.oracle_pass == null ? null : trial.oracle_pass === 1,
        oracle_reason: trial.oracle_reason,
        oracle_detail: trial.oracle_detail_json ? JSON.parse(trial.oracle_detail_json) : null,
        budgets: task?.budgets ?? null,
        status: trial.status,
      },
      observed: { events },
      unassigned_during_window: unassigned?.n ?? 0,
      classification,
      score: trialScore,
    });
  });
}
