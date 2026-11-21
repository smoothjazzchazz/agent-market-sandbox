import { catalog } from "./catalog";
import type { Env } from "./env";
import { SCHEMA } from "./schema";

let ready: Promise<void> | null = null;

function startInit(env: Env): Promise<void> {
  ready = init(env).catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

export async function ensureReady(env: Env): Promise<void> {
  if (!ready) await startInit(env);
  else await ready;
  const sessions = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
  ).first<{ name: string }>();
  if (!sessions) await startInit(env);
}

async function applySchema(env: Env): Promise<void> {
  for (const statement of SCHEMA.split(";")) {
    const sql = statement.trim();
    if (sql) await env.DB.prepare(sql).run();
  }
}

async function ensureGuestWallet(db: D1Database): Promise<void> {
  const info = await db.prepare("PRAGMA table_info(sessions)").all<{ name: string }>();
  if (info.results.some((column) => column.name === "wallet_cents")) return;
  await db.prepare("ALTER TABLE sessions ADD COLUMN wallet_cents INTEGER NOT NULL DEFAULT 8000").run();
}

async function init(env: Env): Promise<void> {
  await applySchema(env);
  await ensureGuestWallet(env.DB);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM listings").first<{ n: number }>();
  if (!row || row.n === 0) await seedCatalog(env.DB);
}

export async function resetWorld(env: Env): Promise<void> {
  await applySchema(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM order_items"),
    env.DB.prepare("DELETE FROM orders"),
    env.DB.prepare("DELETE FROM carts"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM listings"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM categories"),
  ]);
  await seedCatalog(env.DB);
}

async function seedCatalog(db: D1Database): Promise<void> {
  const statements = [
    ...catalog.categories.map((category) =>
      db
        .prepare("INSERT INTO categories (id, name, parent_id) VALUES (?, ?, ?)")
        .bind(category.id, category.name, category.parent_id),
    ),
    ...catalog.users.map((user) =>
      db
        .prepare("INSERT INTO users (id, name, kind, bio, wallet_cents) VALUES (?, ?, ?, ?, ?)")
        .bind(user.id, user.name, user.kind, user.bio, user.wallet_cents),
    ),
    ...catalog.listings.map((listing) =>
      db
        .prepare(
          "INSERT INTO listings (id, seller_id, category_id, title, description, price_cents, stock) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          listing.id,
          listing.seller_id,
          listing.category_id,
          listing.title,
          listing.description,
          listing.price_cents,
          listing.stock,
        ),
    ),
  ];
  const size = 40;
  for (let index = 0; index < statements.length; index += size) {
    await db.batch(statements.slice(index, index + size));
  }
}
