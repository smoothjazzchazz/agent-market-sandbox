import type { CategoryRow, Filters, ListingRow, UserRow } from "./shop-data";
import { esc, money } from "./shop-data";
import { layout } from "./render";

export const PAGE_SIZE = 8;

export function pageHref(path: string, params: Record<string, string>, page: number): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  if (page > 1) search.set("page", String(page));
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function pager(hrefFor: (page: number) => string, page: number, total: number): string {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return "";
  const prev = page > 1 ? `<a href="${esc(hrefFor(page - 1))}">Previous</a>` : "";
  const next = page < pages ? `<a href="${esc(hrefFor(page + 1))}">Next</a>` : "";
  return `<nav class="pager" aria-label="Pages">${prev}<span>Page ${page} of ${pages}</span>${next}</nav>`;
}

function cards(listings: ListingRow[]): string {
  if (listings.length === 0) return `<p class="empty">No listings matched.</p>`;
  return `<ul class="cards">${listings
    .map(
      (listing) => `<li>
        <a href="/listing/${esc(listing.id)}">${esc(listing.title)}</a>
        <p>${esc(listing.description)}</p>
        <p class="price">${money(listing.price_cents)} · ${esc(listing.seller_name)}</p>
      </li>`,
    )
    .join("")}</ul>`;
}

function searchForm(filters: Filters, categories: CategoryRow[]): string {
  const options = [`<option value="">All departments</option>`]
    .concat(
      categories.map((category) => {
        const selected = filters.category === category.id ? " selected" : "";
        return `<option value="${esc(category.id)}"${selected}>${esc(category.name)}</option>`;
      }),
    )
    .join("");
  const sorts = [
    ["price_asc", "Price, low to high"],
    ["price_desc", "Price, high to low"],
    ["title", "Name"],
  ]
    .map(([value, label]) => {
      const selected = filters.sort === value ? " selected" : "";
      return `<option value="${value}"${selected}>${label}</option>`;
    })
    .join("");
  return `<form class="filters" method="get" action="/search">
    <label>Search <input name="q" value="${esc(filters.q)}" type="search"></label>
    <label>Department <select name="category">${options}</select></label>
    <label>Min price <input name="min" value="${esc(filters.min)}" inputmode="decimal"></label>
    <label>Max price <input name="max" value="${esc(filters.max)}" inputmode="decimal"></label>
    <label>Sort <select name="sort">${sorts}</select></label>
    <button type="submit">Apply</button>
  </form>`;
}

export function departmentPage(
  categories: CategoryRow[],
  parent: CategoryRow,
  children: CategoryRow[],
  user: UserRow | null,
): string {
  const links = children
    .map(
      (child) =>
        `<li><a href="/c/${esc(parent.id)}/${esc(child.id)}">${esc(child.name)}</a></li>`,
    )
    .join("");
  return layout({
    title: parent.name,
    categories,
    user,
    body: `<h1>${esc(parent.name)}</h1>
      <p>Choose a category.</p>
      <ul class="dept-list">${links}</ul>`,
  });
}

export function subcategoryPage(
  categories: CategoryRow[],
  parent: CategoryRow,
  current: CategoryRow,
  listings: ListingRow[],
  page: number,
  total: number,
  user: UserRow | null,
): string {
  const path = `/c/${parent.id}/${current.id}`;
  return layout({
    title: current.name,
    categories,
    user,
    body: `<p class="crumb"><a href="/c/${esc(parent.id)}">${esc(parent.name)}</a> / ${esc(current.name)}</p>
      <h1>${esc(current.name)}</h1>
      ${cards(listings)}
      ${pager((next) => pageHref(path, {}, next), page, total)}`,
  });
}

