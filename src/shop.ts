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
  cartFor,
  cartTotal,
  categories,
  GUEST_WALLET_CENTS,
  listingById,
  listingsForSeller,
  normalizeShip,
  orderById,
  orderItems,
  ordersForSession,
  placeGuestOrder,
  readFilters,
  searchListings,
  sessionWallet,
  shippingAcceptable,
  userById,
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
    await c.env.DB.prepare(
      "INSERT INTO sessions (id, user_id, trial_id, created_at, wallet_cents) VALUES (?, NULL, ?, ?, ?)",
    )
      .bind(sessionId, trial.id, Date.now(), GUEST_WALLET_CENTS)
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
    const sessionId = c.get("sessionId");
    const wallet = sessionId ? ((await sessionWallet(c.env.DB, sessionId)) ?? GUEST_WALLET_CENTS) : GUEST_WALLET_CENTS;
    const orders = sessionId ? await ordersForSession(c.env.DB, sessionId) : [];
    c.set("obs", { action: "page_view" });
    return c.html(accountPage(tree, user, wallet, orders));
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
    const sessionId = c.get("sessionId");
    const items = sessionId ? await cartFor(c.env.DB, sessionId) : [];
    const wallet = sessionId ? ((await sessionWallet(c.env.DB, sessionId)) ?? GUEST_WALLET_CENTS) : GUEST_WALLET_CENTS;
    c.set("obs", { action: "checkout_step", resultIds: items.map((item) => item.id), resultCount: items.length, empty: items.length === 0 });
    return c.html(checkoutPage(tree, items, user, wallet, items.length === 0 ? "Your cart is empty." : null));
  });

  app.post("/checkout", async (c) => {
    const { tree, user } = await shell(c);
    const sessionId = c.get("sessionId");
    const items = sessionId ? await cartFor(c.env.DB, sessionId) : [];
    const wallet = sessionId ? ((await sessionWallet(c.env.DB, sessionId)) ?? GUEST_WALLET_CENTS) : GUEST_WALLET_CENTS;
    const ship = normalizeShip(await c.req.parseBody());
    const ids = items.map((item) => item.id);
    const fail = (message: string, status: 400 | 200) => {
      c.set("obs", { action: "checkout_step", resultIds: ids, resultCount: items.length, empty: items.length === 0 });
      return c.html(checkoutPage(tree, items, user, wallet, message), status);
    };
    if (!sessionId) return fail("Open the shop to start a guest session.", 400);
    if (items.length === 0) return fail("Your cart is empty.", 400);
    if (!shippingAcceptable(ship)) {
      return fail("Enter a shipping name, address, city, and 5-digit postal code.", 400);
    }
    if (items.some((item) => item.qty > item.stock)) return fail("Not enough stock for this order.", 200);
    const total = cartTotal(items);
    if (total > wallet) return fail("Wallet balance is too low for this order.", 200);
    const orderId = await placeGuestOrder(c.env.DB, sessionId, items, ship, total);
    c.set("obs", {
      action: "checkout_complete",
      orderId,
      resultIds: ids,
      resultCount: items.length,
      empty: false,
    });
    return c.redirect(`/orders/${orderId}`, 302);
  });

  app.get("/orders/:id", async (c) => {
    const { tree, user } = await shell(c);
    const order = await orderById(c.env.DB, c.req.param("id"));
    const sessionId = c.get("sessionId");
    if (!order || !sessionId || order.session_id !== sessionId) return c.text("Not found", 404);
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
