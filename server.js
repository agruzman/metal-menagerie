/**
 * server.js — the shop.
 *
 *   npm install
 *   cp .env.example .env      (then edit .env)
 *   npm start                 -> http://localhost:3000
 *
 * Storefront:  /            Admin dashboard: /admin
 */
require('dotenv').config();

const PORT = Number(process.env.PORT || 3000);

// Hosts such as Render tell us our public address in an environment variable.
// Work it out before anything else loads, because checkout.js reads it once.
if (!process.env.BASE_URL) {
  process.env.BASE_URL =
    process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
}
const BASE_URL = process.env.BASE_URL.replace(/\/$/, '');
const BEHIND_HTTPS = BASE_URL.startsWith('https://');

const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const { seed, getSettings, products, images } = require('./src/db');
const { UPLOAD_DIR } = require('./src/paths');
const { readCart, thumb, asset } = require('./src/helpers');
const { countryName } = require('./src/countries');
const checkout = require('./src/routes/checkout');

const app = express();

// On a host, requests reach us through the host's HTTPS proxy. Without this,
// Express thinks every request is plain http and refuses to set the login
// cookie ("Cannot send secure cookie over unencrypted connection").
if (BEHIND_HTTPS) app.set('trust proxy', 1);
app.disable('x-powered-by');

seed(); // creates the tables and the starter catalog on first run

/* --- Stripe's webhook must see the raw, unparsed body to verify its
       signature, so it is mounted before the body parsers below. --- */
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  checkout.webhook
);

/* --- Health check. Touches the database on purpose: the keep-alive ping
       that hits this every few minutes keeps both the server awake and the
       hosted database active. --- */
app.get('/healthz', (req, res) => {
  try {
    res.json({ ok: true, products: products.listed().length, time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* --- Product photos. The four starter photos are files in public/uploads;
       anything uploaded from the admin panel lives in the database. --- */
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.get('/uploads/:name', (req, res, next) => {
  const img = images.get(req.params.name);
  if (!img) return next();
  res.set('Content-Type', img.mime);
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  res.send(img.data);
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.use(
  cookieSession({
    name: 'mm',
    secret: process.env.SESSION_SECRET || 'please-set-SESSION_SECRET-in-dotenv',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax',
    secure: BEHIND_HTTPS,
  })
);

/* Values every template can use without being passed them explicitly. */
app.use((req, res, next) => {
  const settings = getSettings();
  res.locals.settings = settings;
  res.locals.money = (c) => require('./src/helpers').money(c, settings);
  res.locals.thumb = thumb;
  res.locals.asset = asset;
  res.locals.countryName = countryName;
  res.locals.baseUrl = BASE_URL;
  res.locals.cartCount = readCart(req).count;
  res.locals.path = req.path;
  res.locals.flash = req.query.msg || '';
  next();
});

app.use('/', require('./src/routes/shop'));
app.use('/', checkout.router);
app.use('/admin', require('./src/routes/admin'));

app.use((req, res) => {
  res.status(404).render('404');
});

app.use((err, req, res, next) => {
  console.error(err);
  // An error thrown before the locals middleware ran (a bad request body, a
  // database outage) still has to render the error page, so fill in what
  // the layout needs. Fall back to the built-in defaults if the database
  // itself is what is broken.
  if (!res.locals.settings) {
    let s;
    try {
      s = getSettings();
    } catch {
      s = require('./src/db').DEFAULT_SETTINGS;
    }
    Object.assign(res.locals, {
      settings: s,
      money: (c) => require('./src/helpers').money(c, s),
      thumb,
      asset,
      countryName,
      baseUrl: BASE_URL,
      cartCount: 0,
      path: req.path,
      flash: '',
    });
  }
  res.status(err.status || 500).render('500', { message: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  const live = Boolean(process.env.STRIPE_SECRET_KEY);
  console.log(`\n  ${getSettings().store_name} is running`);
  console.log(`  Shop   ${BASE_URL}`);
  console.log(`  Admin  ${BASE_URL}/admin`);
  console.log(
    `  Orders:   ${live ? 'card checkout via Stripe' : 'order requests by email (add STRIPE_SECRET_KEY for card checkout)'}`
  );
  console.log(
    `  Email:    ${require('./src/mailer').configured ? 'SMTP configured' : 'NOT configured — requests are only visible in /admin (set SMTP_* to send emails)'}\n`
  );
  keepAwake();
});

/**
 * Free hosting puts the server to sleep after 15 idle minutes, and the next
 * visitor then waits half a minute staring at a loading screen. Requesting
 * our own public address every 10 minutes counts as traffic and prevents it
 * — no outside service needed. Only runs when hosted (https), never on a
 * laptop. Set KEEP_AWAKE=0 to switch it off.
 */
function keepAwake() {
  if (!BEHIND_HTTPS || process.env.KEEP_AWAKE === '0' || typeof fetch !== 'function') return;
  const every = 10 * 60 * 1000;
  setInterval(() => {
    fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(20_000) })
      .then((r) => { if (!r.ok) console.warn(`[keep-awake] /healthz answered ${r.status}`); })
      .catch((err) => console.warn('[keep-awake] ping failed:', err.message));
  }, every).unref();
  console.log(`  Keep-awake: pinging ${BASE_URL}/healthz every 10 minutes\n`);
}
