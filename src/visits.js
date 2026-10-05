/**
 * visits.js — who comes to the shop, counted without cookies.
 *
 * Every page a real person opens is counted, and the same person is counted
 * as one visitor however many pages they open. "The same person" is a salted
 * hash of their IP address and browser string: a one-way fingerprint that
 * cannot be turned back into the address. The address itself is never
 * written anywhere, so there is nothing personal in the database and no
 * cookie banner to show. Search-engine bots, link previews, the keep-alive
 * pings, the admin panel and photos/stylesheets are left out.
 *
 * Hits are gathered for a few seconds and written in one go, so counting
 * costs the visitor nothing and the hosted database sees a few writes an
 * hour instead of one per request.
 *
 * The country comes from src/geoip.js. Days are UTC.
 */
const crypto = require('crypto');
const { db } = require('./db');
const geoip = require('./geoip');

db.exec(`
CREATE TABLE IF NOT EXISTS visits (
  day       TEXT NOT NULL,                  -- YYYY-MM-DD (UTC)
  visitor   TEXT NOT NULL,                  -- salted hash of IP + browser; never the IP itself
  country   TEXT NOT NULL DEFAULT '',       -- ISO 3166-1 alpha-2, '' when unknown
  views     INTEGER NOT NULL DEFAULT 0,
  landing   TEXT NOT NULL DEFAULT '',       -- the first page they opened that day
  first_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, visitor)
);

CREATE INDEX IF NOT EXISTS idx_visits_country ON visits(country);

CREATE TABLE IF NOT EXISTS pageviews (
  day    TEXT NOT NULL,
  path   TEXT NOT NULL,
  views  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);
`);

/* ------------------------------ what counts ----------------------------- */

const SKIP_PREFIX = ['/admin', '/uploads', '/css', '/js', '/img', '/fonts', '/webhooks', '/healthz'];
const SKIP_EXACT = new Set(['/favicon.ico', '/robots.txt', '/sitemap.xml', '/manifest.json', '/.well-known']);

// Crawlers, link previews, monitors, command-line tools and headless browsers.
const BOT_RE = new RegExp(
  [
    'bot', 'crawl', 'spider', 'slurp', 'curl', 'wget', 'python', 'java/', 'go-http', 'okhttp', 'libwww',
    'httpclient', 'http_request', 'headless', 'phantom', 'puppeteer', 'playwright', 'selenium', 'lighthouse',
    'pagespeed', 'pingdom', 'uptime', 'monitor', 'statuscake', 'site24x7', 'newrelic', 'datadog',
    'facebookexternalhit', 'facebookcatalog', 'whatsapp', 'telegram', 'discord', 'skypeuripreview', 'slack',
    'twitter', 'linkedin', 'embedly', 'pinterest', 'vkshare', 'validator', 'yandex', 'baidu', 'bingpreview',
    'duckduck', 'semrush', 'ahrefs', 'mj12', 'dotbot', 'petal', 'bytespider', 'gptbot', 'chatgpt', 'claude',
    'anthropic', 'openai', 'ccbot', 'perplexity', 'applebot', 'amazonbot', 'archive\\.org', 'ia_archiver',
    'feedfetcher', 'fetch', 'undici', '\\bnode(?:js)?\\b', 'axios', 'postman', 'insomnia', 'wappalyzer',
    'screaming', 'netcraft', 'zgrab', 'masscan', 'nmap', 'censys', 'shodan', 'preview',
  ].join('|'),
  'i'
);

/** Is this request a real person opening a page of the shop? */
function shouldCount(req) {
  if (req.method !== 'GET') return false;
  const p = req.path || '/';
  if (SKIP_EXACT.has(p)) return false;
  for (const pre of SKIP_PREFIX) if (p === pre || p.startsWith(pre + '/')) return false;
  if (/\.[a-z0-9]{2,5}$/i.test(p)) return false; // a file, not a page

  const h = req.headers || {};
  const ua = String(h['user-agent'] || '');
  if (!ua || BOT_RE.test(ua)) return false;
  // Browsers ask for pages with Accept: text/html; scripts and tools do not.
  if (!String(h.accept || '').includes('text/html')) return false;
  // Speculative loads and embedded frames are not a person reading the page.
  if (/prefetch|prerender|preview/i.test(String(h['sec-purpose'] || h.purpose || h['x-moz'] || ''))) return false;
  if (h['sec-fetch-mode'] && h['sec-fetch-mode'] !== 'navigate') return false;
  if (h['sec-fetch-dest'] && h['sec-fetch-dest'] !== 'document') return false;
  return true;
}

