import type { Context } from "hono";
import type { ObservedEvent, Surface } from "../analysis/observed";
import type { AppContext, Obs } from "./env";

type EventRow = {
  id: string;
  trial_id: string | null;
  session_id: string;
  seq: number;
  ts: number;
  path: string;
  surface: string;
  action: string;
  query: string | null;
  filters_json: string | null;
  result_ids_json: string | null;
  status: number;
  user_agent: string | null;
  colo: string | null;
  ray_id: string | null;
  handler_ms: number;
  gap_ms: number | null;
  robots_or_sitemap: number;
  method: string;
  result_count: number | null;
  empty_flag: number | null;
  listing_id: string | null;
  category_id: string | null;
  seller_id: string | null;
  order_id: string | null;
  served_price_cents: number | null;
  served_title: string | null;
};

function surfaceFor(path: string): Surface {
  if (path.startsWith("/assets/")) return "asset";
  if (path.startsWith("/api/")) return "api";
  return "page";
}

export async function recordEvent(c: Context<AppContext>, started: number): Promise<void> {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/_control")) return;

  const path = url.pathname;
  const surface = surfaceFor(path);
  let sessionId = c.get("sessionId");
  const trialId = c.get("trialId");
  if (!sessionId) sessionId = `loose_${crypto.randomUUID()}`;

  const obs: Obs = c.get("obs") ?? { action: surface === "asset" ? "page_view" : "page_view" };
  const previous = await c.env.DB.prepare(
    "SELECT ts, seq FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
  )
    .bind(sessionId)
    .first<{ ts: number; seq: number }>();
  const ts = Date.now();
  const seq = (previous?.seq ?? 0) + 1;
  const gap = previous ? ts - previous.ts : null;
  const ray = c.req.header("cf-ray") ?? null;
  const colo = (c.req.raw.cf as { colo?: string } | undefined)?.colo ?? null;
  const userAgent = c.req.header("user-agent");
  const robots = path === "/robots.txt" || path === "/sitemap.xml" ? 1 : 0;
  const filters = obs.filters && Object.values(obs.filters).some(Boolean) ? obs.filters : null;
  const resultIds = obs.resultIds ?? [];
  const status = c.res.status;

  await c.env.DB.prepare(
    `INSERT INTO events (
      id, trial_id, session_id, seq, ts, path, surface, action, query, filters_json, result_ids_json,
      status, user_agent, colo, ray_id, handler_ms, gap_ms, robots_or_sitemap, method, result_count,
      empty_flag, listing_id, category_id, seller_id, order_id, served_price_cents, served_title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      trialId,
      sessionId,
      seq,
      ts,
      path,
      surface,
      obs.action,
      obs.query ?? null,
      filters ? JSON.stringify(filters) : null,
      JSON.stringify(resultIds),
      status,
      userAgent ?? null,
      colo,
      ray,
      ts - started,
      gap,
      robots,
      c.req.method,
      obs.resultCount ?? null,
      obs.empty == null ? null : obs.empty ? 1 : 0,
      obs.listingId ?? null,
      obs.categoryId ?? null,
      obs.sellerId ?? null,
      obs.orderId ?? null,
      obs.servedPriceCents ?? null,
      obs.servedTitle ?? null,
    )
    .run();

  try {
    c.env.analytics_engine.writeDataPoint({
      indexes: [trialId ?? sessionId],
      blobs: [
        obs.action,
        surface,
        path.slice(0, 200),
        (obs.query ?? "").slice(0, 200),
        obs.categoryId ?? "",
        obs.listingId ?? "",
        obs.empty ? "1" : "0",
        ray ?? "",
        (userAgent ?? "").slice(0, 120),
      ],
      doubles: [status, obs.resultCount ?? -1, ts - started, seq],
    });
  } catch (error) {
    console.log(JSON.stringify({ kind: "analytics_skip", message: String(error) }));
  }

  console.log(
    JSON.stringify({
      kind: "shop_event",
      ray_id: ray,
      action: obs.action,
      path,
      status,
      session_id: sessionId,
      trial_id: trialId,
    }),
  );
}

export function toObserved(row: EventRow): ObservedEvent {
  return {
    id: row.id,
    session_id: row.session_id,
    seq: row.seq,
    ts: row.ts,
    path: row.path,
    surface: row.surface === "api" || row.surface === "asset" ? row.surface : "page",
    action: row.action,
    query: row.query,
    filters: row.filters_json ? (JSON.parse(row.filters_json) as Record<string, string>) : null,
    result_ids: row.result_ids_json ? (JSON.parse(row.result_ids_json) as string[]) : [],
    status: row.status,
    user_agent: row.user_agent,
    colo: row.colo,
    ray_id: row.ray_id,
    handler_ms: row.handler_ms,
    gap_ms: row.gap_ms,
    robots_or_sitemap: row.robots_or_sitemap === 1,
    method: row.method,
    result_count: row.result_count,
    empty: row.empty_flag == null ? null : row.empty_flag === 1,
    listing_id: row.listing_id,
    category_id: row.category_id,
    seller_id: row.seller_id,
    order_id: row.order_id,
    served_price_cents: row.served_price_cents,
    served_title: row.served_title,
  };
}

export async function eventsForTrial(db: D1Database, trialId: string, frozenThrough: number | null): Promise<ObservedEvent[]> {
  const sql = frozenThrough == null
    ? "SELECT * FROM events WHERE trial_id = ? ORDER BY ts ASC, seq ASC"
    : "SELECT * FROM events WHERE trial_id = ? AND ts <= ? ORDER BY ts ASC, seq ASC";
  const statement = frozenThrough == null
    ? db.prepare(sql).bind(trialId)
    : db.prepare(sql).bind(trialId, frozenThrough);
  const rows = await statement.all<EventRow>();
  return rows.results.map(toObserved);
}
