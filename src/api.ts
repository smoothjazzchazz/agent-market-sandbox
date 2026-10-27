import type { Hono } from "hono";
import type { AppContext } from "./env";
import {
  cartFor,
  cartTotal,
  categories,
  listingById,
  listingsForSeller,
  readFilters,
  searchListings,
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

  app.post("/api/login", async (c) => {
    const body = await c.req.json<{ user_id?: string }>().catch(() => ({ user_id: "" }));
    const user = await userById(c.env.DB, String(body.user_id ?? ""));
    c.set("obs", { action: "login" });
    if (!user || user.kind !== "buyer" || !c.get("sessionId")) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare("UPDATE sessions SET user_id = ? WHERE id = ?").bind(user.id, c.get("sessionId")).run();
    c.set("userId", user.id);
    return c.json({ user: { id: user.id, name: user.name, wallet_cents: user.wallet_cents } });
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
    const user = c.get("userId") ? await userById(c.env.DB, c.get("userId") as string) : null;
    const items = sessionId ? await cartFor(c.env.DB, sessionId) : [];
    const body = await c.req
      .json<{ ship_name?: string; ship_address?: string; ship_city?: string; ship_postal?: string }>()
      .catch(() => ({ ship_name: undefined, ship_address: undefined, ship_city: undefined, ship_postal: undefined }));
    if (!user || !sessionId) return c.json({ error: "sign_in" }, 401);
    const total = cartTotal(items);
    const shipName = String(body.ship_name ?? "").trim();
    const shipAddress = String(body.ship_address ?? "").trim();
    const shipCity = String(body.ship_city ?? "").trim();
    const shipPostal = String(body.ship_postal ?? "").trim();
    if (!shipName || !shipAddress || !shipCity || !shipPostal || items.length === 0) {
      c.set("obs", { action: "checkout_step", resultIds: items.map((item) => item.id), empty: items.length === 0 });
      return c.json({ error: "incomplete" }, 400);
    }
    if (total > user.wallet_cents) {
      c.set("obs", { action: "checkout_step", resultIds: items.map((item) => item.id) });
      return c.json({ error: "insufficient_balance" }, 409);
    }
    const orderId = crypto.randomUUID();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET wallet_cents = wallet_cents - ? WHERE id = ? AND wallet_cents >= ?").bind(total, user.id, total),
      ...items.map((item) =>
        c.env.DB.prepare("UPDATE listings SET stock = stock - ? WHERE id = ? AND stock >= ?").bind(item.qty, item.id, item.qty),
      ),
      c.env.DB.prepare(
        "INSERT INTO orders (id, user_id, session_id, total_cents, ship_name, ship_address, ship_city, ship_postal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(orderId, user.id, sessionId, total, shipName, shipAddress, shipCity, shipPostal, Date.now()),
      ...items.map((item) =>
        c.env.DB.prepare("INSERT INTO order_items (order_id, listing_id, title, price_cents, qty) VALUES (?, ?, ?, ?, ?)").bind(
          orderId,
          item.id,
          item.title,
          item.price_cents,
          item.qty,
        ),
      ),
      c.env.DB.prepare("DELETE FROM carts WHERE session_id = ?").bind(sessionId),
    ]);
    c.set("obs", {
      action: "checkout_complete",
      orderId,
      resultIds: items.map((item) => item.id),
      resultCount: items.length,
      empty: false,
    });
    return c.json({ order_id: orderId, total_cents: total });
  });
}
