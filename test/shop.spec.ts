import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TOKEN = "local-sandbox-token";
const PROMPT = "SEALED_PROMPT_do_not_render_9f3a";
const FORBIDDEN = [
  PROMPT,
  "inspect_harbor_kettle",
  "retrieve_kitchen_under_25",
  "checkout_cedar_lantern",
  "claude",
  "gpt",
  "unknown_intent",
  "retrieval_miss",
  "retrieval_empty",
  "filter_invalid",
  "checkout_abandon",
  "citation_unsupported",
  "excess_steps",
  "excess_latency",
  "excess_cpu",
  "labeled_intent",
  "oracle_pass",
  "prompt_text",
  "self_reported",
  "/_control",
];

function cookieFrom(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(/sid=([^;]+)/);
  if (!match) throw new Error(`missing session cookie: ${raw}`);
  return `sid=${match[1]}`;
}

function sessionIdFrom(cookie: string): string {
  const match = cookie.match(/^sid=(.+)$/);
  if (!match) throw new Error(cookie);
  return match[1];
}

async function control(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  return SELF.fetch(`https://shop.test${path}`, { ...init, headers });
}

async function openTrial(model: string, taskId: string): Promise<{ trial_id: string; url: string }> {
  const response = await control("/_control/trials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt_text: PROMPT, task_id: taskId, self_reported_tokens: 12 }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

function assertPublic(body: string): void {
  for (const secret of FORBIDDEN) {
    expect(body.toLowerCase()).not.toContain(secret.toLowerCase());
  }
}

describe("shop trials", () => {
  it("serves an ordinary shop and keeps sealed fields off public responses", async () => {
    const opened = await openTrial("human", "inspect_harbor_kettle");
    const entry = await SELF.fetch(opened.url, { redirect: "manual" });
    expect(entry.status).toBe(302);
    expect(entry.headers.get("location")).toBe("/");
    assertPublic(await entry.text());
    const cookie = cookieFrom(entry);

    const pages = ["/", "/search?q=kettle", "/listing/kit_01", "/account", "/checkout", "/api/listings", "/api/listings/kit_01", "/robots.txt", "/sitemap.xml", "/assets/styles.css"];
    for (const path of pages) {
      const response = await SELF.fetch(`https://shop.test${path}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      assertPublic(await response.text());
    }

    const listing = await SELF.fetch("https://shop.test/listing/kit_01", { headers: { cookie } });
    const html = await listing.text();
    expect(html).toContain("Harbor Whistle Kettle");
    expect(html).toContain("application/ld+json");
    expect(html).toContain("$24.00");

    const leaked = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE path LIKE ? OR IFNULL(query, '') LIKE ? OR IFNULL(served_title, '') LIKE ? OR IFNULL(filters_json, '') LIKE ?",
    )
      .bind(`%${PROMPT}%`, `%${PROMPT}%`, `%${PROMPT}%`, `%${PROMPT}%`)
      .first<{ n: number }>();
    expect(leaked?.n).toBe(0);
  });

  it("closes an inspect trial and scores observed behavior against the sealed record", async () => {
    const opened = await openTrial("human", "inspect_harbor_kettle");
    const entry = await SELF.fetch(opened.url, { redirect: "manual" });
    const cookie = cookieFrom(entry);
    const headers = { cookie };
    await SELF.fetch("https://shop.test/", { headers });
    await SELF.fetch("https://shop.test/assets/styles.css", { headers });
    await SELF.fetch("https://shop.test/search?q=kettle", { headers });
    await SELF.fetch("https://shop.test/listing/kit_01", { headers });

    const closed = await control(`/_control/trials/${opened.trial_id}/close`, { method: "POST" });
    expect(closed.status).toBe(200);
    const report = await control(`/_control/trials/${opened.trial_id}`);
    const body = await report.json<{
      sealed: { prompt_text: string; oracle_pass: boolean; model: string };
      observed: { events: Array<{ path: string; action: string }> };
      unassigned_during_window: number;
      classification: { actor: string; primary_intent: string; intent_path: string[] };
      score: { actor_agreement: boolean; intent_agreement: boolean; outcome: string; oracle_pass: boolean };
    }>();
    expect(body.sealed.prompt_text).toBe(PROMPT);
    expect(body.sealed.model).toBe("human");
    expect(body.sealed.oracle_pass).toBe(true);
    expect(body.observed.events.some((event) => event.action === "listing_open")).toBe(true);
    expect(body.classification.primary_intent).toBe("inspect");
    expect(body.classification.intent_path).toContain("retrieve");
    expect(body.classification.actor).toBe("human");
    expect(body.score.intent_agreement).toBe(true);
    expect(body.score.actor_agreement).toBe(true);
    expect(body.score.outcome).toBe("pass");
    expect(body.unassigned_during_window).toBe(0);
  });

  it("checks out with the guest wallet and records a failed attempt when the balance is too low", async () => {
    const opened = await openTrial("gpt", "checkout_cedar_lantern");
    const entry = await SELF.fetch(opened.url, { redirect: "manual" });
    const cookie = cookieFrom(entry);
    const headers = { cookie, "content-type": "application/x-www-form-urlencoded" };
    const sid = sessionIdFrom(cookie);

    const account = await SELF.fetch("https://shop.test/account", { headers: { cookie } });
    const accountHtml = await account.text();
    expect(account.status).toBe(200);
    expect(accountHtml).toContain("$80.00");
    expect(accountHtml.toLowerCase()).not.toContain("sign in");
    expect(accountHtml).not.toContain("/login");
    assertPublic(accountHtml);

    const removed = await SELF.fetch("https://shop.test/login", {
      method: "POST",
      headers,
      body: "user_id=buyer_mina",
      redirect: "manual",
    });
    expect(removed.status).toBe(404);

    await SELF.fetch("https://shop.test/cart/add", {
      method: "POST",
      headers,
      body: "listing_id=cam_01&qty=2",
      redirect: "manual",
    });
    const invalid = await SELF.fetch("https://shop.test/checkout", {
      method: "POST",
      headers,
      body: "ship_name=Guest&ship_address=1%20Main&ship_city=Duluth&ship_postal=5580",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("5-digit postal code");

    const poor = await SELF.fetch("https://shop.test/checkout", {
      method: "POST",
      headers,
      body: "ship_name=Guest&ship_address=1%20Main&ship_city=Duluth&ship_postal=55802",
    });
    const poorHtml = await poor.text();
    expect(poor.status).toBe(200);
    expect(poorHtml).toContain("Wallet balance is too low");
    expect(poorHtml).toContain("Pay with wallet balance");
    expect(poorHtml.toLowerCase()).not.toContain("sign in");
    const held = await env.DB.prepare("SELECT wallet_cents FROM sessions WHERE id = ?")
      .bind(sid)
      .first<{ wallet_cents: number }>();
    const orders = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders").first<{ n: number }>();
    expect(held?.wallet_cents).toBe(8000);
    expect(orders?.n).toBe(0);

    await SELF.fetch("https://shop.test/cart/add", {
      method: "POST",
      headers,
      body: "listing_id=cam_01&qty=1",
      redirect: "manual",
    });
    const paid = await SELF.fetch("https://shop.test/checkout", {
      method: "POST",
      headers,
      body: "ship_name=Guest&ship_address=1%20Main&ship_city=Duluth&ship_postal=55802",
      redirect: "manual",
    });
    expect(paid.status).toBe(302);
    expect(paid.headers.get("location") ?? "").toMatch(/^\/orders\//);
    const spent = await env.DB.prepare("SELECT wallet_cents FROM sessions WHERE id = ?")
      .bind(sid)
      .first<{ wallet_cents: number }>();
    expect(spent?.wallet_cents).toBe(3800);

    await control(`/_control/trials/${opened.trial_id}/close`, { method: "POST" });
    const report = await control(`/_control/trials/${opened.trial_id}`);
    const body = await report.json<{
      sealed: { oracle_pass: boolean; oracle_reason: string; model: string };
      observed: { events: Array<{ action: string }> };
      classification: { primary_intent: string; actor: string };
      score: { intent_agreement: boolean; actor_agreement: boolean; outcome: string };
    }>();
    expect(body.sealed.oracle_pass).toBe(true);
    expect(body.sealed.oracle_reason).toBe("pass");
    expect(body.observed.events.some((event) => event.action === "checkout_step")).toBe(true);
    expect(body.observed.events.some((event) => event.action === "checkout_complete")).toBe(true);
    expect(body.observed.events.some((event) => event.action === "login")).toBe(false);
    expect(body.classification.primary_intent).toBe("transact");
    expect(body.score.intent_agreement).toBe(true);
    expect(body.score.outcome).toBe("pass");
    expect(body.sealed.model).toBe("gpt");
    expect(body.score.actor_agreement).toBe(body.classification.actor === "agent");
  });

  it("charges the guest wallet from the checkout api", async () => {
    const opened = await openTrial("human", "checkout_cedar_lantern");
    const entry = await SELF.fetch(opened.url, { redirect: "manual" });
    const cookie = cookieFrom(entry);
    const headers = { cookie, "content-type": "application/json" };
    const sid = sessionIdFrom(cookie);
    const ship = { ship_name: "Guest", ship_address: "1 Main", ship_city: "Duluth", ship_postal: "55802" };

    const empty = await SELF.fetch("https://shop.test/api/checkout", {
      method: "POST",
      headers,
      body: JSON.stringify(ship),
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "empty_cart" });

    const gone = await SELF.fetch("https://shop.test/api/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ user_id: "buyer_mina" }),
    });
    expect(gone.status).toBe(404);

    await SELF.fetch("https://shop.test/api/cart", {
      method: "POST",
      headers,
      body: JSON.stringify({ listing_id: "cam_01", qty: 2 }),
    });
    const poor = await SELF.fetch("https://shop.test/api/checkout", {
      method: "POST",
      headers,
      body: JSON.stringify(ship),
    });
    expect(poor.status).toBe(409);
    expect(await poor.json()).toEqual({ error: "insufficient_balance" });
    const held = await env.DB.prepare("SELECT wallet_cents FROM sessions WHERE id = ?")
      .bind(sid)
      .first<{ wallet_cents: number }>();
    expect(held?.wallet_cents).toBe(8000);

    await SELF.fetch("https://shop.test/api/cart", {
      method: "POST",
      headers,
      body: JSON.stringify({ listing_id: "cam_01", qty: 1 }),
    });
    const invalid = await SELF.fetch("https://shop.test/api/checkout", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...ship, ship_postal: "558021" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_shipping" });

    const paid = await SELF.fetch("https://shop.test/api/checkout", {
      method: "POST",
      headers,
      body: JSON.stringify(ship),
    });
    expect(paid.status).toBe(200);
    const paidBody = await paid.json<{ order_id: string; total_cents: number }>();
    expect(paidBody.total_cents).toBe(4200);
    assertPublic(JSON.stringify(paidBody));
    const spent = await env.DB.prepare("SELECT wallet_cents FROM sessions WHERE id = ?")
      .bind(sid)
      .first<{ wallet_cents: number }>();
    expect(spent?.wallet_cents).toBe(3800);

    await control(`/_control/trials/${opened.trial_id}/close`, { method: "POST" });
    const report = await control(`/_control/trials/${opened.trial_id}`);
    const closed = await report.json<{ sealed: { oracle_pass: boolean; oracle_reason: string } }>();
    expect(closed.sealed.oracle_pass).toBe(true);
    expect(closed.sealed.oracle_reason).toBe("pass");
  });

  it("rejects control calls without the bearer token", async () => {
    const response = await SELF.fetch("https://shop.test/_control/trials", { method: "POST" });
    expect(response.status).toBe(401);
  });
});
