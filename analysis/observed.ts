export type Surface = "page" | "api" | "asset";

/** A request the shop actually served. No prompt, model, task, or oracle fields. */
export type ObservedEvent = {
  id: string;
  session_id: string;
  seq: number;
  ts: number;
  path: string;
  surface: Surface;
  action: string;
  query: string | null;
  filters: Record<string, string> | null;
  result_ids: string[];
  status: number;
  user_agent: string | null;
  colo: string | null;
  ray_id: string | null;
  handler_ms: number;
  gap_ms: number | null;
  robots_or_sitemap: boolean;
  method: string;
  result_count: number | null;
  empty: boolean | null;
  listing_id: string | null;
  category_id: string | null;
  seller_id: string | null;
  order_id: string | null;
  served_price_cents: number | null;
  served_title: string | null;
};