/* ------------------------------- counting ------------------------------- */

const SALT = process.env.VISITS_SALT || process.env.SESSION_SECRET || 'metal-menagerie';

/** One-way fingerprint of a visitor: the same browser on the same address hashes the same. */
function visitorKey(req) {
  const ua = String((req.headers || {})['user-agent'] || '');
  return crypto
    .createHash('sha256')
    .update(SALT + '|' + geoip.clientIp(req) + '|' + ua)
    .digest('hex')
    .slice(0, 24);
}

function dayOf(date) {
  return date.toISOString().slice(0, 10);
}

/** The page without its trailing slash; the order form loses its per-order reference. */
function cleanPath(p) {
  let s = String(p || '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  s = s.replace(/^\/order\/details\/.*$/, '/order/details');
  return (s || '/').slice(0, 160);
}

let pending = [];
let timer = null;
const FLUSH_AFTER_MS = 5000;
const FLUSH_AT = 200;

/** Remembers one page view; it reaches the database at the next flush. */
function record(req) {
  const now = new Date();
  const h = req.headers || {};
  const proxyCountry = String(h['cf-ipcountry'] || '').trim().toUpperCase();
  pending.push({
    day: dayOf(now),
    visitor: visitorKey(req),
    ip: geoip.clientIp(req), // held in memory for a few seconds, never stored
    proxyCountry: /^[A-Z]{2}$/.test(proxyCountry) && proxyCountry !== 'XX' && proxyCountry !== 'T1' ? proxyCountry : '',
    path: cleanPath(req.path),
  });
  if (pending.length >= FLUSH_AT) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_AFTER_MS).unref();
}

const write = db.transaction((visitors, pages) => {
  for (const v of visitors) {
    db.prepare(
      `INSERT INTO visits (day, visitor, country, views, landing) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day, visitor) DO UPDATE SET
         views   = visits.views + excluded.views,
         last_at = datetime('now'),
         country = CASE WHEN visits.country = '' THEN excluded.country ELSE visits.country END`
    ).run(v.day, v.visitor, v.country, v.views, v.landing);
  }
  for (const p of pages) {
    db.prepare(
      `INSERT INTO pageviews (day, path, views) VALUES (?, ?, ?)
       ON CONFLICT(day, path) DO UPDATE SET views = pageviews.views + excluded.views`
    ).run(p.day, p.path, p.views);
  }
});

/**
 * Writes everything gathered so far. Waits (briefly) for the country list
 * right after a restart so early visitors are not all filed as "unknown".
 * Returns how many hits were written.
 */
function flush(force = false) {
  clearTimeout(timer);
  timer = null;
  if (!pending.length) return 0;
  if (!force && geoip.waiting()) {
    timer = setTimeout(flush, FLUSH_AFTER_MS).unref();
    return 0;
  }

  const batch = pending;
  pending = [];
  const visitors = new Map();
  const pages = new Map();
  for (const hit of batch) {
    const vk = hit.day + '|' + hit.visitor;
    let v = visitors.get(vk);
    if (!v) {
      v = {
        day: hit.day,
        visitor: hit.visitor,
        country: hit.proxyCountry || geoip.lookup(hit.ip),
        views: 0,
        landing: hit.path,
      };
      visitors.set(vk, v);
    }
    v.views++;
    const pk = hit.day + '|' + hit.path;
    let p = pages.get(pk);
    if (!p) {
      p = { day: hit.day, path: hit.path, views: 0 };
      pages.set(pk, p);
    }
    p.views++;
  }

  try {
    write([...visitors.values()], [...pages.values()]);
  } catch (err) {
    // Statistics are not worth a crash; the batch is dropped and noted.
    console.warn('[visits] could not save a batch of page views:', err.message);
  }
  return batch.length;
}

/** Express middleware: counts the page once the response has gone out well. */
function middleware(req, res, next) {
  if (!shouldCount(req)) return next();
  res.on('finish', () => {
    const code = res.statusCode;
    // 304 is a browser re-opening a page it has cached — still a view.
    // Redirects are not counted: the page they lead to is.
    if ((code >= 200 && code < 300) || code === 304) record(req);
  });
  next();
}

