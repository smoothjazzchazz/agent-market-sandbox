import type { Classification, Intent } from "./classify";

/** Held until scoring. The classifier does not import this type. */
export type SealedRecord = {
  model: "claude" | "gpt" | "human";
  prompt_text: string;
  task_id: string;
  task_type: "data_access" | "action";
  labeled_intent: Intent;
  expected_listing_ids: string[];
  oracle_pass: boolean;
  oracle_reason: string;
  self_reported_tokens: number | null;
  budgets: {
    steps: number;
    latency_ms: number;
    cpu_ms: number;
  };
};

export type TrialScore = {
  actor_agreement: boolean;
  expected_actor: "agent" | "human";
  predicted_actor: Classification["actor"];
  intent_agreement: boolean;
  predicted_intent: Intent;
  labeled_intent: Intent;
  oracle_pass: boolean;
  oracle_reason: string;
  outcome: "pass" | "fail";
  cost_flags: Array<"excess_steps" | "excess_latency" | "excess_cpu">;
};

export function score(prediction: Classification, sealed: SealedRecord): TrialScore {
  const expectedActor = sealed.model === "human" ? "human" : "agent";
  const costFlags: TrialScore["cost_flags"] = [];
  if (prediction.pattern.cost.steps > sealed.budgets.steps) costFlags.push("excess_steps");
  if (prediction.pattern.cost.sequence_ms > sealed.budgets.latency_ms) costFlags.push("excess_latency");
  if (prediction.pattern.cost.cpu_ms != null && prediction.pattern.cost.cpu_ms > sealed.budgets.cpu_ms) {
    costFlags.push("excess_cpu");
  }

  return {
    actor_agreement: prediction.actor === expectedActor,
    expected_actor: expectedActor,
    predicted_actor: prediction.actor,
    intent_agreement: prediction.primary_intent === sealed.labeled_intent,
    predicted_intent: prediction.primary_intent,
    labeled_intent: sealed.labeled_intent,
    oracle_pass: sealed.oracle_pass,
    oracle_reason: sealed.oracle_reason,
    outcome: sealed.oracle_pass ? "pass" : "fail",
    cost_flags: costFlags,
  };
}
