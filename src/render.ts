import type { CartRow, CategoryRow, Filters, ListingRow, OrderRow, UserRow } from "./shop-data";
import { esc, money } from "./shop-data";

function nav(categories: CategoryRow[]): string {
  const parents = categories.filter((category) => category.parent_id == null);
  const items = parents
    .map((parent) => {
      const children = categories.filter((category) => category.parent_id === parent.id);
      const sub = children
        .map(
          (child) =>
            `<li><a href="/c/${esc(parent.id)}/${esc(child.id)}">${esc(child.name)}</a></li>`,
        )
        .join("");
      return `<li><a href="/c/${esc(parent.id)}">${esc(parent.name)}</a><ul>${sub}</ul></li>`;
    })
    .join("");
  return `<nav class="menu" aria-label="Departments"><ul>${items}</ul></nav>`;
}

function searchForm(filters: Filters, categories: CategoryRow[]): string {
  const options = [`<option value="">All departments</option>`]
    .concat(
      categories.map((category) => {
        const selected = filters.category === category.id ? " selected" : "";
        const label = category.parent_id ? category.name : category.name;
        return `<option value="${esc(category.id)}"${selected}>${esc(label)}</option>`;
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

export function layout(options: {
  title: string;
  categories: CategoryRow[];
  user: UserRow | null;
  body: string;
  jsonLd?: unknown;
}): string {
  const account = options.user
    ? `<a href="/account">${esc(options.user.name)}</a>`
    : `<a href="/account">Sign in</a>`;
  const jsonLd = options.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(options.jsonLd).replaceAll("<", "\\u003c")}</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(options.title)} · Northline Market</title>
  <link rel="stylesheet" href="/assets/styles.css">
  ${jsonLd}
</head>
<body>
  <header class="top">
    <a class="brand" href="/"><img src="/assets/mark.svg" alt="" width="28" height="28"> Northline Market</a>
    <form class="quick" method="get" action="/search">
      <input name="q" type="search" placeholder="Search listings" aria-label="Search listings">
      <button type="submit">Search</button>
    </form>
    <p class="account">${account} · <a href="/cart">Cart</a></p>
  </header>
  ${nav(options.categories)}
  <main>${options.body}</main>
  <footer><p>Northline Market sells housewares, electronics, and outdoor gear. Wallet checkout stays on this shop.</p></footer>
</body>
</html>`;
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

export function homePage(categories: CategoryRow[], featured: ListingRow[], user: UserRow | null): string {
  return layout({
    title: "Home",
    categories,
    user,
    body: `<h1>Goods for the house, the desk, and the trail</h1>
      <p>Browse a department or search the catalog.</p>
      ${searchForm({ q: "", category: "", min: "", max: "", sort: "price_asc" }, categories)}
      <h2>New in the catalog</h2>
      ${cards(featured)}`,
  });
}

export function categoryPage(
  categories: CategoryRow[],
  current: CategoryRow,
  parent: CategoryRow | null,
  listings: ListingRow[],
  user: UserRow | null,
): string {
  const crumb = parent
    ? `<p class="crumb"><a href="/c/${esc(parent.id)}">${esc(parent.name)}</a> / ${esc(current.name)}</p>`
    : "";
  return layout({
    title: current.name,
    categories,
    user,
    body: `${crumb}<h1>${esc(current.name)}</h1>${cards(listings)}`,
  });
}

export function searchPage(
  categories: CategoryRow[],
  filters: Filters,
  listings: ListingRow[],
  user: UserRow | null,
): string {
  return layout({
    title: "Search",
    categories,
    user,
    body: `<h1>Search</h1>${searchForm(filters, categories)}<p>${listings.length} listing${listings.length === 1 ? "" : "s"}.</p>${cards(listings)}`,
  });
}

export function listingPage(
  categories: CategoryRow[],
  listing: ListingRow,
  category: CategoryRow,
  parent: CategoryRow | null,
  user: UserRow | null,
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
      availability: listing.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
  };
  const parentLink = parent
    ? `<a href="/c/${esc(parent.id)}">${esc(parent.name)}</a> / `
    : "";
  const childHref = parent ? `/c/${esc(parent.id)}/${esc(category.id)}` : `/c/${esc(category.id)}`;
  return layout({
    title: listing.title,
    categories,
    user,
    jsonLd: [breadcrumb, product],
    body: `<p class="crumb"><a href="/">Home</a> / ${parentLink}<a href="${childHref}">${esc(category.name)}</a></p>
      <h1>${esc(listing.title)}</h1>
      <p class="price">${money(listing.price_cents)}</p>
      <p>${esc(listing.description)}</p>
      <p>Sold by <a href="/sellers/${esc(listing.seller_id)}">${esc(listing.seller_name)}</a> · ${listing.stock} in stock</p>
      <form method="post" action="/cart/add">
        <input type="hidden" name="listing_id" value="${esc(listing.id)}">
        <label>Quantity <input name="qty" type="number" min="1" max="${listing.stock}" value="1"></label>
        <button type="submit">Add to cart</button>
      </form>`,
  });
}

export function sellerPage(
  categories: CategoryRow[],
  seller: UserRow,
  listings: ListingRow[],
  user: UserRow | null,
): string {
  return layout({
    title: seller.name,
    categories,
    user,
    body: `<h1>${esc(seller.name)}</h1><p>${esc(seller.bio)}</p><h2>Listings</h2>${cards(listings)}`,
  });
}

export function accountPage(
  categories: CategoryRow[],
  user: UserRow | null,
  buyerChoices: UserRow[],
  orders: OrderRow[],
  error: boolean,
): string {
  if (!user) {
    const options = buyerChoices
      .map((buyer) => `<option value="${esc(buyer.id)}">${esc(buyer.name)}</option>`)
      .join("");
    return layout({
      title: "Sign in",
      categories,
      user: null,
      body: `<h1>Sign in</h1>
        ${error ? `<p class="warn">Choose an account from the list.</p>` : ""}
        <form method="post" action="/login">
          <label>Account <select name="user_id">${options}</select></label>
          <button type="submit">Continue</button>
        </form>`,
    });
  }
  const history =
    orders.length === 0
      ? `<p>No orders yet.</p>`
      : `<ul>${orders
          .map(
            (order) =>
              `<li><a href="/orders/${esc(order.id)}">${esc(order.id.slice(0, 8))}</a> · ${money(order.total_cents)}</li>`,
          )
          .join("")}</ul>`;
  return layout({
    title: "Account",
    categories,
    user,
    body: `<h1>${esc(user.name)}</h1><p>${esc(user.bio)}</p><p>Wallet balance ${money(user.wallet_cents)}</p><h2>Orders</h2>${history}`,
  });
}

export function cartPage(categories: CategoryRow[], items: CartRow[], user: UserRow | null): string {
  const rows =
    items.length === 0
      ? `<p class="empty">Your cart is empty.</p>`
      : `<ul class="cart">${items
          .map(
            (item) => `<li>
              <a href="/listing/${esc(item.id)}">${esc(item.title)}</a>
              <span>${item.qty} × ${money(item.price_cents)}</span>
              <form method="post" action="/cart/remove"><input type="hidden" name="listing_id" value="${esc(item.id)}"><button type="submit">Remove</button></form>
            </li>`,
          )
          .join("")}</ul>
        <p class="price">Total ${money(items.reduce((sum, item) => sum + item.price_cents * item.qty, 0))}</p>
        <p><a href="/checkout">Checkout</a></p>`;
  return layout({ title: "Cart", categories, user, body: `<h1>Cart</h1>${rows}` });
}

export function checkoutPage(
  categories: CategoryRow[],
  items: CartRow[],
  user: UserRow | null,
  message: string | null,
): string {
  if (!user) {
    return layout({
      title: "Checkout",
      categories,
      user,
      body: `<h1>Checkout</h1><p><a href="/account">Sign in</a> to pay with a wallet balance.</p>`,
    });
  }
  const lines = items
    .map((item) => `<li>${esc(item.title)} · ${item.qty} × ${money(item.price_cents)}</li>`)
    .join("");
  const total = items.reduce((sum, item) => sum + item.price_cents * item.qty, 0);
  return layout({
    title: "Checkout",
    categories,
    user,
    body: `<h1>Checkout</h1>
      ${message ? `<p class="warn">${esc(message)}</p>` : ""}
      <ul>${lines}</ul>
      <p class="price">Total ${money(total)}</p>
      <p>Wallet balance ${money(user.wallet_cents)}. Payment uses that balance. No card is charged.</p>
      <form method="post" action="/checkout">
        <label>Name <input name="ship_name" required value="${esc(user.name)}"></label>
        <label>Address <input name="ship_address" required></label>
        <label>City <input name="ship_city" required></label>
        <label>Postal code <input name="ship_postal" required></label>
        <button type="submit">Pay with wallet balance</button>
      </form>`,
  });
}

export function receiptPage(
  categories: CategoryRow[],
  order: OrderRow,
  items: Array<{ listing_id: string; title: string; price_cents: number; qty: number }>,
  user: UserRow | null,
): string {
  const lines = items
    .map(
      (item) =>
        `<li><a href="/listing/${esc(item.listing_id)}">${esc(item.title)}</a> · ${item.qty} × ${money(item.price_cents)}</li>`,
    )
    .join("");
  return layout({
    title: "Receipt",
    categories,
    user,
    body: `<h1>Receipt</h1>
      <p>Order ${esc(order.id)}</p>
      <p>Ship to ${esc(order.ship_name)}, ${esc(order.ship_address)}, ${esc(order.ship_city)} ${esc(order.ship_postal)}</p>
      <ul>${lines}</ul>
      <p class="price">Paid ${money(order.total_cents)} from wallet balance</p>`,
  });
}
