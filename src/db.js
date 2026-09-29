/**
 * db.js — the shop's database.
 *
 * Everything is stored in one file: data/shop.db (SQLite). No database server
 * to install, no monthly fee. To back the whole shop up, copy that one file.
 */
const path = require('path');
const Database = require('./sqlite');
const { DATA_DIR } = require('./paths');

const db = new Database(path.join(DATA_DIR, 'shop.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  subtitle      TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  price_cents   INTEGER NOT NULL DEFAULT 0,
  stock         INTEGER NOT NULL DEFAULT 0,
  image         TEXT NOT NULL DEFAULT '',
  materials     TEXT NOT NULL DEFAULT '',
  dimensions    TEXT NOT NULL DEFAULT '',
  weight_grams  INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  gallery_json  TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT NOT NULL UNIQUE,
  provider        TEXT NOT NULL DEFAULT 'stripe',
  provider_ref    TEXT NOT NULL DEFAULT '',
  -- pending (checkout started) | requested (order form sent, awaiting payment)
  -- | paid | shipped | cancelled | refunded
  status          TEXT NOT NULL DEFAULT 'pending',
  email           TEXT NOT NULL DEFAULT '',
  customer_name   TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  address_json    TEXT NOT NULL DEFAULT '{}',
  items_json      TEXT NOT NULL DEFAULT '[]',
  subtotal_cents  INTEGER NOT NULL DEFAULT 0,
  shipping_cents  INTEGER NOT NULL DEFAULT 0,
  total_cents     INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'usd',
  shipping_label  TEXT NOT NULL DEFAULT '',
  tracking        TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  stock_applied   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

-- Photos uploaded from the admin panel. Kept in the database (not on disk)
-- so they survive on hosts that wipe the filesystem on every restart.
CREATE TABLE IF NOT EXISTS images (
  name        TEXT PRIMARY KEY,
  mime        TEXT NOT NULL,
  data        BLOB NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Columns added after the first release. "ADD COLUMN" fails harmlessly when
// the column already exists, which is the only way to ask on every backend.
for (const sql of [
  "ALTER TABLE products ADD COLUMN gallery_json TEXT NOT NULL DEFAULT '[]'",
]) {
  try {
    db.exec(sql);
  } catch {
    /* already there */
  }
}

/* ------------------------------------------------------------------ */
/* Settings — small key/value bag you can edit from the admin panel.   */
/* ------------------------------------------------------------------ */

const { SHIP_TO } = require('./countries');

const DEFAULT_SETTINGS = {
  store_name: 'Metal Menagerie',
  tagline: 'Creatures and characters welded by hand from salvaged steel — each one made exactly once.',
  intro:
    'Genka builds these in the corner of a steel factory in Israel, after his ' +
    'shift, out of spoons, bolts, chain and whatever else was heading for the ' +
    'scrap bin. Every piece exists exactly once. When it is gone, it is gone.',
  contact_email: 'alex.gruzman@gmail.com',
  currency: 'usd',
  currency_symbol: '$',
  country: 'IL',
  ship_countries: SHIP_TO.map((c) => c.code).join(','),
  ship_domestic_label: 'Within Israel (2-5 business days)',
  ship_domestic_cents: '1500',
  ship_intl_label: 'Europe, USA & Emirates — insured, tracked (7-14 business days)',
  ship_intl_cents: '3900',
  free_shipping_over_cents: '0',
  low_stock_threshold: '0', // every piece is stock 1 by nature; 0 switches the warning off
  policies:
    'Every piece is one of a kind, so an order is first a request: you tell us ' +
    'where it should go, we confirm within a day that it is still available, ' +
    'together with the exact shipping cost and how to pay. It is then wrapped in ' +
    'foam inside a rigid box and sent tracked and insured from Israel. If it ' +
    'arrives damaged, send a photo within 14 days and you get a full refund. ' +
    'We ship to Europe, the United States, the United Arab Emirates and Israel.',
};

// Statements are prepared where they run, not hoisted: the remote driver
// misbehaves when a statement prepared outside a transaction runs inside one.
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key] ?? '';
}

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    out[row.key] = row.value;
  }
  return out;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

const setSettings = db.transaction((obj) => {
  for (const [k, v] of Object.entries(obj)) setSetting(k, v);
});

/* ------------------------------------------------------------------ */
/* Products                                                            */
/* ------------------------------------------------------------------ */

/** Adds the parsed `gallery` array (extra photos) to a product row. */
function withGallery(row) {
  if (!row) return row;
  return { ...row, gallery: safeParse(row.gallery_json, []) };
}

