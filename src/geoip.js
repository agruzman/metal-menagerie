/**
 * geoip.js — which country a visitor is in, worked out from their IP address.
 *
 * Nothing to sign up for, nothing to install. When the server starts it
 * downloads the free "IP to Country Lite" list published by DB-IP
 * (https://db-ip.com — CC BY 4.0, hence the credit line on the Visitors
 * page), keeps it in memory as sorted address ranges and finds a country by
 * binary search. The list is roughly 25 MB of text, about 8 MB to download,
 * refreshed monthly. A copy is kept in the data folder so a restart on a
 * host that keeps its disk does not download it again.
 *
 * Hosts that sit behind Cloudflare sometimes send the visitor's country in a
 * `CF-IPCountry` header; when it is there it is used and the list is not
 * consulted.
 *
 * Switch the whole thing off with GEOIP=0 (visitors are still counted, just
 * without a country). GEOIP_URL points at another list in the same
 * "start_ip,end_ip,country" shape should DB-IP ever move theirs.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DATA_DIR } = require('./paths');

const ENABLED = process.env.GEOIP !== '0';
const FILE = process.env.GEOIP_FILE || path.join(DATA_DIR, 'ip-to-country.csv');
const MAX_AGE_DAYS = 35; // DB-IP publishes a new list on the 1st of every month
const MIN_RANGES = 1000; // anything smaller is not the list we expected

const state = {
  enabled: ENABLED,
  ready: false, // a list is loaded and lookups work
  loading: false,
  rows: 0,
  source: '',
  loadedAt: null,
  error: '',
};

let table = null;
const startedAt = Date.now();

/* ----------------------------- IP parsing ------------------------------ */

const MASK64 = (1n << 64n) - 1n;

/** "1.2.3.4" -> { v: 4, n }, "2a01::1" -> { v: 6, hi, lo }, or null. */
function parseIp(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (s[0] === '[') s = s.slice(1, s.indexOf(']') === -1 ? undefined : s.indexOf(']'));
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (/^\d+$/.test(s)) {
    // Plain decimal, as some lists publish it.
    const big = BigInt(s);
    if (big <= 0xffffffffn) return { v: 4, n: Number(big) };
    if (big > (1n << 128n) - 1n) return null;
    return { v: 6, hi: big >> 64n, lo: big & MASK64 };
  }
  return s.includes(':') ? parseV6(s) : parseV4(s);
}

function parseV4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return { v: 4, n };
}

function parseV6(s) {
  // A dotted IPv4 tail ("::ffff:1.2.3.4") becomes two ordinary groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    s = s.slice(0, lastColon + 1) + (v4.n >>> 16).toString(16) + ':' + (v4.n & 0xffff).toString(16);
  }

  let groups;
  const gap = s.indexOf('::');
  if (gap !== -1) {
    if (s.indexOf('::', gap + 1) !== -1) return null; // only one "::" allowed
    const head = s.slice(0, gap) ? s.slice(0, gap).split(':') : [];
    const rest = s.slice(gap + 2) ? s.slice(gap + 2).split(':') : [];
    if (head.length + rest.length > 7) return null;
    groups = [...head, ...new Array(8 - head.length - rest.length).fill('0'), ...rest];
  } else {
    groups = s.split(':');
    if (groups.length !== 8) return null;
  }

  let hi = 0n;
  let lo = 0n;
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const g = BigInt(parseInt(groups[i], 16));
    if (i < 4) hi = (hi << 16n) | g;
    else lo = (lo << 16n) | g;
  }
  // IPv4-mapped addresses (what Node reports for IPv4 clients on a dual-stack
  // socket) are looked up in the IPv4 table.
  if (hi === 0n && lo >> 32n === 0xffffn) return { v: 4, n: Number(lo & 0xffffffffn) };
  return { v: 6, hi, lo };
}

/* --------------------------- the range table --------------------------- */

/**
 * Turns "start_ip,end_ip,country" lines into typed arrays: two sorted lists
 * of ranges (IPv4 as 32-bit numbers, IPv6 as two 64-bit halves) plus the
 * list of country codes they point into. Rows with no real country ("ZZ")
 * are dropped — a miss already means "unknown".
 */
