import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import friction from "../data/seed/friction.json";

const TOKEN = "local-sandbox-token";

function cookieFrom(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(/sid=([^;]+)/);
  if (!match) throw new Error(`missing session cookie: ${raw}`);
  return `sid=${match[1]}`;
}

beforeEach(async () => {
  const response = await SELF.fetch("https://shop.test/_control/trials", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "human",
      prompt_text: "friction-setup",
      task_id: "inspect_harbor_kettle",
      self_reported_tokens: 1,
    }),
  });
  expect(response.status).toBe(201);
});

async function sessionCookie(): Promise<string> {
  const home = await SELF.fetch("https://shop.test/");
  return cookieFrom(home);
}

describe("shop friction", () => {
  it("lists subcategory links on a department page and omits product prices", async () => {
    const response = await SELF.fetch("https://shop.test/c/electronics");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/c/electronics/audio"');
    expect(html).toContain('href="/c/electronics/computers"');
    expect(html).not.toContain("Pocket Radio");
    expect(html).not.toContain('class="price"');
    expect(html).not.toMatch(/\$\d/);

    for (const parent of ["home", "outdoors"]) {
      const page = await SELF.fetch(`https://shop.test/c/${parent}`);
      expect(page.status).toBe(200);
      const body = await page.text();
      expect(body).not.toMatch(/\$\d/);
      expect(body).not.toContain('class="price"');
    }
  });

  it("serves child category page 2 and rejects page 99", async () => {
    const page2 = await SELF.fetch("https://shop.test/c/home/kitchen?page=2");
    expect(page2.status).toBe(200);
    const html = await page2.text();
    expect(html).toContain("Stand Mixer");
    expect(html).toContain("Stoneware Soup Bowl");
    expect(html).not.toContain("Harbor Whistle Kettle");

    const page99 = await SELF.fetch("https://shop.test/c/home/kitchen?page=99");
    expect(page99.status).toBe(404);
    expect(await page99.text()).not.toContain("Harbor Whistle Kettle");
    const recorded = await env.DB.prepare(
      "SELECT action, status FROM events WHERE path = ? AND status = 404 ORDER BY ts DESC, seq DESC LIMIT 1",
    )
      .bind("/c/home/kitchen")
      .first<{ action: string; status: number }>();
    expect(recorded?.action).toBe("error");
    expect(recorded?.status).toBe(404);
  });

  it("returns an empty search when an extra token does not match", async () => {
    const response = await SELF.fetch("https://shop.test/search?q=kettle%20zzzznotaword");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("0 listings.");
    expect(html).toContain("No listings matched.");
    expect(html).not.toContain("Harbor Whistle Kettle");
    const recorded = await env.DB.prepare(
      "SELECT action, empty_flag, result_count FROM events WHERE path = '/search' AND IFNULL(query, '') = ? ORDER BY ts DESC, seq DESC LIMIT 1",
    )
      .bind("kettle zzzznotaword")
      .first<{ action: string; empty_flag: number; result_count: number }>();
    expect(recorded?.action).toBe("search");
    expect(recorded?.empty_flag).toBe(1);
    expect(recorded?.result_count).toBe(0);
  });

  it("rejects a search whose minimum price is above its maximum", async () => {
    const response = await SELF.fetch("https://shop.test/search?min=40&max=10");
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("Minimum price is greater than the maximum price.");
    const recorded = await env.DB.prepare(
      "SELECT action, status FROM events WHERE path = '/search' AND status = 400 ORDER BY ts DESC, seq DESC LIMIT 1",
    ).first<{ action: string; status: number }>();
    expect(recorded?.action).toBe("error");
    expect(recorded?.status).toBe(400);
  });

  it("links similar items to a dead end and keeps the public listing price", async () => {
    const listing = await SELF.fetch("https://shop.test/listing/kit_01");
    expect(listing.status).toBe(200);
    const html = await listing.text();
    expect(html).toContain("Harbor Whistle Kettle");
    expect(html).toContain("$24.00");
    expect(html).toContain("application/ld+json");
    expect(html).toContain("Similar items");
    const href = html.match(/href="(\/listing\/kit_01\/similar)"/);
    expect(href?.[1]).toBe("/listing/kit_01/similar");
    const similar = await SELF.fetch("https://shop.test/listing/kit_01/similar");
    expect(similar.status).toBe(404);
    const recorded = await env.DB.prepare(
      "SELECT action, status FROM events WHERE path = ? ORDER BY ts DESC, seq DESC LIMIT 1",
    )
      .bind("/listing/kit_01/similar")
      .first<{ action: string; status: number }>();
    expect(recorded?.action).toBe("error");
    expect(recorded?.status).toBe(404);
  });

  it("does not add a color-required listing when color is missing", async () => {
    const id = friction.requires_color[0];
    expect(id).toBeTruthy();
    const cookie = await sessionCookie();
    const sessionId = cookie.slice("sid=".length);
    const headers = { cookie, "content-type": "application/x-www-form-urlencoded" };
    const denied = await SELF.fetch("https://shop.test/cart", {
      method: "POST",
      headers,
      body: `listing_id=${id}&qty=99`,
      redirect: "manual",
    });
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("Choose a color before adding this item.");
    const missing = await env.DB.prepare("SELECT qty FROM carts WHERE session_id = ? AND listing_id = ?")
      .bind(sessionId, id)
      .first();
    expect(missing).toBeNull();
    const deniedEvent = await env.DB.prepare(
      "SELECT action, status FROM events WHERE path = '/cart' AND method = 'POST' AND status = 400 ORDER BY ts DESC, seq DESC LIMIT 1",
    ).first<{ action: string; status: number }>();
    expect(deniedEvent?.action).toBe("error");

    const listing = await env.DB.prepare("SELECT stock, title FROM listings WHERE id = ?")
      .bind(id)
      .first<{ stock: number; title: string }>();
    const added = await SELF.fetch("https://shop.test/cart", {
      method: "POST",
      headers,
      body: `listing_id=${id}&qty=99&color=Navy`,
      redirect: "manual",
    });
    expect(added.status).toBe(302);
    const saved = await env.DB.prepare("SELECT qty FROM carts WHERE session_id = ? AND listing_id = ?")
      .bind(sessionId, id)
      .first<{ qty: number }>();
    expect(saved?.qty).toBe(listing?.stock);
    const cart = await SELF.fetch("https://shop.test/cart", { headers: { cookie } });
    expect(await cart.text()).toContain(listing?.title ?? "");
  });

  it("returns more than one listing for the mug alias and notes shared names", async () => {
    const search = await SELF.fetch("https://shop.test/search?q=mug");
    expect(search.status).toBe(200);
    const results = await search.text();
    expect(results).toContain("Enamel Mug");
    expect(results).toContain("Stoneware Soup Bowl");

    const listing = await SELF.fetch("https://shop.test/listing/cyc_04");
    expect(listing.status).toBe(200);
    const html = await listing.text();
    expect(html).toContain("Another listing shares this name");
    expect(html).toContain('href="/listing/cyc_10"');
  });

  it("rejects an out-of-stock add and an unknown listing", async () => {
    const id = friction.out_of_stock[0];
    const cookie = await sessionCookie();
    const sessionId = cookie.slice("sid=".length);
    const headers = { cookie, "content-type": "application/x-www-form-urlencoded" };
    const page = await SELF.fetch(`https://shop.test/listing/${id}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Out of stock.");

    const denied = await SELF.fetch("https://shop.test/cart", {
      method: "POST",
      headers,
      body: `listing_id=${id}&qty=1`,
      redirect: "manual",
    });
    expect(denied.status).toBe(409);
    const row = await env.DB.prepare("SELECT qty FROM carts WHERE session_id = ? AND listing_id = ?")
      .bind(sessionId, id)
      .first();
    expect(row).toBeNull();
    const recorded = await env.DB.prepare(
      "SELECT action FROM events WHERE path = '/cart' AND method = 'POST' AND status = 409 ORDER BY ts DESC, seq DESC LIMIT 1",
    ).first<{ action: string }>();
    expect(recorded?.action).toBe("error");

    const unknown = await SELF.fetch("https://shop.test/listing/missing_item");
    expect(unknown.status).toBe(404);
    const unknownEvent = await env.DB.prepare(
      "SELECT action FROM events WHERE path = '/listing/missing_item' ORDER BY ts DESC, seq DESC LIMIT 1",
    ).first<{ action: string }>();
    expect(unknownEvent?.action).toBe("error");
  });
});
