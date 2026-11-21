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
    crawler_ua: boolean;
    script_client: boolean;
    error_rate: number;
    repeat_rate: number;
    empty_retrievals: number;
    validation_loop: boolean;
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
const SLOW_GAP_MS = 800;
const FAST_GAP_MS = 250;
const FAST_GAP_MIN_DOCS = 4;
const CRAWLER_PAGE_MIN = 8;
const ENUMERATE_PATH_MIN = 15;
const GOAL_INTENTS = new Set<Intent>(["retrieve", "inspect", "transact"]);

const SCRIPT_TOKENS = [
  "curl/",
  "wget/",
  "python-requests",
  "python-urllib",
  "httpx/",
  "go-http-client",
  "node-fetch",
  "undici",
  "aiohttp",
  "libwww-perl",
  "okhttp",
  "scrapy",
  "axios/",
];

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

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function depthOf(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function byTime(a: ObservedEvent, b: ObservedEvent): number {
  return a.seq - b.seq || a.ts - b.ts;
}

function matchesUa(userAgent: string | null, tokens: string[]): boolean {
  if (!userAgent) return false;
  const haystack = userAgent.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

function isDocument(event: ObservedEvent): boolean {
  return event.surface === "page" || event.surface === "api";
}

function isErrored(event: ObservedEvent): boolean {
  return event.action === "error" || event.status >= 400;
}

function isEmptyRetrieval(event: ObservedEvent): boolean {
  if (event.action !== "search" && event.action !== "filter") return false;
  return event.empty === true || event.result_count === 0;
}

function isCommerce(event: ObservedEvent): boolean {
  return (
    event.action === "cart_add" ||
    event.action === "checkout_step" ||
    event.action === "checkout_complete" ||
    event.path === "/cart" ||
    event.path === "/checkout" ||
    event.path.startsWith("/cart/") ||
    event.path.startsWith("/orders/")
  );
}

function repeatRate(documents: ObservedEvent[]): number {
  const seen = new Set<string>();
  let repeats = 0;
  for (const event of documents) {
    const key = `${event.path}\0${event.query ?? ""}`;
    if (seen.has(key)) repeats += 1;
    else seen.add(key);
  }
  return documents.length === 0 ? 0 : repeats / documents.length;
}

function intentFor(event: ObservedEvent): Intent | null {
  if (event.surface === "asset" || event.action === "error") return null;
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
  if (event.action === "login") return null;
  return "discover";
}

function separateActor(events: ObservedEvent[]): Pick<Classification, "actor" | "actor_confidence" | "signals"> {
  const ordered = [...events].sort(byTime);
  const documents = ordered.filter(isDocument);
  const apiCount = documents.filter((event) => event.surface === "api").length;
  const apiShare = documents.length === 0 ? 0 : apiCount / documents.length;
  const assetsFetched = ordered.some((event) => event.surface === "asset");
  const robotsOrSitemap = ordered.some((event) => event.robots_or_sitemap);
  const medianGapMs = median(ordered.map((event) => event.gap_ms).filter((gap): gap is number => gap != null));
  const crawlerUa = ordered.some((event) => matchesUa(event.user_agent, CRAWLER_TOKENS));
  const scriptClient = ordered.some((event) => matchesUa(event.user_agent, SCRIPT_TOKENS));
  const errorRate = documents.length === 0 ? 0 : documents.filter(isErrored).length / documents.length;
  const repeated = repeatRate(documents);
  const emptyRetrievals = ordered.filter(isEmptyRetrieval).length;
  const checkoutSteps = ordered.filter((event) => event.action === "checkout_step").length;
  const validationLoop = checkoutSteps >= 2 && !ordered.some((event) => event.action === "checkout_complete");
  const distinctPages = new Set(ordered.filter((event) => event.surface === "page").map((event) => event.path)).size;
  const commerce = ordered.some(isCommerce);
  const slowGap = medianGapMs != null && medianGapMs >= SLOW_GAP_MS;

  // Behavior decides the actor. Script clients and missing stylesheets are context.
  let agentScore = 0;
  if (apiShare >= 0.5) agentScore += 0.55;
  else if (apiShare >= 0.25) agentScore += 0.22;
  if (validationLoop) agentScore += 0.6;
  if (emptyRetrievals >= 3) agentScore += 0.55;
  else if (emptyRetrievals >= 2) agentScore += 0.2;
  if (documents.length >= 3 && errorRate >= 0.35) agentScore += 0.55;
  else if (documents.length >= 3 && errorRate >= 0.2) agentScore += 0.22;
  if (documents.length >= 3 && repeated >= 0.5) agentScore += 0.55;
  else if (documents.length >= 3 && repeated >= 0.34) agentScore += 0.22;
  if (scriptClient) agentScore += 0.12;
  if (!assetsFetched && documents.length > 0) agentScore += 0.12;
  if (robotsOrSitemap) agentScore += 0.08;
  if (medianGapMs != null && medianGapMs < FAST_GAP_MS && documents.length >= FAST_GAP_MIN_DOCS) agentScore += 0.08;

  const careful =
    documents.length > 0 &&
    assetsFetched &&
    apiShare < 0.15 &&
    errorRate < 0.2 &&
    repeated < 0.34 &&
    emptyRetrievals < 2 &&
    !validationLoop;
  let humanScore = 0;
  if (careful) {
    humanScore += 0.5;
    if (slowGap) humanScore += 0.2;
  } else {
    if (assetsFetched) humanScore += 0.12;
    if (documents.length > 0 && apiShare < 0.15) humanScore += 0.08;
    if (slowGap) humanScore += 0.08;
  }

  let crawlerScore = 0;
  if (crawlerUa) crawlerScore += 0.95;
  if (robotsOrSitemap && distinctPages >= CRAWLER_PAGE_MIN && !commerce) crawlerScore += 0.85;

  agentScore = roundTo(agentScore, 2);
  humanScore = roundTo(humanScore, 2);
  crawlerScore = roundTo(crawlerScore, 2);

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
      crawler_ua: crawlerUa,
      script_client: scriptClient,
      error_rate: roundTo(errorRate, 4),
      repeat_rate: roundTo(repeated, 4),
      empty_retrievals: emptyRetrievals,
      validation_loop: validationLoop,
      agent_score: agentScore,
      human_score: humanScore,
      crawler_score: crawlerScore,
    },
  };
}

function buildPattern(events: ObservedEvent[]): AccessPattern {
  const ordered = [...events].sort(byTime);
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
  const ordered = [...events].sort(byTime);
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

  const distinctDocuments = new Set(
    ordered.filter((event) => isDocument(event) && !event.path.startsWith("/t/")).map((event) => event.path),
  ).size;
  const hasGoal = path.some((intent) => GOAL_INTENTS.has(intent));
  const coverage = ordered.some((event) => event.robots_or_sitemap) || distinctDocuments >= ENUMERATE_PATH_MIN;
  if (!hasGoal && distinctDocuments >= ENUMERATE_PATH_MIN && !path.includes("enumerate")) path.push("enumerate");

  let primary: Intent;
  if (path.length === 0) primary = "unknown_intent";
  else if (hasGoal) primary = [...path].reverse().find((intent) => GOAL_INTENTS.has(intent)) as Intent;
  else if (coverage) primary = "enumerate";
  else primary = path[path.length - 1];

  return {
    primary_intent: primary,
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
