export type ListingRow = {
  id: string;
  seller_id: string;
  category_id: string;
  title: string;
  description: string;
  price_cents: number;
  stock: number;
  seller_name: string;
};

export type UserRow = {
  id: string;
  name: string;
  kind: string;
  bio: string;
  wallet_cents: number;
};

export type CategoryRow = {
  id: string;
  name: string;
  parent_id: string | null;
};

export type CartRow = ListingRow & { qty: number };

export type OrderRow = {
  id: string;
  user_id: string;
  total_cents: number;
  ship_name: string;
  ship_address: string;
  ship_city: string;
  ship_postal: string;
  created_at: number;
};

export type Filters = {
  q: string;
  category: string;
  min: string;
  max: string;
  sort: string;
};

export function readFilters(url: URL): Filters {
  const sort = url.searchParams.get("sort")?.trim() || "price_asc";
  return {
    q: url.searchParams.get("q")?.trim() || "",
    category: url.searchParams.get("category")?.trim() || "",
    min: url.searchParams.get("min")?.trim() || "",
    max: url.searchParams.get("max")?.trim() || "",
    sort: sort === "price_desc" || sort === "title" ? sort : "price_asc",
  };
}

export function dollarsToCents(raw: string): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function categories(db: D1Database): Promise<CategoryRow[]> {
  const rows = await db.prepare("SELECT id, name, parent_id FROM categories ORDER BY name ASC").all<CategoryRow>();
  return rows.results;
}

export async function buyers(db: D1Database): Promise<UserRow[]> {
  const rows = await db
    .prepare("SELECT id, name, kind, bio, wallet_cents FROM users WHERE kind = 'buyer' ORDER BY name ASC")
    .all<UserRow>();
  return rows.results;
}

export async function userById(db: D1Database, id: string): Promise<UserRow | null> {
  return db
    .prepare("SELECT id, name, kind, bio, wallet_cents FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
}

export async function searchListings(db: D1Database, filters: Filters): Promise<ListingRow[]> {
  const clauses = ["1 = 1"];
  const binds: Array<string | number> = [];
  if (filters.category) {
    clauses.push(
      "(l.category_id = ? OR l.category_id IN (SELECT id FROM categories WHERE parent_id = ?))",
    );
    binds.push(filters.category, filters.category);
  }
  const minCents = dollarsToCents(filters.min);
  const maxCents = dollarsToCents(filters.max);
  if (minCents != null) {
    clauses.push("l.price_cents >= ?");
    binds.push(minCents);
  }
  if (maxCents != null) {
    clauses.push("l.price_cents <= ?");
    binds.push(maxCents);
  }
  if (filters.q) {
    const like = `%${filters.q.toLowerCase()}%`;
    clauses.push("(lower(l.title) LIKE ? OR lower(l.description) LIKE ?)");
    binds.push(like, like);
  }
  const order =
    filters.sort === "price_desc"
      ? "l.price_cents DESC, l.id ASC"
      : filters.sort === "title"
        ? "l.title ASC, l.id ASC"
        : "l.price_cents ASC, l.id ASC";
  const sql = `
    SELECT l.id, l.seller_id, l.category_id, l.title, l.description, l.price_cents, l.stock, u.name AS seller_name
    FROM listings l
    JOIN users u ON u.id = l.seller_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY ${order}
  `;
  const rows = await db.prepare(sql).bind(...binds).all<ListingRow>();
  return rows.results;
}

export async function listingById(db: D1Database, id: string): Promise<ListingRow | null> {
  return db
    .prepare(
      `SELECT l.id, l.seller_id, l.category_id, l.title, l.description, l.price_cents, l.stock, u.name AS seller_name
       FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`,
    )
    .bind(id)
    .first<ListingRow>();
}

export async function listingsForSeller(db: D1Database, sellerId: string): Promise<ListingRow[]> {
  const rows = await db
    .prepare(
      `SELECT l.id, l.seller_id, l.category_id, l.title, l.description, l.price_cents, l.stock, u.name AS seller_name
       FROM listings l JOIN users u ON u.id = l.seller_id
       WHERE l.seller_id = ? ORDER BY l.title ASC, l.id ASC`,
    )
    .bind(sellerId)
    .all<ListingRow>();
  return rows.results;
}

export async function cartFor(db: D1Database, sessionId: string): Promise<CartRow[]> {
  const rows = await db
    .prepare(
      `SELECT l.id, l.seller_id, l.category_id, l.title, l.description, l.price_cents, l.stock, u.name AS seller_name, c.qty
       FROM carts c
       JOIN listings l ON l.id = c.listing_id
       JOIN users u ON u.id = l.seller_id
       WHERE c.session_id = ?
       ORDER BY l.title ASC`,
    )
    .bind(sessionId)
    .all<CartRow>();
  return rows.results;
}

export function cartTotal(items: CartRow[]): number {
  return items.reduce((sum, item) => sum + item.price_cents * item.qty, 0);
}

export async function ordersForUser(db: D1Database, userId: string): Promise<OrderRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, user_id, total_cents, ship_name, ship_address, ship_city, ship_postal, created_at
       FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<OrderRow>();
  return rows.results;
}

export async function orderById(db: D1Database, id: string): Promise<OrderRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, total_cents, ship_name, ship_address, ship_city, ship_postal, created_at
       FROM orders WHERE id = ?`,
    )
    .bind(id)
    .first<OrderRow>();
}

export async function orderItems(db: D1Database, orderId: string): Promise<Array<{ listing_id: string; title: string; price_cents: number; qty: number }>> {
  const rows = await db
    .prepare("SELECT listing_id, title, price_cents, qty FROM order_items WHERE order_id = ?")
    .bind(orderId)
    .all<{ listing_id: string; title: string; price_cents: number; qty: number }>();
  return rows.results;
}