export function frictionSearchPage(
  categories: CategoryRow[],
  filters: Filters,
  listings: ListingRow[],
  page: number,
  total: number,
  user: UserRow | null,
  notice: string | null,
): string {
  const params = {
    q: filters.q,
    category: filters.category,
    min: filters.min,
    max: filters.max,
    sort: filters.sort,
  };
  const results = notice
    ? ""
    : `<p>${total} listing${total === 1 ? "" : "s"}.</p>${cards(listings)}${pager(
        (next) => pageHref("/search", params, next),
        page,
        total,
      )}`;
  return layout({
    title: "Search",
    categories,
    user,
    body: `<h1>Search</h1>${searchForm(filters, categories)}${notice ? `<p class="warn">${esc(notice)}</p>` : ""}${results}`,
  });
}

export function frictionMessagePage(
  categories: CategoryRow[],
  user: UserRow | null,
  title: string,
  message: string,
  back?: { href: string; label: string },
): string {
  const link = back ? `<p><a href="${esc(back.href)}">${esc(back.label)}</a></p>` : "";
  return layout({
    title,
    categories,
    user,
    body: `<h1>${esc(title)}</h1><p class="warn">${esc(message)}</p>${link}`,
  });
}

export function frictionListingPage(
  categories: CategoryRow[],
  listing: ListingRow,
  category: CategoryRow,
  parent: CategoryRow | null,
  user: UserRow | null,
  options: {
    outOfStock: boolean;
    requiresColor: boolean;
    ambiguous: Array<{ id: string; title: string }>;
  },
): string {
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "/" },
      parent ? { "@type": "ListItem", position: 2, name: parent.name, item: `/c/${parent.id}` } : null,
      {
        "@type": "ListItem",
        position: parent ? 3 : 2,
        name: category.name,
        item: parent ? `/c/${parent.id}/${category.id}` : `/c/${category.id}`,
      },
      { "@type": "ListItem", position: parent ? 4 : 3, name: listing.title },
    ].filter(Boolean),
  };
  const product = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: listing.title,
    description: listing.description,
    sku: listing.id,
    offers: {
      "@type": "Offer",
      priceCurrency: "USD",
      price: (listing.price_cents / 100).toFixed(2),
      availability: options.outOfStock || listing.stock <= 0 ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
    },
  };
  const parentLink = parent ? `<a href="/c/${esc(parent.id)}">${esc(parent.name)}</a> / ` : "";
  const childHref = parent ? `/c/${esc(parent.id)}/${esc(category.id)}` : `/c/${esc(category.id)}`;
  const note =
    options.ambiguous.length === 0
      ? ""
      : `<p class="note">Another listing shares this name. ${options.ambiguous
          .map((other) => `<a href="/listing/${esc(other.id)}">${esc(other.title)}</a>`)
          .join(", ")}</p>`;
  const availability = options.outOfStock
    ? `<p class="warn">Out of stock.</p><p>Sold by <a href="/sellers/${esc(listing.seller_id)}">${esc(listing.seller_name)}</a></p>`
    : `<p>Sold by <a href="/sellers/${esc(listing.seller_id)}">${esc(listing.seller_name)}</a> · ${listing.stock} in stock</p>`;
  const color = options.requiresColor
    ? `<label>Color <select name="color"><option value="">Select a color</option><option>Sand</option><option>Navy</option><option>Black</option><option>Oat</option></select></label>`
    : "";
  return layout({
    title: listing.title,
    categories,
    user,
    jsonLd: [breadcrumb, product],
    body: `<p class="crumb"><a href="/">Home</a> / ${parentLink}<a href="${childHref}">${esc(category.name)}</a></p>
      <h1>${esc(listing.title)}</h1>
      ${note}
      <p class="price">${money(listing.price_cents)}</p>
      <p>${esc(listing.description)}</p>
      ${availability}
      <form method="post" action="/cart">
        <input type="hidden" name="listing_id" value="${esc(listing.id)}">
        ${color}
        <label>Quantity <input name="qty" type="number" min="1" max="${listing.stock}" value="1"></label>
        <button type="submit">Add to cart</button>
      </form>
      <p><a href="/listing/${esc(listing.id)}/similar">Similar items</a></p>`,
  });
}
