import { classify } from "../analysis/classify";
import type { ObservedEvent } from "../analysis/observed";
import { score } from "../analysis/score";
import { describe, expect, it } from "vitest";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

function expectRealIntentIds(prediction: ReturnType<typeof classify>, events: ObservedEvent[]): void {
  const ids = new Set(events.map((item) => item.id));
  for (const list of Object.values(prediction.intent_event_ids)) {
    expect(list && list.length > 0).toBe(true);
    for (const id of list ?? []) expect(ids.has(id)).toBe(true);
  }
}

describe("classifier", () => {
  it("labels a browser session with assets as human and keeps the prompt out of the prediction", () => {
    const events = [
      event({ id: "1", path: "/", surface: "page", action: "page_view", seq: 1, ts: 1_000 }),
      event({ id: "2", path: "/assets/styles.css", surface: "asset", action: "page_view", seq: 2, ts: 2_000, gap_ms: 1_000 }),
      event({ id: "3", path: "/search", surface: "page", action: "search", query: "kettle", seq: 3, ts: 4_000, gap_ms: 2_000, result_ids: ["kit_01"], result_count: 1, empty: false }),
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
    ];
    const prediction = classify(events);
    expect(prediction.actor).toBe("human");
    expect(prediction.primary_intent).toBe("inspect");
    expect(prediction.intent_path).toEqual(["discover", "retrieve", "inspect"]);
    expect(JSON.stringify(prediction)).not.toContain("prompt_text");
    expect(prediction.pattern.citations[0]?.delivered).toBe(true);
    expect(prediction.pattern.cost.cpu_ms).toBeNull();
    expectRealIntentIds(prediction, events);
  });

  it("labels a careful Chrome browse with a stylesheet and slow gaps as human", () => {
    const events = [
      event({ id: "home", path: "/", surface: "page", action: "page_view", seq: 1, ts: 1_000, user_agent: CHROME }),
      event({
        id: "css",
        path: "/assets/styles.css",
        surface: "asset",
        action: "page_view",
        seq: 2,
        ts: 2_200,
        gap_ms: 1_200,
        user_agent: CHROME,
      }),
      event({
        id: "category",
        path: "/c/camp",
        surface: "page",
        action: "page_view",
        seq: 3,
        ts: 4_000,
        gap_ms: 1_800,
        user_agent: CHROME,
        category_id: "camp",
      }),
      event({
        id: "listing",
        path: "/listing/cam_01",
        surface: "page",
        action: "listing_open",
        seq: 4,
        ts: 6_500,
        gap_ms: 2_500,
        user_agent: CHROME,
        listing_id: "cam_01",
        served_title: "Cedar Camp Lantern",
        served_price_cents: 4200,
      }),
    ];
    const prediction = classify(events);
    expect(prediction.actor).toBe("human");
    expect(prediction.primary_intent).toBe("inspect");
    expect(prediction.signals.assets_fetched).toBe(true);
    expect(prediction.signals.script_client).toBe(false);
    expect(prediction.signals.median_gap_ms).toBeGreaterThanOrEqual(800);
    expect(prediction.signals.api_share).toBeLessThan(0.15);
    expectRealIntentIds(prediction, events);
  });

  it("labels API-only bursts as agent and a crawler user agent as crawler", () => {
    const agentEvents = [
      event({ id: "1", path: "/api/listings", surface: "api", action: "search", seq: 1, ts: 1_000, result_count: 1, empty: false }),
      event({ id: "2", path: "/api/listings/kit_01", surface: "api", action: "listing_open", seq: 2, ts: 1_100, gap_ms: 100, listing_id: "kit_01", served_title: "Harbor Whistle Kettle", served_price_cents: 2400 }),
    ];
    const agent = classify(agentEvents);
    expect(agent.actor).toBe("agent");
    expect(agent.primary_intent).toBe("inspect");
    expectRealIntentIds(agent, agentEvents);

    const crawlerEvents = [
      event({
        id: "1",
        path: "/robots.txt",
        surface: "page",
        action: "page_view",
        robots_or_sitemap: true,
        user_agent: "Mozilla/5.0 (compatible; Googlebot/2.1)",
      }),
    ];
    const crawler = classify(crawlerEvents);
    expect(crawler.actor).toBe("crawler");
    expect(crawler.primary_intent).toBe("enumerate");
    expect(crawler.signals.crawler_ua).toBe(true);
    expectRealIntentIds(crawler, crawlerEvents);
  });

  it("keeps robots coverage as crawler when a browser loads CSS and does not check out", () => {
    const events = [
      event({ id: "robots", path: "/robots.txt", surface: "page", action: "page_view", robots_or_sitemap: true, seq: 1, ts: 1_000, user_agent: CHROME }),
      event({ id: "css", path: "/assets/styles.css", surface: "asset", action: "page_view", seq: 2, ts: 2_000, gap_ms: 1_000, user_agent: CHROME }),
    ];
    for (let index = 0; index < 7; index += 1) {
      events.push(
        event({
          id: `page-${index}`,
          path: `/p/${index}`,
          surface: "page",
          action: "page_view",
          seq: index + 3,
          ts: 3_000 + index * 1_000,
          gap_ms: 1_000,
          user_agent: CHROME,
        }),
      );
    }
    const prediction = classify(events);
    expect(prediction.actor).toBe("crawler");
    expect(prediction.signals.crawler_ua).toBe(false);
    expect(prediction.signals.assets_fetched).toBe(true);
    expect(prediction.primary_intent).toBe("enumerate");
    expect(prediction.intent_path).toContain("discover");
    expectRealIntentIds(prediction, events);
  });

  it("does not treat a curl user agent and missing assets as enough to clear the floor", () => {
    const prediction = classify([
      event({ id: "1", path: "/", surface: "page", action: "page_view", seq: 1, ts: 1_000, user_agent: "curl/8.21.0" }),
      event({ id: "2", path: "/account", surface: "page", action: "page_view", seq: 2, ts: 8_000, gap_ms: 7_000, user_agent: "curl/8.21.0" }),
      event({ id: "3", path: "/login", surface: "page", action: "login", seq: 3, ts: 15_000, gap_ms: 7_000, user_agent: "curl/8.21.0" }),
      event({
        id: "4",
        path: "/listing/cam_01",
        surface: "page",
        action: "listing_open",
        seq: 4,
        ts: 22_000,
        gap_ms: 7_000,
        user_agent: "curl/8.21.0",
        listing_id: "cam_01",
        served_title: "Cedar Camp Lantern",
        served_price_cents: 4200,
      }),
    ]);
    expect(prediction.actor).toBe("unknown");
    expect(prediction.signals.script_client).toBe(true);
    expect(prediction.signals.assets_fetched).toBe(false);
    expect(prediction.signals.agent_score).toBeLessThan(0.45);
    expect(prediction.signals.human_score).toBeLessThan(0.45);
    expect(prediction.signals).not.toHaveProperty("login_after_form");
  });

  it("leaves a single curl fetch of the home page unknown", () => {
    const prediction = classify([
      event({ id: "1", path: "/", surface: "page", action: "page_view", user_agent: "curl/8.21.0" }),
    ]);
    expect(prediction.actor).toBe("unknown");
    expect(prediction.signals.script_client).toBe(true);
    expect(prediction.signals.assets_fetched).toBe(false);
    expect(prediction.signals.agent_score).toBeLessThan(0.45);
  });

  it("leaves a thin session unknown", () => {
    const prediction = classify([
      event({ id: "1", path: "/", surface: "page", action: "page_view", gap_ms: 500 }),
    ]);
    expect(prediction.actor).toBe("unknown");
  });

  it("labels a Chrome checkout validation loop as agent and keeps transact as the goal", () => {
    const events = [
      event({ id: "home", path: "/", surface: "page", action: "page_view", seq: 1, ts: 1_000, user_agent: CHROME }),
      event({ id: "css", path: "/assets/styles.css", surface: "asset", action: "page_view", seq: 2, ts: 2_500, gap_ms: 1_500, user_agent: CHROME }),
      event({
        id: "cart",
        path: "/cart/add",
        surface: "page",
        action: "cart_add",
        method: "POST",
        seq: 3,
        ts: 4_000,
        gap_ms: 1_500,
        user_agent: CHROME,
        listing_id: "cam_01",
        status: 302,
      }),
      event({
        id: "step-1",
        path: "/checkout",
        surface: "page",
        action: "checkout_step",
        method: "POST",
        seq: 4,
        ts: 5_500,
        gap_ms: 1_500,
        user_agent: CHROME,
        status: 200,
      }),
      event({
        id: "step-2",
        path: "/checkout",
        surface: "page",
        action: "checkout_step",
        method: "POST",
        seq: 5,
        ts: 7_000,
        gap_ms: 1_500,
        user_agent: CHROME,
        status: 200,
      }),
      event({
        id: "back-home",
        path: "/account",
        surface: "page",
        action: "page_view",
        seq: 6,
        ts: 8_500,
        gap_ms: 1_500,
        user_agent: CHROME,
      }),
    ];
    const prediction = classify(events);
    expect(prediction.actor).toBe("agent");
    expect(prediction.signals.validation_loop).toBe(true);
    expect(prediction.signals.assets_fetched).toBe(true);
    expect(prediction.primary_intent).toBe("transact");
    expect(prediction.intent_path).toEqual(["discover", "transact", "discover"]);
    expect(prediction.intent_event_ids.transact).toEqual(["cart", "step-1", "step-2"]);
    expectRealIntentIds(prediction, events);
  });

  it("labels repeated Chrome errors as agent without letting them replace an earlier inspect goal", () => {
    const events = [
      event({ id: "home", path: "/", surface: "page", action: "page_view", seq: 1, ts: 1_000, user_agent: CHROME }),
      event({ id: "css", path: "/assets/styles.css", surface: "asset", action: "page_view", seq: 2, ts: 2_000, gap_ms: 1_000, user_agent: CHROME }),
      event({
        id: "listing",
        path: "/listing/kit_01",
        surface: "page",
        action: "listing_open",
        seq: 3,
        ts: 4_000,
        gap_ms: 2_000,
        user_agent: CHROME,
        listing_id: "kit_01",
        served_title: "Harbor Whistle Kettle",
        served_price_cents: 2400,
      }),
      event({ id: "miss-1", path: "/missing/1", surface: "page", action: "error", status: 404, seq: 4, ts: 6_000, gap_ms: 2_000, user_agent: CHROME }),
      event({ id: "miss-2", path: "/missing/2", surface: "page", action: "error", status: 404, seq: 5, ts: 8_000, gap_ms: 2_000, user_agent: CHROME }),
      event({ id: "miss-3", path: "/missing/3", surface: "page", action: "error", status: 500, seq: 6, ts: 10_000, gap_ms: 2_000, user_agent: CHROME }),
      event({ id: "back", path: "/", surface: "page", action: "page_view", seq: 7, ts: 12_000, gap_ms: 2_000, user_agent: CHROME }),
    ];
    const prediction = classify(events);
    expect(prediction.actor).toBe("agent");
    expect(prediction.signals.error_rate).toBeGreaterThanOrEqual(0.35);
    expect(prediction.primary_intent).toBe("inspect");
    expect(prediction.intent_path.at(-1)).toBe("discover");
    const attached = Object.values(prediction.intent_event_ids).flat();
    expect(attached).not.toContain("miss-1");
    expect(attached).not.toContain("miss-2");
    expect(attached).not.toContain("miss-3");
    expectRealIntentIds(prediction, events);
  });

  it("labels a high repeat rate in Chrome as agent", () => {
    const events = [
      event({ id: "home", path: "/", surface: "page", action: "page_view", seq: 1, ts: 1_000, user_agent: CHROME }),
      event({ id: "css", path: "/assets/styles.css", surface: "asset", action: "page_view", seq: 2, ts: 2_000, gap_ms: 1_000, user_agent: CHROME }),
    ];
    for (let index = 0; index < 4; index += 1) {
      events.push(
        event({
          id: `again-${index}`,
          path: "/c/camp",
          surface: "page",
          action: "page_view",
          query: "lantern",
          seq: index + 3,
          ts: 3_000 + index * 1_000,
          gap_ms: 1_000,
          user_agent: CHROME,
        }),
      );
    }
    const prediction = classify(events);
    expect(prediction.actor).toBe("agent");
    expect(prediction.signals.repeat_rate).toBeGreaterThanOrEqual(0.5);
    expect(prediction.signals.assets_fetched).toBe(true);
    expect(prediction.signals.empty_retrievals).toBe(0);
    expectRealIntentIds(prediction, events);
  });

  it("labels three empty Chrome searches followed by a listing as agent with inspect intent", () => {
    const events = [
      event({ id: "home", path: "/", surface: "page", action: "page_view", seq: 1, ts: 1_000, user_agent: CHROME }),
      event({ id: "css", path: "/assets/styles.css", surface: "asset", action: "page_view", seq: 2, ts: 2_000, gap_ms: 1_000, user_agent: CHROME }),
      event({ id: "search-1", path: "/search", surface: "page", action: "search", query: "no-such-1", seq: 3, ts: 4_000, gap_ms: 2_000, user_agent: CHROME, empty: true, result_count: 0 }),
      event({ id: "search-2", path: "/search", surface: "page", action: "search", query: "no-such-2", seq: 4, ts: 6_000, gap_ms: 2_000, user_agent: CHROME, empty: true, result_count: 0 }),
      event({ id: "search-3", path: "/search", surface: "page", action: "search", query: "no-such-3", seq: 5, ts: 8_000, gap_ms: 2_000, user_agent: CHROME, empty: true, result_count: 0 }),
      event({
        id: "listing",
        path: "/listing/kit_01",
        surface: "page",
        action: "listing_open",
        seq: 6,
        ts: 10_000,
        gap_ms: 2_000,
        user_agent: CHROME,
        listing_id: "kit_01",
        served_title: "Harbor Whistle Kettle",
        served_price_cents: 2400,
      }),
      event({ id: "back", path: "/", surface: "page", action: "page_view", seq: 7, ts: 12_000, gap_ms: 2_000, user_agent: CHROME }),
    ];
    const prediction = classify(events);
    expect(prediction.signals.empty_retrievals).toBeGreaterThanOrEqual(3);
    expect(prediction.actor).toBe("agent");
    expect(prediction.primary_intent).toBe("inspect");
    expect(prediction.intent_path).toEqual(["discover", "retrieve", "inspect", "discover"]);
    expect(prediction.intent_event_ids.retrieve).toEqual(["search-1", "search-2", "search-3"]);
    expect(prediction.intent_event_ids.inspect).toEqual(["listing"]);
    expectRealIntentIds(prediction, events);
  });

  it("does not treat two empty searches as a confident human", () => {
    const events = [
      event({ id: "home", path: "/", surface: "page", action: "page_view", seq: 1, ts: 1_000, user_agent: CHROME }),
      event({ id: "css", path: "/assets/styles.css", surface: "asset", action: "page_view", seq: 2, ts: 2_000, gap_ms: 1_000, user_agent: CHROME }),
      event({ id: "search-1", path: "/search", surface: "page", action: "search", query: "no-such-1", seq: 3, ts: 4_000, gap_ms: 2_000, user_agent: CHROME, empty: true, result_count: 0 }),
      event({ id: "search-2", path: "/search", surface: "page", action: "search", query: "no-such-2", seq: 4, ts: 6_000, gap_ms: 2_000, user_agent: CHROME, empty: true, result_count: 0 }),
      event({
        id: "listing",
        path: "/listing/kit_01",
        surface: "page",
        action: "listing_open",
        seq: 5,
        ts: 8_000,
        gap_ms: 2_000,
        user_agent: CHROME,
        listing_id: "kit_01",
        served_title: "Harbor Whistle Kettle",
        served_price_cents: 2400,
      }),
    ];
    const prediction = classify(events);
    expect(prediction.signals.empty_retrievals).toBe(2);
    expect(prediction.actor).not.toBe("human");
    expect(prediction.primary_intent).toBe("inspect");
    expect(prediction.intent_path).toEqual(["discover", "retrieve", "inspect"]);
  });

  it("labels a curl client that walks empty API searches as agent", () => {
    // Intent rule: search and filter events are retrieve, including empty API
    // results. The primary intent is the last retrieve, inspect, or transact
    // goal. enumerate applies when there is no such goal and the trace fetched
    // robots.txt or sitemap.xml, or covered 15 or more distinct page or API
    // paths. This walk searches, so the intent is retrieve.
    const events = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((name, index) =>
      event({
        id: `api-${index}`,
        path: `/api/listings/${name}`,
        surface: "api",
        action: "search",
        query: name,
        seq: index + 1,
        ts: 1_000 + index * 100,
        gap_ms: index === 0 ? null : 100,
        user_agent: "curl/8.21.0",
        empty: true,
        result_count: 0,
      }),
    );
    const prediction = classify(events);
    expect(prediction.actor).toBe("agent");
    expect(prediction.signals.assets_fetched).toBe(false);
    expect(prediction.signals.api_share).toBeGreaterThanOrEqual(0.5);
    expect(prediction.signals.empty_retrievals).toBeGreaterThanOrEqual(3);
    expect(prediction.primary_intent).toBe("retrieve");
    expect(prediction.intent_path).toEqual(["retrieve"]);
    expectRealIntentIds(prediction, events);
  });

  it("uses enumerate for broad coverage that never retrieves, inspects, or transacts", () => {
    const events = Array.from({ length: 15 }, (_, index) =>
      event({
        id: `page-${index}`,
        path: `/p/${index}`,
        surface: "page",
        action: "page_view",
        seq: index + 1,
        ts: 1_000 + index * 1_000,
        gap_ms: index === 0 ? null : 1_000,
      }),
    );
    const prediction = classify(events);
    expect(prediction.primary_intent).toBe("enumerate");
    expect(prediction.intent_path).toContain("enumerate");
    expectRealIntentIds(prediction, events);
  });

  it("scores a sealed record without feeding it back into classification", () => {
    const prompt = "SEALED_PROMPT_do_not_render_9f3a";
    const model = "gpt";
    const events = [
      event({ id: "1", path: "/cart", surface: "page", action: "cart_add", listing_id: "cam_01", seq: 1, ts: 1_000 }),
      event({ id: "2", path: "/checkout", surface: "page", action: "checkout_complete", seq: 2, ts: 1_200, gap_ms: 200, order_id: "ord" }),
    ];
    const prediction = classify(events);
    const result = score(prediction, {
      model,
      prompt_text: prompt,
      task_id: "checkout_cedar_lantern",
      task_type: "action",
      labeled_intent: "transact",
      expected_listing_ids: ["cam_01"],
      oracle_pass: false,
      oracle_reason: "checkout_abandon",
      self_reported_tokens: 40,
      budgets: { steps: 1, latency_ms: 10, cpu_ms: 1 },
    });
    const encoded = JSON.stringify(prediction);
    expect(encoded).not.toContain(prompt);
    expect(encoded).not.toContain(model);
    expect(encoded).not.toContain("prompt_text");
    expect(prediction.primary_intent).toBe("transact");
    expect(result.intent_agreement).toBe(true);
    expect(result.expected_actor).toBe("agent");
    expect(result.outcome).toBe("fail");
    expect(result.oracle_reason).toBe("checkout_abandon");
    expect(result.cost_flags).toContain("excess_steps");
    expect(result.cost_flags).toContain("excess_latency");
    expect(result.cost_flags).not.toContain("excess_cpu");
    expectRealIntentIds(prediction, events);
  });
});