const products = {
  all() {
    return db
      .prepare('SELECT * FROM products ORDER BY sort_order ASC, id ASC')
      .all()
      .map(withGallery);
  },
  listed() {
    return db
      .prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort_order ASC, id ASC')
      .all()
      .map(withGallery);
  },
  bySlug(slug) {
    return withGallery(db.prepare('SELECT * FROM products WHERE slug = ?').get(String(slug)));
  },
  byId(id) {
    const n = intId(id);
    if (n === null) return undefined;
    return withGallery(db.prepare('SELECT * FROM products WHERE id = ?').get(n));
  },
  create(p) {
    return db
      .prepare(
        `INSERT INTO products
         (slug, name, subtitle, description, price_cents, stock, image,
          materials, dimensions, weight_grams, active, sort_order, gallery_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...productValues(p));
  },
  update(id, p) {
    const n = intId(id);
    if (n === null) return { changes: 0 };
    return db
      .prepare(
        `UPDATE products SET
           slug = ?, name = ?, subtitle = ?, description = ?, price_cents = ?,
           stock = ?, image = ?, materials = ?, dimensions = ?, weight_grams = ?,
           active = ?, sort_order = ?, gallery_json = ?
         WHERE id = ?`
      )
      .run(...productValues(p), n);
  },
  remove(id) {
    const n = intId(id);
    if (n === null) return { changes: 0 };
    return db.prepare('DELETE FROM products WHERE id = ?').run(n);
  },
  adjustStock(id, delta) {
    const n = intId(id);
    if (n === null) return { changes: 0 };
    return db
      .prepare('UPDATE products SET stock = MAX(0, stock + ?) WHERE id = ?')
      .run(Math.trunc(Number(delta)) || 0, n);
  },
  /** How many products point at a given image path (used before deleting a photo). */
  countUsingImage(image) {
    return db.prepare('SELECT COUNT(*) n FROM products WHERE image = ?').get(image).n;
  },
};

/** Column order shared by INSERT and UPDATE. Positional parameters work
 *  identically across better-sqlite3, Node's SQLite and libsql. */
function productValues(p) {
  return [
    String(p.slug),
    String(p.name),
    String(p.subtitle ?? ''),
    String(p.description ?? ''),
    Number(p.price_cents) || 0,
    Number(p.stock) || 0,
    String(p.image ?? ''),
    String(p.materials ?? ''),
    String(p.dimensions ?? ''),
    Number(p.weight_grams) || 0,
    p.active ? 1 : 0,
    Number(p.sort_order) || 0,
    JSON.stringify(Array.isArray(p.gallery) ? p.gallery : safeParse(p.gallery_json, [])),
  ];
}

/* ------------------------------------------------------------------ */
/* Images — uploaded product photos, stored as blobs.                  */
/* ------------------------------------------------------------------ */

const images = {
  put(name, mime, data) {
    db.prepare(
      'INSERT INTO images (name, mime, data) VALUES (?, ?, ?) ' +
        'ON CONFLICT(name) DO UPDATE SET mime = excluded.mime, data = excluded.data'
    ).run(name, mime, data);
  },
  get(name) {
    const row = db.prepare('SELECT mime, data FROM images WHERE name = ?').get(name);
    if (!row) return null;
    return { mime: row.mime, data: Buffer.from(row.data) };
  },
  remove(name) {
    return db.prepare('DELETE FROM images WHERE name = ?').run(name);
  },
  /** Deletes the blob behind an /uploads/<name> path if no product still uses it. */
  removeIfUnused(imagePath) {
    if (!imagePath || !imagePath.startsWith('/uploads/')) return;
    if (products.countUsingImage(imagePath) > 0) return;
    images.remove(imagePath.slice('/uploads/'.length));
  },
};

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

function newRef() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MM-${t}-${r}`;
}

const orders = {
  create(o) {
    const ref = o.ref || newRef();
    db.prepare(
      `INSERT INTO orders
       (ref, provider, provider_ref, status, email, customer_name, phone,
        address_json, items_json, subtotal_cents, shipping_cents, total_cents,
        currency, shipping_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ref,
      o.provider || 'stripe',
      o.provider_ref || '',
      o.status || 'pending',
      o.email || '',
      o.customer_name || '',
      o.phone || '',
      JSON.stringify(o.address || {}),
      JSON.stringify(o.items || []),
      Number(o.subtotal_cents) || 0,
      Number(o.shipping_cents) || 0,
      Number(o.total_cents) || 0,
      o.currency || getSetting('currency'),
      o.shipping_label || ''
    );
    return orders.byRef(ref);
  },
  byRef(ref) {
    return hydrate(db.prepare('SELECT * FROM orders WHERE ref = ?').get(ref));
  },
  byId(id) {
    const n = intId(id);
    if (n === null) return null;
    return hydrate(db.prepare('SELECT * FROM orders WHERE id = ?').get(n));
  },
  byProviderRef(pref) {
    return hydrate(
      db.prepare('SELECT * FROM orders WHERE provider_ref = ?').get(pref)
    );
  },
  list({ status, limit = 200 } = {}) {
    const rows = status
      ? db
          .prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT ?')
          .all(status, limit)
      : db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(hydrate);
  },
  /**
   * The buyer filled in the order form: store who they are and where the
   * piece should go, and mark the order as a request awaiting payment.
   * Stock is NOT touched here — that happens when the order is marked paid.
   */
  saveRequest(id, d) {
    const n = intId(id);
    if (n === null) return;
    db.prepare(
      `UPDATE orders SET status = 'requested', provider = 'request',
         email = ?, customer_name = ?, phone = ?, address_json = ?,
         shipping_cents = ?, total_cents = ?, shipping_label = ?, notes = ?
       WHERE id = ?`
    ).run(
      String(d.email || ''),
      String(d.customer_name || ''),
      String(d.phone || ''),
      JSON.stringify(d.address || {}),
      Number(d.shipping_cents) || 0,
      Number(d.total_cents) || 0,
      String(d.shipping_label || ''),
      String(d.notes || ''),
      n
    );
  },
  setStatus(id, status, extra = {}) {
    const n = intId(id);
    if (n === null) return;
    db.prepare(
      `UPDATE orders SET status = ?, tracking = COALESCE(?, tracking),
       notes = COALESCE(?, notes) WHERE id = ?`
    ).run(String(status), extra.tracking ?? null, extra.notes ?? null, n);
  },

  /**
   * Called once, when a payment is confirmed. Marks the order paid and takes
   * the items out of stock. Wrapped in a transaction and guarded by
   * stock_applied so a duplicate webhook can never double-decrement.
   */
  markPaid: db.transaction((id, details = {}) => {
    const n = intId(id);
    if (n === null) return false;
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(n);
    if (!row || row.stock_applied === 1) return false;

    for (const item of JSON.parse(row.items_json)) {
      db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?').run(
        Math.trunc(Number(item.qty)) || 0,
        Math.trunc(Number(item.id)) || 0
      );
    }
    db.prepare(
      `UPDATE orders SET status = 'paid', stock_applied = 1,
         paid_at = datetime('now'),
         email = COALESCE(NULLIF(?, ''), email),
         customer_name = COALESCE(NULLIF(?, ''), customer_name),
         phone = COALESCE(NULLIF(?, ''), phone),
         address_json = COALESCE(NULLIF(?, ''), address_json),
         shipping_cents = COALESCE(?, shipping_cents),
         total_cents = COALESCE(?, total_cents),
         shipping_label = COALESCE(NULLIF(?, ''), shipping_label),
         provider_ref = COALESCE(NULLIF(?, ''), provider_ref)
       WHERE id = ?`
    ).run(
      details.email || '',
      details.customer_name || '',
      details.phone || '',
      details.address ? JSON.stringify(details.address) : '',
      details.shipping_cents ?? null,
      details.total_cents ?? null,
      details.shipping_label || '',
      details.provider_ref || '',
      n
    );
    return true;
  }),

  stats() {
    const paid = db
      .prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) cents
         FROM orders WHERE status IN ('paid','shipped')`
      )
      .get();
    const toShip = db
      .prepare("SELECT COUNT(*) n FROM orders WHERE status = 'paid'").get().n;
    const requested = db
      .prepare("SELECT COUNT(*) n FROM orders WHERE status = 'requested'").get().n;
    const last30 = db
      .prepare(
        `SELECT COALESCE(SUM(total_cents),0) cents FROM orders
         WHERE status IN ('paid','shipped') AND created_at >= datetime('now','-30 days')`
      )
      .get().cents;
    return { count: paid.n, revenue_cents: paid.cents, toShip, requested, last30_cents: last30 };
  },
};

/** "12" -> 12; anything that is not a whole number -> null (so a bad URL is a
 *  404, not a database error — the remote driver rejects NaN outright). */
function intId(id) {
  const n = Number(id);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    address: safeParse(row.address_json, {}),
    items: safeParse(row.items_json, []),
  };
}

function safeParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* The catalogue.                                                      */
/*                                                                     */
/* src/catalog.json describes every piece (written by hand, photos     */
/* processed by tools/process_photos.py). On start-up any piece in the */
/* file that is not yet in the database is added, so a fresh database  */
/* gets the whole collection and an existing one only gains new items. */
/* Edits made in the admin panel are never overwritten.                */
/* ------------------------------------------------------------------ */

const CATALOG = require('./catalog.json');

/** The three insects from the very first photo — they keep their pictures. */
const FOUNDING_PIECES = [
  {
    slug: 'ladybird-in-red',
    name: 'Ladybird in Red',
    subtitle: 'Hand-painted steel, six bolt legs',
    description:
      'A plump ladybird with a domed, hand-beaten shell in deep lacquer red ' +
      'and six black spots. The shell is split down the middle like real wing ' +
      'cases, the head is a ball of blackened steel, and the six legs are bent ' +
      'rod, each one set by eye so it stands square on a shelf.',
    price: 390,
    image: '/uploads/ladybug.jpg',
    materials: 'Mild steel, bolts, enamel paint, matte lacquer',
    gallery: ['/uploads/bug-collection.jpg'],
  },
  {
    slug: 'wrench-legged-beetle',
    name: 'The Wrench-Legged Beetle',
    subtitle: 'Two open-end spanners for hind legs',
    description:
      'A smooth bronze-toned carapace scored with a single seam sits on a ' +
      'blackened thorax, and the two rear legs are genuine open-end spanners, ' +
      'kept exactly as they were found. It has the weight of a real tool in the hand.',
    price: 440,
    image: '/uploads/beetle.jpg',
    materials: 'Salvaged spanners, mild steel, bronze patina',
    gallery: ['/uploads/bug-collection.jpg'],
  },
  {
    slug: 'shower-head-spider',
    name: 'Shower-Head Spider',
    subtitle: 'A retired tap fitting, reborn with eight legs',
    description:
      'The head is a perforated brass shower rose, still carrying its water ' +
      'marks; the abdomen is a stacked valve body with two red glass eyes at ' +
      'the tip. Eight coiled-spring legs are welded in pairs and bent into a ' +
      'low, ready crouch. Unsettling on a bookshelf, in the best way.',
    price: 390,
    image: '/uploads/spider.jpg',
    materials: 'Brass shower rose, valve body, springs, glass beads',
    gallery: ['/uploads/bug-collection.jpg'],
  },
];

/** Every piece the catalogue knows about, in display order. */
function catalogProducts() {
  const galleries = {};
  for (const photo of CATALOG.photos) {
    if (photo.gallery_for) {
      (galleries[photo.gallery_for] ||= []).push('/uploads/' + photo.image);
    }
  }
  const out = [];
  let order = 1;
  for (const photo of CATALOG.photos) {
    if (!photo.product) continue;
    const p = photo.product;
    out.push({
      slug: p.slug,
      name: p.name,
      subtitle: p.subtitle || '',
      description: p.description || '',
      price_cents: Math.round(Number(p.price) * 100),
      stock: 1, // every piece exists exactly once
      image: '/uploads/' + photo.image,
      materials: p.materials || '',
      dimensions: p.dimensions || '',
      weight_grams: 0,
      active: 1,
      sort_order: order++,
      gallery: galleries[p.slug] || [],
    });
  }
  for (const f of FOUNDING_PIECES) {
    out.push({
      ...f,
      price_cents: Math.round(f.price * 100),
      stock: 1,
      dimensions: '',
      weight_grams: 0,
      active: 1,
      sort_order: order++,
    });
  }
  return out;
}

/** Adds catalogue pieces that are missing from the database. */
function seed() {
  const wanted = catalogProducts();
  const have = new Set(db.prepare('SELECT slug FROM products').all().map((r) => r.slug));
  const missing = wanted.filter((p) => !have.has(p.slug));
  if (missing.length === 0) return 0;

  const insert = db.transaction((rows) => {
    for (const r of rows) products.create(r);
  });
  insert(missing);
  console.log(`[db] Added ${missing.length} piece(s) from the catalogue (${wanted.length} total).`);
  return missing.length;
}

module.exports = {
  db,
  getSetting,
  getSettings,
  setSetting,
  setSettings,
  DEFAULT_SETTINGS,
  products,
  images,
  orders,
  newRef,
  seed,
  catalogProducts,
};
