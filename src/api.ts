import type { Hono } from "hono";
import type { AppContext } from "./env";
import {
  cartFor,
  cartTotal,
  categories,
  listingById,
  listingsForSeller,
  normalizeShip,
  placeGuestOrder,
  readFilters,
  searchListings,
  sessionWallet,
  shippingAcceptable,
  userById,
  type ListingRow,
} from "./shop-data";

function listingJson(listing: ListingRow) {
  return {
    id: listing.id,
    title: listing.title,
    description: listing.description,
    price_cents: listing.price_cents,
    stock: listing.stock,
    category_id: listing.category_id,
    seller_id: listing.seller_id,
    seller_name: listing.seller_name,
  };
}

export function registerApi(app: Hono<AppContext>): void {
  app.get("/api/categories", async (c) => {
    const tree = await categories(c.env.DB);
    c.set("obs", { action: "page_view", resultCount: tree.length, empty: tree.length === 0 });
    return c.json({ categories: tree });
  });

  app.get("/api/listings", async (c) => {
    const filters = readFilters(new URL(c.req.url));
    const listings = await searchListings(c.env.DB, filters);
    const action = filters.q ? "search" : "filter";
    c.set("obs", {
      action,
      query: filters.q || null,
      filters: { q: filters.q, category: filters.category, min: filters.min, max: filters.max, sort: filters.sort },
      resultIds: listings.map((listing) => listing.id),
      resultCount: listings.length,
      empty: listings.length === 0,
      categoryId: filters.category || null,
    });
    return c.json({ listings: listings.map(listingJson) });
  });

  app.get("/api/listings/:id", async (c) => {
    const listing = await listingById(c.env.DB, c.req.param("id"));
    if (!listing) return c.json({ error: "not_found" }, 404);
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
    return c.json({ listing: listingJson(listing) });
  });

  app.get("/api/sellers/:id", async (c) => {
    const seller = await userById(c.env.DB, c.req.param("id"));
    if (!seller || seller.kind !== "seller") return c.json({ error: "not_found" }, 404);
    const listings = await listingsForSeller(c.env.DB, seller.id);
    c.set("obs", {
      action: "profile_view",
      sellerId: seller.id,
      resultIds: listings.map((listing) => listing.id),
      resultCount: listings.length,
      empty: listings.length === 0,
    });
    return c.json({
      seller: { id: seller.id, name: seller.name, bio: seller.bio },
      listings: listings.map(listingJson),
    });
  });

  app.post("/api/cart", async (c) => {
    const body = await c.req.json<{ listing_id?: string; qty?: number }>().catch(() => ({ listing_id: "" as string | undefined, qty: undefined as number | undefined }));
    const listing = await listingById(c.env.DB, String(body.listing_id ?? ""));
    const sessionId = c.get("sessionId");
    if (!listing || !sessionId) return c.json({ error: "not_found" }, 404);
    const qty = Math.max(1, Math.min(listing.stock, Math.floor(Number(body.qty ?? 1)) || 1));
    await c.env.DB.prepare(
      `INSERT INTO carts (session_id, listing_id, qty) VALUES (?, ?, ?)
       ON CONFLICT(session_id, listing_id) DO UPDATE SET qty = excluded.qty`,
    )
      .bind(sessionId, listing.id, qty)
      .run();
    c.set("obs", { action: "cart_add", listingId: listing.id, resultIds: [listing.id], resultCount: 1, empty: false });
    return c.json({ listing_id: listing.id, qty });
  });

  app.post("/api/checkout", async (c) => {
    const sessionId = c.get("sessionId");
    const items = sessionId ? await cartFor(c.env.DB, sessionId) : [];
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const ship = normalizeShip(body);
    const ids = items.map((item) => item.id);
    const reject = (error: string, status: 400 | 409) => {
      c.set("obs", { action: "checkout_step", resultIds: ids, resultCount: items.length, empty: items.length === 0 });
      return c.json({ error }, status);
    };
    if (!sessionId) return reject("no_session", 400);
    if (items.length === 0) return reject("empty_cart", 400);
    if (!shippingAcceptable(ship)) return reject("invalid_shipping", 400);
    const wallet = await sessionWallet(c.env.DB, sessionId);
    if (wallet == null) return reject("no_session", 400);
    if (items.some((item) => item.qty > item.stock)) return reject("insufficient_stock", 409);
    const total = cartTotal(items);
    if (total > wallet) return reject("insufficient_balance", 409);
    const orderId = await placeGuestOrder(c.env.DB, sessionId, items, ship, total);
    c.set("obs", {
      action: "checkout_complete",
      orderId,
      resultIds: ids,
      resultCount: items.length,
      empty: false,
    });
    return c.json({ order_id: orderId, total_cents: total });
  });
}
