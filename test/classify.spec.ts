import { classify } from "../analysis/classify";
import type { ObservedEvent } from "../analysis/observed";
import { score } from "../analysis/score";
import { describe, expect, it } from "vitest";

function event(overrides: Partial<ObservedEvent> & Pick<ObservedEvent, "id" | "path" | "surface" | "action">): ObservedEvent {
  return {
    session_id: "s",
    seq: 1,
    ts: 1_000,
    query: null,
    filters: null,
    result_ids: [],
    status: 200,
    user_agent: "Mozilla/5.0",
    colo: "EWR",
    ray_id: null,
    handler_ms: 10,
    gap_ms: null,
    robots_or_sitemap: false,
    method: "GET",
    result_count: null,
    empty: null,
    listing_id: null,
    category_id: null,
    seller_id: null,
    order_id: null,
    served_price_cents: null,
    served_title: null,
    ...overrides,
  };
}

describe("classifier", () => {
  it("labels a browser session with assets as human and keeps the prompt out of the prediction", () => {
    const prediction = classify([
      event({ id: "1", path: "/", surface: "page", action: "page_view", seq: 1, ts: 1_000 }),
      event({ id: "2", path: "/assets/styles.css", surface: "asset", action: "page_view", seq: 2, ts: 2_000, gap_ms: 1_000 }),
      event({ id: "3", path: "/search", surface: "page", action: "search", query: "kettle", seq: 3, ts: 4_000, gap_ms: 2_000, result_ids: ["kit_01"] }),
      event({
        id: "4",
        path: "/listing/kit_01",
        surface: "page",
        action: "listing_open",
        seq: 4,
        ts: 6_000,
        gap_ms: 2_000,
        listing_id: "kit_01",
        served_title: "Harbor Whistle Kettle",
        served_price_cents: 2400,
      }),
    ]);
    expect(prediction.actor).toBe("human");
    expect(prediction.primary_intent).toBe("inspect");
    expect(prediction.intent_path).toEqual(["discover", "retrieve", "inspect"]);
    expect(JSON.stringify(prediction)).not.toContain("prompt_text");
    expect(prediction.pattern.citations[0]?.delivered).toBe(true);
    expect(prediction.pattern.cost.cpu_ms).toBeNull();
  });

  it("labels API-only bursts as agent and a crawler user agent as crawler", () => {
    const agent = classify([
      event({ id: "1", path: "/api/listings", surface: "api", action: "search", seq: 1, ts: 1_000, result_count: 1, empty: false }),
      event({ id: "2", path: "/api/listings/kit_01", surface: "api", action: "listing_open", seq: 2, ts: 1_100, gap_ms: 100, listing_id: "kit_01", served_title: "Harbor Whistle Kettle", served_price_cents: 2400 }),
    ]);
    expect(agent.actor).toBe("agent");
    expect(agent.primary_intent).toBe("inspect");

    const crawler = classify([
      event({
        id: "1",
        path: "/robots.txt",
        surface: "page",
        action: "page_view",
        robots_or_sitemap: true,
        user_agent: "Mozilla/5.0 (compatible; Googlebot/2.1)",
      }),
    ]);
    expect(crawler.actor).toBe("crawler");
    expect(crawler.primary_intent).toBe("enumerate");
  });

  it("leaves a thin session unknown", () => {
    const prediction = classify([
      event({ id: "1", path: "/", surface: "page", action: "page_view", gap_ms: 500 }),
    ]);
    expect(prediction.actor).toBe("unknown");
  });

  it("scores a sealed record without feeding it back into classification", () => {
    const events = [
      event({ id: "1", path: "/cart", surface: "page", action: "cart_add", listing_id: "cam_01", seq: 1, ts: 1_000 }),
      event({ id: "2", path: "/checkout", surface: "page", action: "checkout_complete", seq: 2, ts: 1_200, gap_ms: 200, order_id: "ord" }),
    ];
    const prediction = classify(events);
    const result = score(prediction, {
      model: "gpt",
      prompt_text: "SEALED_PROMPT_do_not_render_9f3a",
      task_id: "checkout_cedar_lantern",
      task_type: "action",
      labeled_intent: "transact",
      expected_listing_ids: ["cam_01"],
      oracle_pass: false,
      oracle_reason: "checkout_abandon",
      self_reported_tokens: 40,
      budgets: { steps: 1, latency_ms: 10, cpu_ms: 1 },
    });
    expect(prediction.primary_intent).toBe("transact");
    expect(result.intent_agreement).toBe(true);
    expect(result.expected_actor).toBe("agent");
    expect(result.outcome).toBe("fail");
    expect(result.oracle_reason).toBe("checkout_abandon");
    expect(result.cost_flags).toContain("excess_steps");
    expect(result.cost_flags).toContain("excess_latency");
    expect(result.cost_flags).not.toContain("excess_cpu");
  });
});
