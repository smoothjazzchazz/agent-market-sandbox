import type { ObservedEvent } from "./observed";

export type Intent =
  | "discover"
  | "retrieve"
  | "inspect"
  | "transact"
  | "enumerate"
  | "unknown_intent";

export type Actor = "agent" | "human" | "crawler" | "unknown";

export type AccessPattern = {
  pages: {
    event_id: string;
    path: string;
    category_id: string | null;
    depth: number;
    status: number;
  }[];
  objects: {
    listing_ids: string[];
    seller_ids: string[];
    categories: string[];
    cart_listing_ids: string[];
    order_ids: string[];
  };
  api_calls: {
    event_id: string;
    method: string;
    path: string;
    query: string | null;
    status: number;
    result_count: number | null;
    empty: boolean | null;
  }[];
  retrievals: {
    event_id: string;
    query: string | null;
    filters: Record<string, string> | null;
    result_ids: string[];
  }[];
  citations: {
    event_id: string;
    listing_id: string;
    served_title: string | null;
    served_price_cents: number | null;
    delivered: boolean;
  }[];
  cost: {
    steps: number;
    sequence_ms: number;
    handler_ms: number;
    cpu_ms: null;
  };
};

export type Classification = {
  actor: Actor;
  actor_confidence: number;
  signals: {
    api_share: number;
    assets_fetched: boolean;
    robots_or_sitemap: boolean;
    median_gap_ms: number | null;
    login_after_form: boolean;
    crawler_ua: boolean;
    agent_score: number;
    human_score: number;
    crawler_score: number;
  };
  pattern: AccessPattern;
  primary_intent: Intent;
  intent_path: Intent[];
  intent_event_ids: Partial<Record<Intent, string[]>>;
};

const ACTOR_FLOOR = 0.45;

