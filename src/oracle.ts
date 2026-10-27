import type { ObservedEvent } from "../analysis/observed";
import { catalog, categoryById, listingById, type StudyTask } from "./catalog";

export type OracleResult = {
  pass: boolean;
  reason: string;
  detail: Record<string, unknown>;
};

function filtersExclude(event: ObservedEvent, listingIds: string[]): boolean {
  const filters = event.filters ?? {};
  return listingIds.every((id) => {
    const listing = listingById(id);
    if (!listing) return true;
    if (filters.category) {
      const category = categoryById(listing.category_id);
      const matches =
        listing.category_id === filters.category || category?.parent_id === filters.category;
      if (!matches) return true;
    }
    const min = filters.min ? Number(filters.min) : null;
    const max = filters.max ? Number(filters.max) : null;
    if (min != null && Number.isFinite(min) && listing.price_cents < Math.round(min * 100)) return true;
    if (max != null && Number.isFinite(max) && listing.price_cents > Math.round(max * 100)) return true;
    if (filters.q) {
      const haystack = `${listing.title} ${listing.description}`.toLowerCase();
      if (!haystack.includes(filters.q.toLowerCase())) return true;
    }
    return false;
  });
}

function retrievalMiss(events: ObservedEvent[], expected: string[]): OracleResult {
  const retrievals = events.filter((event) => event.action === "search" || event.action === "filter");
  const detail = { expected_listing_ids: expected, retrievals: retrievals.length };
  if (retrievals.length > 0 && retrievals.every((event) => filtersExclude(event, expected))) {
    return { pass: false, reason: "filter_invalid", detail };
  }
  if (retrievals.length > 0 && retrievals.every((event) => event.empty === true || event.result_count === 0)) {
    return { pass: false, reason: "retrieval_empty", detail };
  }
  return { pass: false, reason: "retrieval_miss", detail };
}

export async function evaluateOracle(db: D1Database, task: StudyTask, events: ObservedEvent[]): Promise<OracleResult> {
  if (task.oracle === "order") {
    const listingId = task.expected_listing_ids[0];
    const listing = listingById(listingId);
    const buyerId = task.buyer_id;
    const order = buyerId
      ? await db
          .prepare(
            `SELECT o.id, o.user_id, o.total_cents, oi.price_cents, oi.qty
             FROM orders o JOIN order_items oi ON oi.order_id = o.id
             WHERE o.user_id = ? AND oi.listing_id = ?`,
          )
          .bind(buyerId, listingId)
          .first<{ id: string; user_id: string; total_cents: number; price_cents: number; qty: number }>()
      : null;
    const buyer = buyerId
      ? await db.prepare("SELECT wallet_cents FROM users WHERE id = ?").bind(buyerId).first<{ wallet_cents: number }>()
      : null;
    const seedWallet = catalog.users.find((user) => user.id === buyerId)?.wallet_cents ?? null;
    if (order && listing && buyer && seedWallet != null) {
      if (order.price_cents !== listing.price_cents) {
        return { pass: false, reason: "citation_unsupported", detail: { order_id: order.id } };
      }
      const expectedWallet = seedWallet - order.total_cents;
      if (buyer.wallet_cents === expectedWallet && order.total_cents === listing.price_cents * order.qty) {
        return { pass: true, reason: "pass", detail: { order_id: order.id } };
      }
    }
    const started = events.some((event) =>
      event.action === "cart_add" || event.action === "checkout_step" || event.action === "checkout_complete",
    );
    return {
      pass: false,
      reason: started ? "checkout_abandon" : "retrieval_miss",
      detail: { listing_id: listingId },
    };
  }

  const opened = events.filter(
    (event) =>
      event.action === "listing_open" &&
      event.listing_id != null &&
      task.expected_listing_ids.includes(event.listing_id),
  );
  if (opened.length > 0) {
    const mismatch = opened.some((event) => {
      const listing = event.listing_id ? listingById(event.listing_id) : undefined;
      return !listing || event.served_price_cents !== listing.price_cents || event.served_title !== listing.title;
    });
    if (mismatch) return { pass: false, reason: "citation_unsupported", detail: { opened: opened.map((event) => event.listing_id) } };
    return { pass: true, reason: "pass", detail: { opened: opened.map((event) => event.listing_id) } };
  }
  return retrievalMiss(events, task.expected_listing_ids);
}