/** Call once at start-up: makes sure the last few seconds are saved on shutdown. */
function start() {
  const bye = () => {
    try {
      flush(true);
    } catch {
      /* nothing more to do */
    }
    process.exit(0);
  };
  process.once('SIGTERM', bye);
  process.once('SIGINT', bye);
}

/* -------------------------------- reading ------------------------------- */

let displayNames = null;
try {
  displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  /* older Node without ICU — codes are shown instead */
}

function countryLabel(code) {
  if (!code) return 'Unknown';
  try {
    return (displayNames && displayNames.of(code)) || code;
  } catch {
    return code;
  }
}

/** 🇮🇱 from "IL" — two regional-indicator letters. */
function flag(code) {
  if (!/^[A-Z]{2}$/.test(code || '')) return '';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return dayOf(d);
}

/** Just the headline for the dashboard: unique visitors over the last 7 days. */
function lastWeek() {
  return db
    .prepare('SELECT COUNT(DISTINCT visitor) visitors, COALESCE(SUM(views), 0) views FROM visits WHERE day >= ?')
    .get(daysAgo(6));
}

/**
 * Everything the Visitors page shows. `rangeDays` is 7, 30, 90 or 0 for
 * all time, and applies to the country, day-by-day and page tables; the
 * four headline numbers are always today / 7 days / 30 days / all time.
 */
function stats(rangeDays = 30) {
  const range = [7, 30, 90, 0].includes(Number(rangeDays)) ? Number(rangeDays) : 30;
  const since = range ? daysAgo(range - 1) : '0000-00-00';

  const count = (where, args) =>
    db
      .prepare(`SELECT COUNT(DISTINCT visitor) visitors, COALESCE(SUM(views), 0) views FROM visits ${where}`)
      .get(...args);

  const firstDay = db.prepare('SELECT MIN(day) day FROM visits').get().day || '';
  const all = count('', []);
  const totals = range ? count('WHERE day >= ?', [since]) : all;

  const countries = db
    .prepare(
      `SELECT country, COUNT(DISTINCT visitor) visitors, SUM(views) views
       FROM visits WHERE day >= ? GROUP BY country ORDER BY visitors DESC, views DESC, country ASC`
    )
    .all(since)
    .map((r) => ({
      code: r.country,
      name: countryLabel(r.country),
      flag: flag(r.country),
      visitors: r.visitors,
      views: r.views,
      share: totals.visitors ? Math.round((100 * r.visitors) / totals.visitors) : 0,
    }));

  // Day by day for a window, month by month for all time.
  let series;
  if (range) {
    const rows = new Map(
      db
        .prepare(
          `SELECT day, COUNT(DISTINCT visitor) visitors, SUM(views) views
           FROM visits WHERE day >= ? GROUP BY day`
        )
        .all(since)
        .map((r) => [r.day, r])
    );
    series = [];
    for (let i = range - 1; i >= 0; i--) {
      const day = daysAgo(i);
      const r = rows.get(day);
      series.push({ label: day, visitors: r ? r.visitors : 0, views: r ? r.views : 0 });
    }
  } else {
    series = db
      .prepare(
        `SELECT substr(day, 1, 7) label, COUNT(DISTINCT visitor) visitors, SUM(views) views
         FROM visits GROUP BY label ORDER BY label`
      )
      .all();
  }

  const pages = db
    .prepare(
      `SELECT path, SUM(views) views FROM pageviews WHERE day >= ?
       GROUP BY path ORDER BY views DESC, path ASC LIMIT 15`
    )
    .all(since);

  return {
    range,
    since: range ? since : firstDay,
    today: count('WHERE day = ?', [daysAgo(0)]),
    week: count('WHERE day >= ?', [daysAgo(6)]),
    month: count('WHERE day >= ?', [daysAgo(29)]),
    all: { ...all, since: firstDay },
    totals,
    countries,
    series,
    pages,
    geo: geoip.status(),
    pending: pending.length,
  };
}

module.exports = {
  middleware,
  start,
  stats,
  lastWeek,
  flush,
  record,
  shouldCount,
  visitorKey,
  countryLabel,
  flag,
  BOT_RE,
};
