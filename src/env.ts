export type Env = {
  DB: D1Database;
  ANALYTICS: AnalyticsEngineDataset;
  ASSETS: Fetcher;
  CONTROL_TOKEN: string;
};

export type Obs = {
  action: string;
  query?: string | null;
  filters?: Record<string, string> | null;
  resultIds?: string[];
  resultCount?: number | null;
  empty?: boolean | null;
  listingId?: string | null;
  categoryId?: string | null;
  sellerId?: string | null;
  orderId?: string | null;
  servedPriceCents?: number | null;
  servedTitle?: string | null;
};

export type Vars = {
  sessionId: string | null;
  trialId: string | null;
  userId: string | null;
  obs: Obs | null;
};

export type AppContext = { Bindings: Env; Variables: Vars };