function parseTable(text) {
  const lines = String(text).split('\n');
  const n = lines.length;
  const s4 = new Uint32Array(n);
  const e4 = new Uint32Array(n);
  const c4 = new Uint16Array(n);
  const s6h = new BigUint64Array(n);
  const s6l = new BigUint64Array(n);
  const e6h = new BigUint64Array(n);
  const e6l = new BigUint64Array(n);
  const c6 = new Uint16Array(n);
  const codes = [''];
  const codeIndex = new Map([['', 0]]);
  let n4 = 0;
  let n6 = 0;

  for (let line of lines) {
    line = line.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const code = parts[2].trim().replace(/"/g, '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) || code === 'ZZ') continue;
    const a = parseIp(parts[0].replace(/"/g, ''));
    const b = parseIp(parts[1].replace(/"/g, ''));
    if (!a || !b || a.v !== b.v) continue;
    let ci = codeIndex.get(code);
    if (ci === undefined) {
      ci = codes.length;
      codes.push(code);
      codeIndex.set(code, ci);
    }
    if (a.v === 4) {
      s4[n4] = a.n;
      e4[n4] = b.n;
      c4[n4] = ci;
      n4++;
    } else {
      s6h[n6] = a.hi;
      s6l[n6] = a.lo;
      e6h[n6] = b.hi;
      e6l[n6] = b.lo;
      c6[n6] = ci;
      n6++;
    }
  }

  const t = {
    codes,
    v4: { start: s4.slice(0, n4), end: e4.slice(0, n4), cc: c4.slice(0, n4) },
    v6: {
      sh: s6h.slice(0, n6),
      sl: s6l.slice(0, n6),
      eh: e6h.slice(0, n6),
      el: e6l.slice(0, n6),
      cc: c6.slice(0, n6),
    },
  };
  sortV4(t.v4);
  sortV6(t.v6);
  return t;
}

/** The published lists are sorted already; this only does work if one is not. */
function sortV4(v) {
  let sorted = true;
  for (let i = 1; i < v.start.length && sorted; i++) if (v.start[i] < v.start[i - 1]) sorted = false;
  if (sorted) return;
  const order = Array.from(v.start.keys()).sort((a, b) => v.start[a] - v.start[b]);
  for (const key of ['start', 'end', 'cc']) v[key] = v[key].constructor.from(order, (i) => v[key][i]);
}

function le6(ah, al, bh, bl) {
  return ah < bh || (ah === bh && al <= bl);
}

function sortV6(v) {
  let sorted = true;
  for (let i = 1; i < v.sh.length && sorted; i++) {
    if (!le6(v.sh[i - 1], v.sl[i - 1], v.sh[i], v.sl[i])) sorted = false;
  }
  if (sorted) return;
  const order = Array.from(v.sh.keys()).sort((a, b) =>
    le6(v.sh[a], v.sl[a], v.sh[b], v.sl[b]) ? (v.sh[a] === v.sh[b] && v.sl[a] === v.sl[b] ? 0 : -1) : 1
  );
  for (const key of ['sh', 'sl', 'eh', 'el', 'cc']) v[key] = v[key].constructor.from(order, (i) => v[key][i]);
}

function install(t, source) {
  table = t;
  state.ready = true;
  state.rows = t.v4.start.length + t.v6.sh.length;
  state.source = source;
  state.loadedAt = new Date().toISOString();
  state.error = '';
  console.log(`[geoip] IP-to-country list loaded: ${state.rows.toLocaleString('en-US')} ranges (${source})`);
}

/* -------------------------------- lookup ------------------------------- */

/** ISO 3166-1 alpha-2 code for an address, or '' when unknown. */
function lookup(ip) {
  if (!table) return '';
  const p = parseIp(ip);
  if (!p) return '';
  if (p.v === 4) {
    const { start, end, cc } = table.v4;
    let lo = 0;
    let hi = start.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (start[mid] <= p.n) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 && p.n <= end[found] ? table.codes[cc[found]] : '';
  }
  const { sh, sl, eh, el, cc } = table.v6;
  let lo = 0;
  let hi = sh.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (le6(sh[mid], sl[mid], p.hi, p.lo)) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && le6(p.hi, p.lo, eh[found], el[found]) ? table.codes[cc[found]] : '';
}

/**
 * The visitor's own address. Render (and anything else fronted by
 * Cloudflare) puts it in CF-Connecting-IP / True-Client-IP, which a visitor
 * cannot forge; req.ip is the fallback for other hosts and for a laptop.
 */
function clientIp(req) {
  const h = req.headers || {};
  const raw = h['cf-connecting-ip'] || h['true-client-ip'] || req.ip || '';
  return String(raw).split(',')[0].trim();
}

/** Country from the proxy's own header when it sends one, else from the list. */
function countryOf(req) {
  const h = (req && req.headers) || {};
  const fromProxy = String(h['cf-ipcountry'] || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(fromProxy) && fromProxy !== 'XX' && fromProxy !== 'T1') return fromProxy;
  return lookup(clientIp(req));
}

/**
 * True while a lookup would be premature: the list is still on its way. The
 * visit counter holds its hits back a little while this is the case, so the
 * first visitors after a restart get a country too. Gives up after 2 minutes.
 */
function waiting() {
  return ENABLED && !state.ready && !state.error && Date.now() - startedAt < 120_000;
}

/* ----------------------------- downloading ----------------------------- */

function monthUrls() {
  const urls = [];
  const d = new Date();
  for (let back = 0; back < 2; back++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
    const stamp = `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
    urls.push(`https://download.db-ip.com/free/dbip-country-lite-${stamp}.csv.gz`);
  }
  return urls;
}

async function download() {
  if (state.loading) return false;
  if (typeof fetch !== 'function') {
    state.error = 'This version of Node has no fetch(); Node 18 or newer is needed to download the IP-to-country list.';
    return false;
  }
  state.loading = true;
  const urls = process.env.GEOIP_URL ? [process.env.GEOIP_URL] : monthUrls();
  let lastErr = null;
  try {
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(180_000),
          headers: { 'user-agent': 'metal-menagerie shop (monthly IP-to-country refresh)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        let buf = Buffer.from(await res.arrayBuffer());
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
        const text = buf.toString('utf8');
        const t = parseTable(text);
        if (t.v4.start.length < MIN_RANGES) throw new Error(`${url} does not look like an IP-to-country list`);
        try {
          // Temp name first, then rename: a crash mid-write cannot leave half a file.
          fs.writeFileSync(FILE + '.tmp', text);
          fs.renameSync(FILE + '.tmp', FILE);
        } catch {
          /* read-only disk — we still have it in memory */
        }
        install(t, new URL(url).host);
        return true;
      } catch (err) {
        lastErr = err;
      }
    }
    state.error =
      `Could not fetch the IP-to-country list (${lastErr ? lastErr.message : 'unknown error'}). ` +
      'Visitors are still counted; their countries show as unknown until the next attempt (daily).';
    console.warn('[geoip] ' + state.error);
    return false;
  } finally {
    state.loading = false;
  }
}

/** Loads the saved copy if there is one, downloads if there is not or it is old, then checks daily. */
function start() {
  if (!ENABLED) return;
  let fresh = false;
  try {
    const st = fs.statSync(FILE);
    const t = parseTable(fs.readFileSync(FILE, 'utf8'));
    if (t.v4.start.length >= MIN_RANGES) {
      install(t, path.basename(FILE));
      fresh = (Date.now() - st.mtimeMs) / 86_400_000 < MAX_AGE_DAYS;
    }
  } catch {
    /* no saved copy yet */
  }
  if (!fresh) download();
  setInterval(() => {
    let age = Infinity;
    try {
      age = (Date.now() - fs.statSync(FILE).mtimeMs) / 86_400_000;
    } catch {
      /* no file */
    }
    if (!state.ready || age >= MAX_AGE_DAYS) download();
  }, 24 * 60 * 60 * 1000).unref();
}

function status() {
  return { ...state };
}

/** For tests: load a list from a string instead of the network. */
function _load(text, source = 'test') {
  install(parseTable(text), source);
}

module.exports = {
  start,
  lookup,
  countryOf,
  clientIp,
  waiting,
  status,
  parseIp,
  parseTable,
  monthUrls,
  download,
  _load,
};
