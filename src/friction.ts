import type { Context, Hono } from "hono";
import frictionFile from "../data/seed/friction.json";
import { categoryById } from "./catalog";
import type { AppContext } from "./env";
import {
  PAGE_SIZE,
  departmentPage,
  frictionListingPage,
  frictionMessagePage,
  frictionSearchPage,
  subcategoryPage,
} from "./friction-render";
import {
  dollarsToCents,
  listingById,
  categories,
  readFilters,
  searchListings,
  userById,
  type CategoryRow,
  type Filters,
  type ListingRow,
  type UserRow,
} from "./shop-data";

type FrictionConfig = {
  page_size: number;
  requires_color: string[];
  out_of_stock: string[];
  ambiguous: string[][];
  aliases: Record<string, string[]>;
};

const friction = frictionFile as FrictionConfig;

const RANGE_MESSAGE = "Minimum price is greater than the maximum price.";

function readPage(raw: string | null): number | "invalid" {
  if (raw == null || raw.trim() === "") return 1;
  const text = raw.trim();
  if (!/^[1-9]\d{0,5}$/.test(text)) return "invalid";
  return Number(text);
}

function inRange(page: number, count: number): boolean {
  if (page < 1) return false;
  if (count === 0) return page === 1;
  return page <= Math.ceil(count / PAGE_SIZE);
}

function slicePage<T>(items: T[], page: number): T[] {
  const start = (page - 1) * PAGE_SIZE;
  return items.slice(start, start + PAGE_SIZE);
}

