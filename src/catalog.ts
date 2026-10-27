import raw from "../data/seed/catalog.json";
import taskFile from "../data/tasks/v1.json";

export type SeedUser = {
  id: string;
  name: string;
  kind: "seller" | "buyer";
  bio: string;
  wallet_cents: number;
};

export type SeedListing = {
  id: string;
  seller_id: string;
  category_id: string;
  title: string;
  description: string;
  price_cents: number;
  stock: number;
};

export type SeedCategory = {
  id: string;
  name: string;
  parent_id: string | null;
};

export const catalog = raw as {
  seed_version: string;
  categories: SeedCategory[];
  users: SeedUser[];
  listings: SeedListing[];
};

export type TaskOracle = "open_any" | "open_listing" | "order";

export type StudyTask = {
  id: string;
  type: "data_access" | "action";
  labeled_intent: "discover" | "retrieve" | "inspect" | "transact" | "enumerate" | "unknown_intent";
  suggested_prompt: string;
  expected_listing_ids: string[];
  buyer_id: string | null;
  oracle: TaskOracle;
  budgets: { steps: number; latency_ms: number; cpu_ms: number };
};

export const taskBook = taskFile as { task_version: string; tasks: StudyTask[] };

export function findTask(id: string): StudyTask | undefined {
  return taskBook.tasks.find((task) => task.id === id);
}

export function listingById(id: string): SeedListing | undefined {
  return catalog.listings.find((listing) => listing.id === id);
}

export function categoryById(id: string): SeedCategory | undefined {
  return catalog.categories.find((category) => category.id === id);
}
