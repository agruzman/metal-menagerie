/**
 * admin.js — the shopkeeper's back office (everything under /admin).
 *
 * Products, photos, stock levels, orders, fulfilment and shop settings.
 * Protected by one password, kept in .env as ADMIN_PASSWORD.
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const {
  products,
  images,
  orders,
  getSettings,
  setSettings,
  DEFAULT_SETTINGS,
  db,
} = require('../db');
const { toCents, slugify } = require('../helpers');
const { sendShippedEmail } = require('../mailer');

const router = express.Router();

/* ------------------------------ uploads ------------------------------- */

/**
 * Photos are received into memory and written into the database, not onto
 * the disk. On free hosting the disk is thrown away at every restart; the
 * database is not. They are served back by GET /uploads/:name in server.js.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif|avif)$/.test(file.mimetype);
    cb(ok ? null : new Error('Photos must be JPG, PNG, WEBP, GIF or AVIF.'), ok);
  },
});

/** Saves an uploaded file and returns the public path to use in `image`. */
function storePhoto(file) {
  const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().replace(/[^a-z0-9.]/g, '');
  const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext || '.jpg'}`;
  images.put(name, file.mimetype, file.buffer);
  return '/uploads/' + name;
}

/* --------------------------------- auth -------------------------------- */

const failures = new Map(); // ip -> { n, until }

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect('/admin/login');
}

router.get('/login', (req, res) => {
  if (req.session && req.session.admin) return res.redirect('/admin');
  res.render('admin/login', { error: req.query.error || '', layoutAdmin: true });
});

router.post('/login', (req, res) => {
  const ip = req.ip;
  const rec = failures.get(ip);
  if (rec && rec.until > Date.now()) {
    return res.redirect('/admin/login?error=' + encodeURIComponent('Too many attempts. Wait a minute.'));
  }

  const expected = process.env.ADMIN_PASSWORD || '';
  if (expected && safeEqual(req.body.password || '', expected)) {
    failures.delete(ip);
    req.session.admin = true;
    return res.redirect('/admin');
  }

  const n = (rec?.n || 0) + 1;
  failures.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
  res.redirect(
    '/admin/login?error=' +
      encodeURIComponent(
        expected ? 'Wrong password.' : 'No ADMIN_PASSWORD is set in your .env file.'
      )
  );
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/admin/login');
});

router.use(requireAdmin);

/* ------------------------------ dashboard ------------------------------ */

router.get('/', (req, res) => {
  const settings = getSettings();
  const low = Number(settings.low_stock_threshold) || 0; // 0 = warning off
  res.render('admin/dashboard', {
    stats: orders.stats(),
    recent: orders.list({ limit: 8 }),
    lowStock: low > 0 ? products.all().filter((p) => p.active && p.stock <= low) : [],
    catalogue: products.all(),
    layoutAdmin: true,
  });
});

/* ------------------------------- products ------------------------------ */

router.get('/products', (req, res) => {
  res.render('admin/products', { items: products.all(), layoutAdmin: true });
});

router.get('/products/new', (req, res) => {
  res.render('admin/product_form', {
    product: null,
    error: '',
    layoutAdmin: true,
  });
});

router.get('/products/:id/edit', (req, res, next) => {
  const product = products.byId(req.params.id);
  if (!product) return next();
  res.render('admin/product_form', { product, error: '', layoutAdmin: true });
});

function readProductForm(req, existing) {
  const b = req.body;
  // The photo (if any) is only written to the database once the form has
  // passed validation — see the two POST handlers below.
  const image = b.existing_image || '';
  let slug = slugify(b.slug || b.name);
  // keep slugs unique
  const clash = db
    .prepare('SELECT id FROM products WHERE slug = ? AND id != ?')
    .get(slug, existing ? existing.id : 0);
  if (clash) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

  return {
    slug,
    name: (b.name || '').trim(),
    subtitle: (b.subtitle || '').trim(),
    description: (b.description || '').trim(),
    price_cents: toCents(b.price),
    stock: Math.max(0, parseInt(b.stock, 10) || 0),
    image,
    materials: (b.materials || '').trim(),
    dimensions: (b.dimensions || '').trim(),
    weight_grams: Math.max(0, parseInt(b.weight_grams, 10) || 0),
    active: b.active ? 1 : 0,
    sort_order: parseInt(b.sort_order, 10) || 0,
    // extra photos are managed by the catalogue file; keep whatever is there
    gallery: existing ? existing.gallery : [],
  };
}

router.post('/products', upload.single('photo'), (req, res) => {
  const data = readProductForm(req, null);
  if (!data.name) {
    return res.status(400).render('admin/product_form', {
      product: null,
      error: 'Give the piece a name.',
      layoutAdmin: true,
    });
  }
  if (req.file) data.image = storePhoto(req.file);
  products.create(data);
  res.redirect('/admin/products?msg=' + encodeURIComponent('Added.'));
});

router.post('/products/:id', upload.single('photo'), (req, res, next) => {
  const existing = products.byId(req.params.id);
  if (!existing) return next();
  const data = readProductForm(req, existing);
  if (!data.name) {
    return res.status(400).render('admin/product_form', {
      product: existing,
      error: 'Give the piece a name.',
      layoutAdmin: true,
    });
  }
  if (req.file) data.image = storePhoto(req.file);
  products.update(existing.id, data);
  if (existing.image && existing.image !== data.image) images.removeIfUnused(existing.image);
  res.redirect('/admin/products?msg=' + encodeURIComponent('Saved.'));
});

router.post('/products/:id/delete', (req, res, next) => {
  const existing = products.byId(req.params.id);
  if (!existing) return next();
  products.remove(existing.id);
  images.removeIfUnused(existing.image);
  res.redirect('/admin/products?msg=' + encodeURIComponent('Deleted.'));
});

/** Quick +1 / -1 buttons on the dashboard. */
router.post('/products/:id/stock', (req, res) => {
  products.adjustStock(req.params.id, parseInt(req.body.delta, 10) || 0);
  res.redirect(req.get('referer') || '/admin');
});

/**
 * A photo that is too big or the wrong type is rejected by multer above.
 * Catch it here and put the shopkeeper back on the form with an explanation,
 * rather than throwing them onto the generic error page and losing what they
 * had already typed in.
 */
router.use('/products', (err, req, res, next) => {
  if (!err) return next();
  const match = req.path.match(/^\/(\d+)$/);
  res.status(400).render('admin/product_form', {
    product: match ? products.byId(match[1]) : null,
    error:
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That photo is bigger than 8 MB. Export a smaller copy and try again.'
        : err.message,
    layoutAdmin: true,
  });
});

/* -------------------------------- orders ------------------------------- */

router.get('/orders', (req, res) => {
  const status = req.query.status || '';
  res.render('admin/orders', {
    items: orders.list(status ? { status } : {}),
    status,
    layoutAdmin: true,
  });
});

router.get('/orders/:id', (req, res, next) => {
  const order = orders.byId(req.params.id);
  if (!order) return next();
  res.render('admin/order', { order, layoutAdmin: true });
});

router.post('/orders/:id', async (req, res, next) => {
  try {
    const order = orders.byId(req.params.id);
    if (!order) return next();

    const status = req.body.status || order.status;
    orders.setStatus(order.id, status, {
      tracking: req.body.tracking ?? null,
      notes: req.body.notes ?? null,
    });

    // Money arrived (by PayPal, transfer, cash…): take the piece off the shelf.
    // markPaid is idempotent, so an order already paid is left alone.
    if (['paid', 'shipped'].includes(status) && order.stock_applied === 0) {
      orders.markPaid(order.id, {});
      if (status === 'shipped') orders.setStatus(order.id, 'shipped', {});
    }

    // Restock if an order is cancelled or refunded after being paid.
    if (
      ['cancelled', 'refunded'].includes(status) &&
      order.stock_applied === 1 &&
      !['cancelled', 'refunded'].includes(order.status)
    ) {
      for (const item of order.items) products.adjustStock(item.id, item.qty);
      db.prepare('UPDATE orders SET stock_applied = 0 WHERE id = ?').run(order.id);
    }

    if (status === 'shipped' && order.status !== 'shipped') {
      await sendShippedEmail(orders.byId(order.id));
    }

    res.redirect('/admin/orders/' + order.id + '?msg=' + encodeURIComponent('Updated.'));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- settings ------------------------------ */

const MONEY_SETTINGS = [
  'ship_domestic_cents',
  'ship_intl_cents',
  'free_shipping_over_cents',
];

router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    values: getSettings(),
    keys: Object.keys(DEFAULT_SETTINGS),
    moneyKeys: MONEY_SETTINGS,
    layoutAdmin: true,
  });
});

router.post('/settings', (req, res) => {
  const patch = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in req.body)) continue;
    const raw = String(req.body[key] ?? '').trim();
    // A blank box keeps whatever is there now. Saving an empty currency or
    // country list would otherwise break checkout with no warning.
    if (raw === '' && !MONEY_SETTINGS.includes(key)) continue;
    patch[key] = MONEY_SETTINGS.includes(key) ? String(toCents(raw)) : raw;
  }
  setSettings(patch);
  res.redirect('/admin/settings?msg=' + encodeURIComponent('Settings saved.'));
});

module.exports = router;
