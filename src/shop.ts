import type { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { categoryById } from "./catalog";
import type { AppContext } from "./env";
import {
  accountPage,
  cartPage,
  categoryPage,
  checkoutPage,
  homePage,
  listingPage,
  receiptPage,
  searchPage,
  sellerPage,
} from "./render";
import {
  buyers,
  cartFor,
  cartTotal,
  categories,
  listingById,
  listingsForSeller,
  orderById,
  orderItems,
  ordersForUser,
  readFilters,
  searchListings,
  userById,
  type CartRow,
  type UserRow,
} from "./shop-data";

async function shell(c: { env: AppContext["Bindings"]; get: (key: "userId") => string | null }) {
  const tree = await categories(c.env.DB);
  const userId = c.get("userId");
  const user = userId ? await userById(c.env.DB, userId) : null;
  return { tree, user };
}

function filtersOf(filters: ReturnType<typeof readFilters>): Record<string, string> {
  return {
    q: filters.q,
    category: filters.category,
    min: filters.min,
    max: filters.max,
    sort: filters.sort,
  };
}

export function registerShop(app: Hono<AppContext>): void {
  app.get("/t/:id", async (c) => {
    const trial = await c.env.DB.prepare("SELECT id, status FROM trials WHERE id = ?")
      .bind(c.req.param("id"))
      .first<{ id: string; status: string }>();
    if (!trial || trial.status !== "open") return c.text("Not found", 404);
    const sessionId = crypto.randomUUID();
    await c.env.DB.prepare("INSERT INTO sessions (id, user_id, trial_id, created_at) VALUES (?, NULL, ?, ?)")
      .bind(sessionId, trial.id, Date.now())
      .run();
    setCookie(c, "sid", sessionId, { path: "/", httpOnly: true, sameSite: "Lax" });
    c.set("sessionId", sessionId);
    c.set("trialId", trial.id);
    c.set("userId", null);
    c.set("obs", { action: "page_view" });
    return c.redirect("/", 302);
  });

  app.get("/", async (c) => {
    const { tree, user } = await shell(c);
    const featured = await searchListings(c.env.DB, { q: "", category: "", min: "", max: "", sort: "title" });
    const slice = featured.slice(0, 8);
    c.set("obs", {
      action: "page_view",
      resultIds: slice.map((listing) => listing.id),
      resultCount: slice.length,
      empty: slice.length === 0,
    });
    return c.html(homePage(tree, slice, user));
  });

  app.get("/c/:parent", async (c) => {
    const { tree, user } = await shell(c);
    const current = tree.find((category) => category.id === c.req.param("parent") && category.parent_id == null);
    if (!current) return c.text("Not found", 404);
    const listings = await searchListings(c.env.DB, {
      q: "",
      category: current.id,
      min: "",
      max: "",
      sort: "title",
    });
    c.set("obs", {
      action: "page_view",
      categoryId: current.id,
      resultIds: listings.map((listing) => listing.id),
      resultCount: listings.length,
      empty: listings.length === 0,
    });
    return c.html(categoryPage(tree, current, null, listings, user));
  });

  app.get("/c/:parent/:sub", async (c) => {
    const { tree, user } = await shell(c);
    const parent = tree.find((category) => category.id === c.req.param("parent") && category.parent_id == null);
    const current = tree.find((category) => category.id === c.req.param("sub") && category.parent_id === parent?.id);
    if (!parent || !current) return c.text("Not found", 404);
    const listings = await searchListings(c.env.DB, {
      q: "",
      category: current.id,
      min: "",
      max: "",
      sort: "title",
    });
    c.set("obs", {
      action: "page_view",
      categoryId: current.id,
      resultIds: listings.map((listing) => listing.id),
      resultCount: listings.length,
      empty: listings.length === 0,
    });
    return c.html(categoryPage(tree, current, parent, listings, user));
  });

  app.get("/search", async (c) => {
    const { tree, user } = await shell(c);
    const filters = readFilters(new URL(c.req.url));
    const listings = await searchListings(c.env.DB, filters);
    const action = filters.q ? "search" : filters.category || filters.min || filters.max ? "filter" : "search";
    c.set("obs", {
      action,
      query: filters.q || null,
      filters: filtersOf(filters),
      resultIds: listings.map((listing) => listing.id),
      resultCount: listings.length,
      empty: listings.length === 0,
      categoryId: filters.category || null,
    });
    return c.html(searchPage(tree, filters, listings, user));
  });

  app.get("/listing/:id", async (c) => {
    const { tree, user } = await shell(c);
    const listing = await listingById(c.env.DB, c.req.param("id"));
    if (!listing) return c.text("Not found", 404);
    const category = tree.find((item) => item.id === listing.category_id) ?? categoryById(listing.category_id);
    if (!category) return c.text("Not found", 404);
    const parent = category.parent_id ? tree.find((item) => item.id === category.parent_id) ?? null : null;
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
    return c.html(listingPage(tree, listing, category, parent ?? null, user));
  });

  app.get("/sellers/:id", async (c) => {
    const { tree, user } = await shell(c);
    const seller = await userById(c.env.DB, c.req.param("id"));
    if (!seller || seller.kind !== "seller") return c.text("Not found", 404);
    const listings = await listingsForSeller(c.env.DB, seller.id);
    c.set("obs", {
      action: "profile_view",
      sellerId: seller.id,
      resultIds: listings.map((listing) => listing.id),
      resultCount: listings.length,
      empty: listings.length === 0,
    });
    return c.html(sellerPage(tree, seller, listings, user));
  });

  app.get("/account", async (c) => {
    const { tree, user } = await shell(c);
    const choices = await buyers(c.env.DB);
    const orders = user ? await ordersForUser(c.env.DB, user.id) : [];
    c.set("obs", { action: "page_view" });
    return c.html(accountPage(tree, user, choices, orders, new URL(c.req.url).searchParams.get("error") === "1"));
  });

  app.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const user = await userById(c.env.DB, String(body.user_id ?? ""));
    c.set("obs", { action: "login" });
    if (!user || user.kind !== "buyer" || !c.get("sessionId")) return c.redirect("/account?error=1", 302);
    await c.env.DB.prepare("UPDATE sessions SET user_id = ? WHERE id = ?").bind(user.id, c.get("sessionId")).run();
    c.set("userId", user.id);
    return c.redirect("/account", 302);
  });

  app.get("/cart", async (c) => {
    const { tree, user } = await shell(c);
    const items = c.get("sessionId") ? await cartFor(c.env.DB, c.get("sessionId") as string) : [];
    c.set("obs", {
      action: "page_view",
      resultIds: items.map((item) => item.id),
      resultCount: items.length,
      empty: items.length === 0,
    });
    return c.html(cartPage(tree, items, user));
  });

  app.post("/cart/add", async (c) => {
    const body = await c.req.parseBody();
    const listing = await listingById(c.env.DB, String(body.listing_id ?? ""));
    const sessionId = c.get("sessionId");
    if (!listing || !sessionId) return c.text("Not found", 404);
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

  app.post("/cart/remove", async (c) => {
    const body = await c.req.parseBody();
    const sessionId = c.get("sessionId");
    if (sessionId) {
      await c.env.DB.prepare("DELETE FROM carts WHERE session_id = ? AND listing_id = ?")
        .bind(sessionId, String(body.listing_id ?? ""))
        .run();
    }
    c.set("obs", { action: "page_view", listingId: String(body.listing_id ?? "") || null });
    return c.redirect("/cart", 302);
  });

  app.get("/checkout", async (c) => {
    const { tree, user } = await shell(c);
    const items = c.get("sessionId") ? await cartFor(c.env.DB, c.get("sessionId") as string) : [];
    c.set("obs", { action: "checkout_step", resultIds: items.map((item) => item.id), resultCount: items.length, empty: items.length === 0 });
    return c.html(checkoutPage(tree, items, user, items.length === 0 ? "Your cart is empty." : null));
  });

  app.post("/checkout", async (c) => {
    const { tree, user } = await shell(c);
    const sessionId = c.get("sessionId");
    const items = sessionId ? await cartFor(c.env.DB, sessionId) : [];
    if (!user || !sessionId) {
      c.set("obs", { action: "checkout_step" });
      return c.redirect("/account", 302);
    }
    const body = await c.req.parseBody();
    const ship = {
      name: String(body.ship_name ?? "").trim(),
      address: String(body.ship_address ?? "").trim(),
      city: String(body.ship_city ?? "").trim(),
      postal: String(body.ship_postal ?? "").trim(),
    };
    const total = cartTotal(items);
    if (items.length === 0 || !ship.name || !ship.address || !ship.city || !ship.postal) {
      c.set("obs", { action: "checkout_step", resultIds: items.map((item) => item.id) });
      return c.html(checkoutPage(tree, items, user, "Enter a shipping name, address, city, and postal code."), 400);
    }
    if (items.some((item) => item.qty > item.stock) || total > user.wallet_cents) {
      c.set("obs", { action: "checkout_step", resultIds: items.map((item) => item.id) });
      return c.html(checkoutPage(tree, items, user, "Wallet balance is too low for this order."), 200);
    }
    const orderId = await placeOrder(c.env.DB, user, sessionId, items, ship, total);
    c.set("obs", {
      action: "checkout_complete",
      orderId,
      resultIds: items.map((item) => item.id),
      resultCount: items.length,
      empty: false,
    });
    return c.redirect(`/orders/${orderId}`, 302);
  });

  app.get("/orders/:id", async (c) => {
    const { tree, user } = await shell(c);
    const order = await orderById(c.env.DB, c.req.param("id"));
    if (!order || !user || order.user_id !== user.id) return c.text("Not found", 404);
    const items = await orderItems(c.env.DB, order.id);
    c.set("obs", {
      action: "page_view",
      orderId: order.id,
      resultIds: items.map((item) => item.listing_id),
      resultCount: items.length,
    });
    return c.html(receiptPage(tree, order, items, user));
  });

  app.get("/robots.txt", (c) => {
    c.set("obs", { action: "page_view" });
    return c.text("User-agent: *\nAllow: /\n");
  });

  app.get("/sitemap.xml", async (c) => {
    const tree = await categories(c.env.DB);
    const listings = await searchListings(c.env.DB, { q: "", category: "", min: "", max: "", sort: "title" });
    const origin = new URL(c.req.url).origin;
    const urls = ["/", ...tree.map((category) => (category.parent_id ? `/c/${category.parent_id}/${category.id}` : `/c/${category.id}`)), ...listings.map((listing) => `/listing/${listing.id}`)];
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((path) => `<url><loc>${origin}${path}</loc></url>`)
      .join("\n")}\n</urlset>\n`;
    c.set("obs", { action: "page_view", resultCount: urls.length });
    return c.text(body, 200, { "content-type": "application/xml; charset=utf-8" });
  });

  app.get("/assets/*", async (c) => {
    c.set("obs", { action: "page_view" });
    return c.env.ASSETS.fetch(c.req.raw);
  });
}

function clampQty(value: unknown, stock: number): number {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(stock, Math.floor(parsed)));
}

async function placeOrder(
  db: D1Database,
  user: UserRow,
  sessionId: string,
  items: CartRow[],
  ship: { name: string; address: string; city: string; postal: string },
  total: number,
): Promise<string> {
  const orderId = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE users SET wallet_cents = wallet_cents - ? WHERE id = ? AND wallet_cents >= ?").bind(total, user.id, total),
    ...items.map((item) =>
      db.prepare("UPDATE listings SET stock = stock - ? WHERE id = ? AND stock >= ?").bind(item.qty, item.id, item.qty),
    ),
    db
      .prepare(
        "INSERT INTO orders (id, user_id, session_id, total_cents, ship_name, ship_address, ship_city, ship_postal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(orderId, user.id, sessionId, total, ship.name, ship.address, ship.city, ship.postal, now),
    ...items.map((item) =>
      db
        .prepare("INSERT INTO order_items (order_id, listing_id, title, price_cents, qty) VALUES (?, ?, ?, ?, ?)")
        .bind(orderId, item.id, item.title, item.price_cents, item.qty),
    ),
    db.prepare("DELETE FROM carts WHERE session_id = ?").bind(sessionId),
  ]);
  return orderId;
}
