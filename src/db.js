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
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT NOT NULL UNIQUE,
  provider        TEXT NOT NULL DEFAULT 'stripe',
  provider_ref    TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | shipped | cancelled | refunded
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

/* ------------------------------------------------------------------ */
/* Settings — small key/value bag you can edit from the admin panel.   */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  store_name: 'Metal Menagerie',
  tagline: 'Small creatures, forged by hand from salvaged metal.',
  intro:
    'Every piece is made one at a time from bolts, spoons, wrenches and other ' +
    'rescued hardware. No two are identical, and when one is gone, it is gone.',
  contact_email: 'hello@example.com',
  currency: 'usd',
  currency_symbol: '$',
  country: 'US',
  ship_countries: 'US,CA,GB,IE,FR,DE,NL,BE,ES,IT,PT,SE,DK,NO,FI,PL,CZ,AT,CH,AU,NZ,IL',
  ship_domestic_label: 'Standard shipping (3-7 business days)',
  ship_domestic_cents: '800',
  ship_intl_label: 'International shipping (7-21 business days)',
  ship_intl_cents: '2400',
  free_shipping_over_cents: '15000',
  low_stock_threshold: '2',
  policies:
    'Every statue is shipped wrapped in foam inside a rigid box, dispatched ' +
    'within 3 working days. If a piece arrives damaged, send a photo within 14 ' +
    'days of delivery and it will be replaced or refunded in full. Unused items ' +
    'can be returned within 14 days; return postage is the buyer\'s.',
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

const products = {
  all() {
    return db
      .prepare('SELECT * FROM products ORDER BY sort_order ASC, id ASC')
      .all();
  },
  listed() {
    return db
      .prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort_order ASC, id ASC')
      .all();
  },
  bySlug(slug) {
    return db.prepare('SELECT * FROM products WHERE slug = ?').get(String(slug));
  },
  byId(id) {
    const n = intId(id);
    if (n === null) return undefined;
    return db.prepare('SELECT * FROM products WHERE id = ?').get(n);
  },
  create(p) {
    return db
      .prepare(
        `INSERT INTO products
         (slug, name, subtitle, description, price_cents, stock, image,
          materials, dimensions, weight_grams, active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
           active = ?, sort_order = ?
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
    const last30 = db
      .prepare(
        `SELECT COALESCE(SUM(total_cents),0) cents FROM orders
         WHERE status IN ('paid','shipped') AND created_at >= datetime('now','-30 days')`
      )
      .get().cents;
    return { count: paid.n, revenue_cents: paid.cents, toShip, last30_cents: last30 };
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
/* First-run seed: the three pieces from the photo.                    */
/* ------------------------------------------------------------------ */

function seed() {
  const count = db.prepare('SELECT COUNT(*) n FROM products').get().n;
  if (count > 0) return;

  const seeds = [
    {
      slug: 'ladybird-in-red',
      name: 'Ladybird in Red',
      subtitle: 'Hand-painted steel, six bolt legs',
      description:
        'A plump ladybird with a domed, hand-beaten shell finished in deep ' +
        'lacquer red and six black spots. The body is split down the middle ' +
        'like real elytra, the head is a polished ball of blackened steel, and ' +
        'the six legs are bent rod, each one set by eye so the piece stands ' +
        'square on a shelf or windowsill.',
      price_cents: 6800,
      stock: 4,
      image: '/uploads/ladybug.jpg',
      materials: 'Welded mild steel, bolts, enamel paint, matte lacquer',
      dimensions: 'Approx. 14 x 12 x 5 cm',
      weight_grams: 380,
      sort_order: 1,
    },
    {
      slug: 'wrench-legged-beetle',
      name: 'The Wrench-Legged Beetle',
      subtitle: 'Two open-end spanners for hind legs',
      description:
        'The largest of the flock. A smooth bronze-toned carapace scored with a ' +
        'single seam sits on a blackened thorax, and the two rear legs are ' +
        'genuine open-end spanners, kept exactly as they were found. Front and ' +
        'middle legs are forged rod. It has the weight of a real tool in the hand.',
      price_cents: 9500,
      stock: 2,
      image: '/uploads/beetle.jpg',
      materials: 'Salvaged spanners, mild steel, bronze patina',
      dimensions: 'Approx. 22 x 15 x 6 cm',
      weight_grams: 720,
      sort_order: 2,
    },
    {
      slug: 'shower-head-spider',
      name: 'Shower-Head Spider',
      subtitle: 'A retired tap fitting, reborn with eight legs',
      description:
        'The head is a perforated brass shower rose, still carrying its water ' +
        'marks; the abdomen is a stacked valve body with two red glass eyes set ' +
        'at the tip. Eight coiled-spring legs are welded in pairs and bent into ' +
        'a low, ready crouch. Unsettling on a bookshelf, in the best way.',
      price_cents: 8400,
      stock: 3,
      image: '/uploads/spider.jpg',
      materials: 'Brass shower rose, valve body, springs, glass beads',
      dimensions: 'Approx. 18 x 18 x 7 cm',
      weight_grams: 540,
      sort_order: 3,
    },
  ];

  const insert = db.transaction((rows) => {
    for (const r of rows) products.create({ ...r, active: 1 });
  });
  insert(seeds);
  console.log('[db] Seeded the catalog with 3 starter products.');
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
};
