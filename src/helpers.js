/**
 * helpers.js — money, cart and shipping maths shared by the whole app.
 *
 * All money is stored and calculated in *cents* (whole numbers). Never use
 * decimals for money: 0.1 + 0.2 !== 0.3 in JavaScript and pennies go missing.
 */
const fs = require('fs');
const path = require('path');
const { getSettings, products } = require('./db');
const { countryName, isDomestic } = require('./countries');

/* ------------------------------- images ------------------------------- */

const UPLOADS_ON_DISK = path.join(__dirname, '..', 'public', 'uploads');
const smallCache = new Map();

/**
 * Grid and cart thumbnails use the 600px "-sm" copy of a photo when one
 * exists next to it (tools/process_photos.py makes them), otherwise the
 * full image. Checked once per path, then remembered.
 */
function thumb(imagePath) {
  if (!imagePath || !imagePath.startsWith('/uploads/') || !imagePath.endsWith('.jpg')) {
    return imagePath || '/uploads/group.jpg';
  }
  if (!smallCache.has(imagePath)) {
    const small = imagePath.replace(/\.jpg$/, '-sm.jpg');
    const onDisk = path.join(UPLOADS_ON_DISK, path.basename(small));
    smallCache.set(imagePath, fs.existsSync(onDisk) ? small : imagePath);
  }
  return smallCache.get(imagePath);
}

function money(cents, settings = getSettings()) {
  const n = (Number(cents || 0) / 100).toFixed(2);
  return `${settings.currency_symbol}${n}`;
}

function toCents(input) {
  const n = Number(String(input).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

/* -------------------------------- cart -------------------------------- */

/** The cart lives in a signed cookie as { "<productId>": qty }. */
function rawCart(req) {
  if (!req.session.cart || typeof req.session.cart !== 'object') {
    req.session.cart = {};
  }
  return req.session.cart;
}

/** Turns the cookie into real products, dropping anything deleted or sold out. */
function readCart(req) {
  const raw = rawCart(req);
  const lines = [];
  let changed = false;

  for (const [id, qty] of Object.entries(raw)) {
    const product = products.byId(id);
    if (!product || !product.active) {
      delete raw[id];
      changed = true;
      continue;
    }
    const wanted = Math.max(0, Math.min(Number(qty) || 0, product.stock));
    if (wanted !== Number(qty)) changed = true;
    if (wanted === 0) {
      delete raw[id];
      continue;
    }
    raw[id] = wanted;
    lines.push({ product, qty: wanted, line_cents: product.price_cents * wanted });
  }

  const subtotal_cents = lines.reduce((s, l) => s + l.line_cents, 0);
  const count = lines.reduce((s, l) => s + l.qty, 0);
  return { lines, subtotal_cents, count, changed };
}

function setQty(req, productId, qty) {
  const raw = rawCart(req);
  const product = products.byId(productId);
  if (!product) return;
  const n = Math.max(0, Math.min(Number(qty) || 0, product.stock));
  if (n === 0) delete raw[product.id];
  else raw[product.id] = n;
}

function addToCart(req, productId, qty = 1) {
  const raw = rawCart(req);
  const current = Number(raw[Number(productId)] || 0);
  setQty(req, productId, current + Number(qty));
}

function clearCart(req) {
  req.session.cart = {};
}

/* ------------------------------ shipping ------------------------------ */

/**
 * Two flat rates, which is what nearly every small maker actually uses.
 * Orders above the free-shipping threshold ship free domestically.
 */
function shippingOptions(subtotal_cents, settings = getSettings()) {
  const freeOver = Number(settings.free_shipping_over_cents || 0);
  const domestic = Number(settings.ship_domestic_cents || 0);
  const intl = Number(settings.ship_intl_cents || 0);
  const qualifiesFree = freeOver > 0 && subtotal_cents >= freeOver;

  return [
    {
      id: 'domestic',
      label: qualifiesFree
        ? `Free shipping within ${countryName(settings.country)}`
        : settings.ship_domestic_label,
      cents: qualifiesFree ? 0 : domestic,
      days: [2, 5],
    },
    {
      id: 'international',
      label: settings.ship_intl_label,
      cents: intl,
      days: [7, 14],
    },
  ];
}

/** The shipping option that applies to a destination country. */
function shippingFor(countryCode, subtotal_cents, settings = getSettings()) {
  const id = isDomestic(countryCode, settings.country) ? 'domestic' : 'international';
  return shippingOptionById(id, subtotal_cents, settings);
}

function shippingOptionById(id, subtotal_cents, settings = getSettings()) {
  return (
    shippingOptions(subtotal_cents, settings).find((o) => o.id === id) ||
    shippingOptions(subtotal_cents, settings)[0]
  );
}

/** Snapshot of what was bought, frozen at purchase time. */
function cartToItems(lines) {
  return lines.map((l) => ({
    id: l.product.id,
    slug: l.product.slug,
    name: l.product.name,
    price_cents: l.product.price_cents,
    qty: l.qty,
    image: l.product.image,
  }));
}

module.exports = {
  money,
  thumb,
  toCents,
  slugify,
  readCart,
  setQty,
  addToCart,
  clearCart,
  shippingOptions,
  shippingOptionById,
  shippingFor,
  cartToItems,
};