const CRAWLER_TOKENS = [
  "googlebot",
  "bingbot",
  "duckduckbot",
  "baiduspider",
  "yandexbot",
  "slackbot",
  "twitterbot",
  "facebookexternalhit",
  "gptbot",
  "oai-searchbot",
  "chatgpt-user",
  "claudebot",
  "claude-searchbot",
  "claude-user",
  "perplexitybot",
  "ccbot",
  "applebot",
  "semrush",
  "ahrefs",
  "petalbot",
  "bytespider",
  "amazonbot",
];

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function depthOf(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function isCrawlerUa(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const haystack = userAgent.toLowerCase();
  return CRAWLER_TOKENS.some((token) => haystack.includes(token));
}

function intentFor(event: ObservedEvent): Intent | null {
  if (event.surface === "asset") return null;
  if (event.path.startsWith("/t/")) return null;
  if (event.robots_or_sitemap) return "enumerate";
  if (event.action === "search" || event.action === "filter") return "retrieve";
  if (event.action === "listing_open" || event.action === "profile_view") return "inspect";
  if (
    event.action === "cart_add" ||
    event.action === "checkout_step" ||
    event.action === "checkout_complete" ||
    event.path === "/cart" ||
    event.path === "/checkout" ||
    event.path.startsWith("/orders/")
  ) {
    return "transact";
  }
  if (event.action === "login" || event.action === "error") return null;
  return "discover";
}

function separateActor(events: ObservedEvent[]): Pick<Classification, "actor" | "actor_confidence" | "signals"> {
  const documents = events.filter((event) => event.surface === "page" || event.surface === "api");
  const apiCount = documents.filter((event) => event.surface === "api").length;
  const apiShare = documents.length === 0 ? 0 : apiCount / documents.length;
  const assetsFetched = events.some((event) => event.surface === "asset");
  const robotsOrSitemap = events.some((event) => event.robots_or_sitemap);
  const medianGapMs = median(
    events.map((event) => event.gap_ms).filter((gap): gap is number => gap != null),
  );
  const loginAfterForm = events.some((event) => event.action === "login");
  const crawlerUa = events.some((event) => isCrawlerUa(event.user_agent));
  const distinctPaths = new Set(events.filter((event) => event.surface === "page").map((event) => event.path)).size;

  let agentScore = 0;
  if (apiShare >= 0.5) agentScore += 0.35;
  else if (apiShare >= 0.25) agentScore += 0.15;
  if (!assetsFetched && documents.length > 0) agentScore += 0.3;
  if (robotsOrSitemap) agentScore += 0.15;
  if (medianGapMs != null && medianGapMs < 400) agentScore += 0.2;

  let humanScore = 0;
  if (assetsFetched) humanScore += 0.35;
  if (apiShare < 0.15) humanScore += 0.25;
  else if (apiShare < 0.35) humanScore += 0.1;
  if (medianGapMs != null && medianGapMs >= 800) humanScore += 0.25;
  if (loginAfterForm) humanScore += 0.15;

  let crawlerScore = 0;
  if (crawlerUa) crawlerScore += 0.95;
  if (robotsOrSitemap && distinctPaths >= 8 && !loginAfterForm) crawlerScore += 0.5;

  const ranked: Array<[Actor, number]> = [
    ["agent", agentScore],
    ["human", humanScore],
    ["crawler", crawlerScore],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  const [topActor, topScore] = ranked[0];
  const actor: Actor = documents.length === 0 || topScore < ACTOR_FLOOR ? "unknown" : topActor;
  const confidence = documents.length === 0 ? 0 : Math.min(0.99, topScore);

  return {
    actor,
    actor_confidence: confidence,
    signals: {
      api_share: apiShare,
      assets_fetched: assetsFetched,
      robots_or_sitemap: robotsOrSitemap,
      median_gap_ms: medianGapMs,
      login_after_form: loginAfterForm,
      crawler_ua: crawlerUa,
      agent_score: agentScore,
      human_score: humanScore,
      crawler_score: crawlerScore,
    },
  };
}

function buildPattern(events: ObservedEvent[]): AccessPattern {
  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.ts - b.ts);
  const substantive = ordered.filter((event) => event.surface !== "asset");
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return {
    pages: ordered
      .filter((event) => event.surface === "page")
      .map((event) => ({
        event_id: event.id,
        path: event.path,
        category_id: event.category_id,
        depth: depthOf(event.path),
        status: event.status,
      })),
    objects: {
      listing_ids: unique(ordered.map((event) => event.listing_id)),
      seller_ids: unique(ordered.map((event) => event.seller_id)),
      categories: unique(ordered.map((event) => event.category_id)),
      cart_listing_ids: unique(
        ordered.filter((event) => event.action === "cart_add").map((event) => event.listing_id),
      ),
      order_ids: unique(ordered.map((event) => event.order_id)),
    },
    api_calls: ordered
      .filter((event) => event.surface === "api")
      .map((event) => ({
        event_id: event.id,
        method: event.method,
        path: event.path,
        query: event.query,
        status: event.status,
        result_count: event.result_count,
        empty: event.empty,
      })),
    retrievals: ordered
      .filter((event) => event.action === "search" || event.action === "filter")
      .map((event) => ({
        event_id: event.id,
        query: event.query,
        filters: event.filters,
        result_ids: event.result_ids,
      })),
    citations: ordered
      .filter((event) => event.action === "listing_open" && event.listing_id)
      .map((event) => ({
        event_id: event.id,
        listing_id: event.listing_id as string,
        served_title: event.served_title,
        served_price_cents: event.served_price_cents,
        delivered: event.served_title != null && event.served_price_cents != null,
      })),
    cost: {
      steps: substantive.length,
      sequence_ms: first && last ? Math.max(0, last.ts - first.ts) : 0,
      handler_ms: ordered.reduce((sum, event) => sum + event.handler_ms, 0),
      cpu_ms: null,
    },
  };
}

function bucketIntent(events: ObservedEvent[]): Pick<Classification, "primary_intent" | "intent_path" | "intent_event_ids"> {
  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.ts - b.ts);
  const intentEventIds: Partial<Record<Intent, string[]>> = {};
  const path: Intent[] = [];
  for (const event of ordered) {
    const intent = intentFor(event);
    if (!intent) continue;
    const ids = intentEventIds[intent] ?? [];
    ids.push(event.id);
    intentEventIds[intent] = ids;
    if (path[path.length - 1] !== intent) path.push(intent);
  }

  const distinctPaths = new Set(
    ordered.filter((event) => event.surface === "page" && !event.path.startsWith("/t/")).map((event) => event.path),
  ).size;
  const hasGoal = path.some((intent) => intent === "retrieve" || intent === "inspect" || intent === "transact");
  if (distinctPaths >= 15 && !hasGoal && path[path.length - 1] !== "enumerate") {
    path.push("enumerate");
  }

  return {
    primary_intent: path.length === 0 ? "unknown_intent" : path[path.length - 1],
    intent_path: path.length === 0 ? ["unknown_intent"] : path,
    intent_event_ids: intentEventIds,
  };
}

export function classify(events: ObservedEvent[]): Classification {
  return {
    ...separateActor(events),
    pattern: buildPattern(events),
    ...bucketIntent(events),
  };
}

export { ACTOR_FLOOR };