function field(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampQty(value: unknown, stock: number): number {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(stock, Math.floor(parsed)));
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokensOf(query: string): string[] {
  return normalizeQuery(query).split(" ").filter(Boolean);
}

function matchesTokens(listing: ListingRow, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${listing.title} ${listing.description}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function categoryMatches(tree: CategoryRow[], listing: ListingRow, categoryId: string): boolean {
  if (!categoryId) return true;
  if (listing.category_id === categoryId) return true;
  const category = tree.find((item) => item.id === listing.category_id);
  return category?.parent_id === categoryId;
}

function priceMatches(listing: ListingRow, filters: Filters): boolean {
  const minCents = dollarsToCents(filters.min);
  const maxCents = dollarsToCents(filters.max);
  if (minCents != null && listing.price_cents < minCents) return false;
  if (maxCents != null && listing.price_cents > maxCents) return false;
  return true;
}

function compareListings(sort: string, a: ListingRow, b: ListingRow): number {
  if (sort === "price_desc") return b.price_cents - a.price_cents || a.id.localeCompare(b.id);
  if (sort === "title") return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  return a.price_cents - b.price_cents || a.id.localeCompare(b.id);
}

function filtersOf(filters: Filters, pageLabel: string): Record<string, string> {
  return {
    q: filters.q,
    category: filters.category,
    min: filters.min,
    max: filters.max,
    sort: filters.sort,
    page: pageLabel,
  };
}

function searchAction(filters: Filters): "search" | "filter" {
  if (filters.q) return "search";
  if (filters.category || filters.min || filters.max) return "filter";
  return "search";
}

async function shell(c: Context<AppContext>): Promise<{ tree: CategoryRow[]; user: UserRow | null }> {
  const tree = await categories(c.env.DB);
  const userId = c.get("userId");
  const user = userId ? await userById(c.env.DB, userId) : null;
  return { tree, user };
}

function ambiguousOthers(id: string): string[] {
  const ids = new Set<string>();
  for (const group of friction.ambiguous) {
    if (!group.includes(id)) continue;
    for (const other of group) {
      if (other !== id) ids.add(other);
    }
  }
  return [...ids];
}

export function registerFriction(app: Hono<AppContext>): void {
  app.get("/listing/:id/similar", async (c) => {
    const { tree, user } = await shell(c);
    c.set("obs", {
      action: "error",
      listingId: c.req.param("id"),
      resultIds: [],
      resultCount: 0,
      empty: true,
    });
    return c.html(frictionMessagePage(tree, user, "Not found", "Similar items are not available."), 404);
  });

  app.get("/listing/:id", async (c) => {
    const { tree, user } = await shell(c);
    const listing = await listingById(c.env.DB, c.req.param("id"));
    if (!listing) {
      c.set("obs", { action: "error", listingId: c.req.param("id"), resultIds: [], resultCount: 0, empty: true });
      return c.html(frictionMessagePage(tree, user, "Not found", "That listing is not in the catalog."), 404);
    }
    const category = tree.find((item) => item.id === listing.category_id) ?? categoryById(listing.category_id);
    if (!category) {
      c.set("obs", { action: "error", listingId: listing.id, resultIds: [], resultCount: 0, empty: true });
      return c.html(frictionMessagePage(tree, user, "Not found", "That listing is not in the catalog."), 404);
    }
    const parent = category.parent_id ? tree.find((item) => item.id === category.parent_id) ?? null : null;
    const ambiguous = [];
    for (const id of ambiguousOthers(listing.id)) {
      const other = await listingById(c.env.DB, id);
      if (other) ambiguous.push({ id: other.id, title: other.title });
    }
    const outOfStock = friction.out_of_stock.includes(listing.id) || listing.stock <= 0;
    c.set("obs", {
      action: "listing_open",
      listingId: listing.id,
      categoryId: listing.category_id,
      sellerId: listing.seller_id,
      servedPriceCents: listing.price_cents,
      servedTitle: listing.title,
      resultIds: [listing.id],
      resultCount: 1,
      empty: false,
    });
    return c.html(
      frictionListingPage(tree, listing, category, parent, user, {
        outOfStock,
        requiresColor: friction.requires_color.includes(listing.id),
        ambiguous,
      }),
    );
  });

  app.get("/c/:parent/:sub", async (c) => {
    const { tree, user } = await shell(c);
    const parent = tree.find((category) => category.id === c.req.param("parent") && category.parent_id == null);
    const current = tree.find((category) => category.id === c.req.param("sub") && category.parent_id === parent?.id);
    if (!parent || !current) {
      c.set("obs", { action: "error", resultIds: [], resultCount: 0, empty: true });
      return c.html(frictionMessagePage(tree, user, "Not found", "That category is not in the catalog."), 404);
    }
    const listings = await searchListings(c.env.DB, {
      q: "",
      category: current.id,
      min: "",
      max: "",
      sort: "title",
    });
    const url = new URL(c.req.url);
    const page = readPage(url.searchParams.get("page"));
    const pageLabel = url.searchParams.get("page")?.trim() || "1";
    if (page === "invalid" || !inRange(page, listings.length)) {
      c.set("obs", {
        action: "error",
        categoryId: current.id,
        filters: { page: pageLabel },
        resultIds: [],
        resultCount: 0,
        empty: true,
      });
      return c.html(frictionMessagePage(tree, user, "Not found", "That page is outside this category."), 404);
    }
    const slice = slicePage(listings, page);
    c.set("obs", {
      action: "page_view",
      categoryId: current.id,
      filters: { page: String(page) },
      resultIds: slice.map((listing) => listing.id),
      resultCount: slice.length,
      empty: slice.length === 0,
    });
    return c.html(subcategoryPage(tree, parent, current, slice, page, listings.length, user));
  });

  app.get("/c/:parent", async (c) => {
    const { tree, user } = await shell(c);
    const current = tree.find((category) => category.id === c.req.param("parent") && category.parent_id == null);
    if (!current) {
      c.set("obs", { action: "error", resultIds: [], resultCount: 0, empty: true });
      return c.html(frictionMessagePage(tree, user, "Not found", "That department is not in the catalog."), 404);
    }
    const children = tree
      .filter((category) => category.parent_id === current.id)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    c.set("obs", {
      action: "page_view",
      categoryId: current.id,
      resultIds: [],
      resultCount: 0,
      empty: true,
    });
    return c.html(departmentPage(tree, current, children, user));
  });

  app.get("/search", async (c) => {
    const { tree, user } = await shell(c);
    const url = new URL(c.req.url);
    const filters = readFilters(url);
    const page = readPage(url.searchParams.get("page"));
    const pageLabel = url.searchParams.get("page")?.trim() || (page === "invalid" ? "" : String(page));
    const minCents = dollarsToCents(filters.min);
    const maxCents = dollarsToCents(filters.max);
    if (minCents != null && maxCents != null && minCents > maxCents) {
      c.set("obs", {
        action: "error",
        query: filters.q || null,
        filters: filtersOf(filters, pageLabel || "1"),
        resultIds: [],
        resultCount: 0,
        empty: true,
        categoryId: filters.category || null,
      });
      return c.html(frictionSearchPage(tree, filters, [], 1, 0, user, RANGE_MESSAGE), 400);
    }
    const all = await searchListings(c.env.DB, { q: "", category: "", min: "", max: "", sort: "title" });
    const tokens = tokensOf(filters.q);
    const matched = new Map<string, ListingRow>();
    for (const listing of all) {
      if (!categoryMatches(tree, listing, filters.category) || !priceMatches(listing, filters)) continue;
      if (matchesTokens(listing, tokens)) matched.set(listing.id, listing);
    }
    const aliasKey = normalizeQuery(filters.q);
    for (const id of friction.aliases[aliasKey] ?? []) {
      if (matched.has(id)) continue;
      const listing = all.find((item) => item.id === id);
      if (!listing || !categoryMatches(tree, listing, filters.category) || !priceMatches(listing, filters)) continue;
      matched.set(listing.id, listing);
    }
    const listings = [...matched.values()].sort((a, b) => compareListings(filters.sort, a, b));
    if (page === "invalid" || !inRange(page, listings.length)) {
      c.set("obs", {
        action: "error",
        query: filters.q || null,
        filters: filtersOf(filters, pageLabel || "1"),
        resultIds: [],
        resultCount: 0,
        empty: true,
        categoryId: filters.category || null,
      });
      return c.html(frictionMessagePage(tree, user, "Not found", "That page is outside these results."), 404);
    }
    const slice = slicePage(listings, page);
    c.set("obs", {
      action: searchAction(filters),
      query: filters.q || null,
      filters: filtersOf(filters, String(page)),
      resultIds: slice.map((listing) => listing.id),
      resultCount: slice.length,
      empty: slice.length === 0,
      categoryId: filters.category || null,
    });
    return c.html(frictionSearchPage(tree, filters, slice, page, listings.length, user, null));
  });

  app.post("/cart", async (c) => {
    const { tree, user } = await shell(c);
    const body = await c.req.parseBody();
    const requested = field(body.listing_id);
    const listing = requested ? await listingById(c.env.DB, requested) : null;
    const sessionId = c.get("sessionId");
    if (!listing || !sessionId) {
      c.set("obs", { action: "error", listingId: requested || null, resultIds: [], resultCount: 0, empty: true });
      return c.html(frictionMessagePage(tree, user, "Not found", "That listing is not in the catalog."), 404);
    }
    if (friction.out_of_stock.includes(listing.id) || listing.stock <= 0) {
      c.set("obs", {
        action: "error",
        listingId: listing.id,
        categoryId: listing.category_id,
        sellerId: listing.seller_id,
        resultIds: [],
        resultCount: 0,
        empty: true,
      });
      return c.html(
        frictionMessagePage(tree, user, "Out of stock", "Out of stock.", {
          href: `/listing/${listing.id}`,
          label: "Back to the listing",
        }),
        409,
      );
    }
    if (friction.requires_color.includes(listing.id) && !field(body.color)) {
      c.set("obs", {
        action: "error",
        listingId: listing.id,
        categoryId: listing.category_id,
        sellerId: listing.seller_id,
        resultIds: [],
        resultCount: 0,
        empty: true,
      });
      return c.html(
        frictionMessagePage(tree, user, "Choose a color", "Choose a color before adding this item.", {
          href: `/listing/${listing.id}`,
          label: "Back to the listing",
        }),
        400,
      );
    }
    const qty = clampQty(body.qty, listing.stock);
    await c.env.DB.prepare(
      `INSERT INTO carts (session_id, listing_id, qty) VALUES (?, ?, ?)
       ON CONFLICT(session_id, listing_id) DO UPDATE SET qty = excluded.qty`,
    )
      .bind(sessionId, listing.id, qty)
      .run();
    c.set("obs", { action: "cart_add", listingId: listing.id, resultIds: [listing.id], resultCount: 1, empty: false });
    return c.redirect("/cart", 302);
  });
}
