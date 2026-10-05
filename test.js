/**
 * test.js — checks the parts where a bug would cost real money: prices,
 * the catalogue, cart limits, stock levels, the order-request flow and the
 * "don't charge twice" guard.
 *
 *   npm test
 *
 * It runs against a throwaway database in a temp folder, so your real shop
 * data is never touched.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.SHOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-test-'));
delete process.env.TURSO_DATABASE_URL; // always test against the local file

const assert = require('assert');
const { products, images, orders, getSettings, setSetting, seed, catalogProducts, db } = require('./src/db');
const H = require('./src/helpers');
const { SHIP_TO, BY_CODE, countryName, isDomestic } = require('./src/countries');

let pass = 0;
const t = (name, fn) => { try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n      ' + e.message); process.exitCode = 1; } };

console.log('\nCATALOGUE');
const catalog = catalogProducts();
seed();
t('every catalogue piece is in the shop', () => assert.strictEqual(products.listed().length, catalog.length));
t('there are at least 40 pieces', () => assert.ok(catalog.length >= 40, String(catalog.length)));
t('prices run from $290 to $790', () => {
  const prices = catalog.map((p) => p.price_cents);
  assert.strictEqual(Math.min(...prices), 29000);
  assert.strictEqual(Math.max(...prices), 79000);
});
t('every piece exists exactly once (stock 1)', () => assert.ok(products.listed().every((p) => p.stock === 1)));
t('slugs are unique', () => assert.strictEqual(new Set(catalog.map((p) => p.slug)).size, catalog.length));
t('every main photo and its thumbnail exist on disk', () => {
  for (const p of catalog) {
    const file = path.join(__dirname, 'public', p.image);
    assert.ok(fs.existsSync(file), 'missing ' + p.image);
    assert.ok(fs.existsSync(file.replace(/\.jpg$/, '-sm.jpg')), 'missing thumbnail for ' + p.image);
    for (const g of p.gallery) assert.ok(fs.existsSync(path.join(__dirname, 'public', g)), 'missing ' + g);
  }
});
t('second angles are attached as gallery photos', () => {
  assert.deepStrictEqual(products.bySlug('vespa-rider').gallery, ['/uploads/vespa-rider-2.jpg']);
  assert.deepStrictEqual(products.bySlug('floor-scrubber').gallery, ['/uploads/floor-scrubber-2.jpg']);
});
t('seeding again adds nothing', () => assert.strictEqual(seed(), 0));
t('thumbnails resolve to the -sm copy, with a cache-busting stamp', () =>
  assert.match(H.thumb('/uploads/lion-king.jpg'), /^\/uploads\/lion-king-sm\.jpg\?v=[a-z0-9]+$/));
t('full images get a stamp that changes with the file', () => {
  assert.match(H.asset('/uploads/genka-welding.jpg'), /^\/uploads\/genka-welding\.jpg\?v=[a-z0-9]+$/);
  assert.strictEqual(H.asset('/uploads/1700000000-abc123.jpg'), '/uploads/1700000000-abc123.jpg'); // database photo: no file, no stamp
});
t('the two hero pieces cost the most', () => {
  assert.strictEqual(products.bySlug('crowned-eagle').price_cents, 79000);
  assert.strictEqual(products.bySlug('lion-king').price_cents, 79000);
});

console.log('\nPRODUCTS');
products.create({ slug: 'test-moth', name: 'Test Moth', price_cents: 1234, stock: 1, active: 1, sort_order: 99, gallery: ['/uploads/x.jpg'] });
const moth = products.bySlug('test-moth');
t('create stores every column in the right order', () => {
  assert.strictEqual(moth.name, 'Test Moth');
  assert.strictEqual(moth.price_cents, 1234);
  assert.strictEqual(moth.stock, 1);
  assert.strictEqual(moth.sort_order, 99);
  assert.strictEqual(moth.subtitle, '');
  assert.deepStrictEqual(moth.gallery, ['/uploads/x.jpg']);
});
products.update(moth.id, { ...moth, name: 'Test Moth II', stock: 5, active: 0, image: '/uploads/x.jpg' });
t('update changes the right columns and keeps the gallery', () => {
  const m = products.byId(moth.id);
  assert.strictEqual(m.name, 'Test Moth II');
  assert.strictEqual(m.stock, 5);
  assert.strictEqual(m.active, 0);
  assert.strictEqual(m.image, '/uploads/x.jpg');
  assert.strictEqual(m.slug, 'test-moth');
  assert.deepStrictEqual(m.gallery, ['/uploads/x.jpg']);
});
t('hidden products are not listed', () => assert.ok(!products.listed().some((p) => p.id === moth.id)));

console.log('\nPHOTOS IN THE DATABASE');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
images.put('x.jpg', 'image/jpeg', jpeg);
t('photo round-trips byte for byte', () => {
  const got = images.get('x.jpg');
  assert.strictEqual(got.mime, 'image/jpeg');
  assert.ok(Buffer.isBuffer(got.data));
  assert.ok(got.data.equals(jpeg));
});
t('unknown photo is null', () => assert.strictEqual(images.get('nope.jpg'), null));
images.removeIfUnused('/uploads/x.jpg');
t('photo still in use is kept', () => assert.ok(images.get('x.jpg')));
products.remove(moth.id);
images.removeIfUnused('/uploads/x.jpg');
t('photo removed once nothing uses it', () => assert.strictEqual(images.get('x.jpg'), null));

console.log('\nMONEY');
t('money formats', () => assert.strictEqual(H.money(6800), '$68.00'));
t('toCents from "68.00"', () => assert.strictEqual(H.toCents('68.00'), 6800));
t('toCents from "$1,234.5"', () => assert.strictEqual(H.toCents('$1234.5'), 123450));
t('toCents rounds', () => assert.strictEqual(H.toCents('0.015'), 2));
t('slugify', () => assert.strictEqual(H.slugify('The Wrench-Legged Beetle!'), 'the-wrench-legged-beetle'));

console.log('\nCOUNTRIES');
t('ships to Israel, USA, Emirates and Europe', () => {
  for (const c of ['IL', 'US', 'AE', 'DE', 'FR', 'GB', 'CH', 'NO']) assert.ok(BY_CODE[c], c);
});
t('does not ship elsewhere', () => { for (const c of ['CN', 'BR', 'AU', 'CA', 'RU']) assert.ok(!BY_CODE[c], c); });
t('country names', () => assert.strictEqual(countryName('AE'), 'United Arab Emirates'));
t('Israel is domestic', () => { assert.ok(isDomestic('il', 'IL')); assert.ok(!isDomestic('DE', 'IL')); });
t('the settings list matches', () =>
  assert.strictEqual(getSettings().ship_countries.split(',').length, SHIP_TO.length));

console.log('\nCART');
const req = { session: {} };
const beetle = products.bySlug('wrench-legged-beetle');   // stock 1, $440
const bug    = products.bySlug('ladybird-in-red');        // stock 1, $390
H.addToCart(req, beetle.id, 1);
H.addToCart(req, bug.id, 1);
t('cart counts items', () => assert.strictEqual(H.readCart(req).count, 2));
t('cart subtotal is right', () => assert.strictEqual(H.readCart(req).subtotal_cents, 44000 + 39000));
H.addToCart(req, beetle.id, 99);
t('cannot add more than the one that exists', () => assert.strictEqual(req.session.cart[beetle.id], 1));
H.setQty(req, bug.id, 0);
t('setting qty 0 removes the line', () => assert.strictEqual(H.readCart(req).lines.length, 1));

console.log('\nSHIPPING');
let opts = H.shippingOptions(1000);
t('two options offered', () => assert.strictEqual(opts.length, 2));
t('within Israel costs $15', () => assert.strictEqual(opts[0].cents, 1500));
t('abroad costs $39', () => assert.strictEqual(opts[1].cents, 3900));
t('destination picks the rate', () => {
  assert.strictEqual(H.shippingFor('IL', 1000).id, 'domestic');
  assert.strictEqual(H.shippingFor('DE', 1000).id, 'international');
  assert.strictEqual(H.shippingFor('US', 1000).cents, 3900);
});
setSetting('free_shipping_over_cents', '15000');
t('free over threshold', () => assert.strictEqual(H.shippingOptions(15000)[0].cents, 0));
t('threshold is exclusive below', () => assert.strictEqual(H.shippingOptions(14999)[0].cents, 1500));
setSetting('free_shipping_over_cents', '0');
t('threshold of 0 disables free shipping', () => assert.strictEqual(H.shippingOptions(999999)[0].cents, 1500));

console.log('\nORDER REQUEST → PAID');
const cart = H.readCart(req); // just the beetle
const order = orders.create({
  provider: 'request', status: 'pending', items: H.cartToItems(cart.lines),
  subtotal_cents: cart.subtotal_cents, total_cents: cart.subtotal_cents,
});
t('order ref generated', () => assert.match(order.ref, /^MM-/));
t('order starts pending', () => assert.strictEqual(order.status, 'pending'));

orders.saveRequest(order.id, {
  email: 'buyer@example.com', customer_name: 'A Buyer', phone: '+49 170 000000',
  address: { line1: 'Forge Lane 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
  shipping_cents: 3900, total_cents: 44000 + 3900, shipping_label: 'abroad', notes: 'gift',
});
const requested = orders.byRef(order.ref);
t('request stored with contact details', () => {
  assert.strictEqual(requested.status, 'requested');
  assert.strictEqual(requested.phone, '+49 170 000000');
  assert.strictEqual(requested.address.country, 'DE');
  assert.strictEqual(requested.notes, 'gift');
  assert.strictEqual(requested.total_cents, 47900);
});
t('a request does not touch stock yet', () => assert.strictEqual(products.byId(beetle.id).stock, 1));
t('dashboard counts the new request', () => assert.strictEqual(orders.stats().requested, 1));
t('a request is not counted as revenue', () => assert.strictEqual(orders.stats().revenue_cents, 0));

const applied = orders.markPaid(order.id, {});
t('marking paid reports it applied', () => assert.strictEqual(applied, true));
const paid = orders.byRef(order.ref);
t('order is paid and keeps the buyer details', () => {
  assert.strictEqual(paid.status, 'paid');
  assert.strictEqual(paid.email, 'buyer@example.com');
  assert.strictEqual(paid.address.city, 'Berlin');
  assert.strictEqual(paid.total_cents, 47900);
});
t('the piece is now off the shelf', () => assert.strictEqual(products.byId(beetle.id).stock, 0));
t('items frozen at purchase price', () => assert.strictEqual(paid.items[0].price_cents, 44000));
t('marking paid twice is ignored', () => assert.strictEqual(orders.markPaid(order.id, {}), false));
t('stock not double-decremented', () => assert.strictEqual(products.byId(beetle.id).stock, 0));

console.log('\nSOLD-OUT BEHAVIOUR');
const req2 = { session: {} };
H.addToCart(req2, beetle.id, 1);
t('a sold piece cannot enter a cart', () => assert.strictEqual(H.readCart(req2).count, 0));

console.log('\nREFUND RESTOCKS');
for (const i of paid.items) products.adjustStock(i.id, i.qty);
db.prepare('UPDATE orders SET stock_applied = 0 WHERE id = ?').run(paid.id);
orders.setStatus(paid.id, 'refunded', {});
t('the piece is back on the shelf', () => assert.strictEqual(products.byId(beetle.id).stock, 1));
t('stock never goes negative', () => {
  products.adjustStock(beetle.id, -99);
  assert.strictEqual(products.byId(beetle.id).stock, 0);
  products.adjustStock(beetle.id, 1);
});
t('refunded order left the revenue figure', () => assert.strictEqual(orders.stats().count, 0));

console.log('\nWHERE VISITORS ARE (IP → COUNTRY)');
const G = require('./src/geoip');
G._load(
  [
    'start_ip,end_ip,country', // a header line must be ignored
    '8.8.8.0,8.8.8.255,US',
    '1.0.0.0,1.0.0.255,AU', // out of order on purpose
    '1.0.1.0,1.0.3.255,CN',
    '5.29.0.0,5.29.255.255,IL',
    '10.0.0.0,10.255.255.255,ZZ', // "no country" rows are dropped
    '2a01:4f8::,2a01:4f8:ffff:ffff:ffff:ffff:ffff:ffff,DE',
    '2001:4860::,2001:4860:ffff:ffff:ffff:ffff:ffff:ffff,US',
    '',
  ].join('\n')
);
t('IPv4 address → country', () => assert.strictEqual(G.lookup('8.8.8.8'), 'US'));
t('unsorted input is sorted first', () => assert.strictEqual(G.lookup('1.0.0.9'), 'AU'));
t('range ends are inclusive', () => {
  assert.strictEqual(G.lookup('1.0.3.255'), 'CN');
  assert.strictEqual(G.lookup('1.0.4.0'), '');
});
t('IPv4-mapped address (how Node reports IPv4 clients) → country', () =>
  assert.strictEqual(G.lookup('::ffff:5.29.100.1'), 'IL'));
t('IPv6 address → country', () => {
  assert.strictEqual(G.lookup('2a01:4f8:1:2::3'), 'DE');
  assert.strictEqual(G.lookup('2001:4860:4860::8888'), 'US');
  assert.strictEqual(G.lookup('2a02::1'), '');
});
t('private, loopback and garbage → unknown', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '::1', 'not-an-ip', '999.1.1.1', '', undefined]) {
    assert.strictEqual(G.lookup(ip), '', String(ip));
  }
});
t('IP parsing handles the awkward forms', () => {
  assert.deepStrictEqual(G.parseIp('[2a01:4f8::1]'), { v: 6, hi: 0x2a0104f800000000n, lo: 1n });
  assert.deepStrictEqual(G.parseIp('fe80::1%eth0'), { v: 6, hi: 0xfe80000000000000n, lo: 1n });
  assert.deepStrictEqual(G.parseIp('16843009'), { v: 4, n: 0x01010101 });
  assert.strictEqual(G.parseIp('1::2::3'), null);
  assert.strictEqual(G.parseIp('1:2:3:4:5:6:7'), null);
});
t('the proxy header wins when present, nonsense in it is ignored', () => {
  assert.strictEqual(G.countryOf({ headers: { 'cf-ipcountry': 'fr' }, ip: '8.8.8.8' }), 'FR');
  assert.strictEqual(G.countryOf({ headers: { 'cf-ipcountry': 'XX' }, ip: '8.8.8.8' }), 'US');
  assert.strictEqual(G.countryOf({ headers: {}, ip: '::ffff:8.8.8.8' }), 'US');
});
t("the visitor's real address comes from Cloudflare's header first", () => {
  assert.strictEqual(G.clientIp({ headers: { 'cf-connecting-ip': '8.8.8.8', 'x-forwarded-for': '1.1.1.1' }, ip: '127.0.0.1' }), '8.8.8.8');
  assert.strictEqual(G.clientIp({ headers: { 'true-client-ip': '8.8.4.4' }, ip: '127.0.0.1' }), '8.8.4.4');
  assert.strictEqual(G.clientIp({ headers: {}, ip: '5.29.0.1' }), '5.29.0.1');
});
t('monthly list URLs are well formed, newest first', () => {
  const urls = G.monthUrls();
  assert.strictEqual(urls.length, 2);
  assert.match(urls[0], /^https:\/\/download\.db-ip\.com\/free\/dbip-country-lite-\d{4}-\d{2}\.csv\.gz$/);
  assert.notStrictEqual(urls[0], urls[1]);
});
t('status says the list is loaded', () => {
  const s = G.status();
  assert.strictEqual(s.ready, true);
  assert.strictEqual(s.rows, 6);
  assert.strictEqual(G.waiting(), false);
});

console.log('\nCOUNTING VISITORS');
const V = require('./src/visits');
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const browse = (over = {}, headers = {}) => ({
  method: 'GET',
  path: '/',
  ip: '8.8.8.8',
  ...over,
  headers: {
    'user-agent': CHROME,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    ...headers,
  },
});
t('a browser opening a page counts', () => {
  assert.ok(V.shouldCount(browse()));
  assert.ok(V.shouldCount(browse({ path: '/product/lion-king' })));
  assert.ok(V.shouldCount(browse({}, { 'user-agent': IPHONE })));
  assert.ok(V.shouldCount(browse({}, { 'user-agent': CHROME, accept: 'text/html' })), 'minimal headers');
});
t('the admin panel, photos, files and the keep-alive do not count', () => {
  for (const p of ['/admin', '/admin/orders/3', '/uploads/lion-king.jpg', '/css/style.css', '/healthz', '/favicon.ico', '/robots.txt', '/webhooks/stripe']) {
    assert.ok(!V.shouldCount(browse({ path: p })), p);
  }
});
t('bots, tools and link previews do not count', () => {
  for (const ua of [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'curl/8.4.0',
    'python-requests/2.31',
    'Go-http-client/1.1',
    'facebookexternalhit/1.1',
    'WhatsApp/2.23.20.0',
    'Mozilla/5.0 (compatible; bingbot/2.0)',
    'node',
    '',
  ]) {
    assert.ok(!V.shouldCount(browse({}, { 'user-agent': ua })), ua || '(empty)');
  }
});
t('POSTs, non-HTML requests, prefetches and embedded frames do not count', () => {
  assert.ok(!V.shouldCount(browse({ method: 'POST' })));
  assert.ok(!V.shouldCount(browse({}, { accept: '*/*' })));
  assert.ok(!V.shouldCount(browse({}, { accept: 'application/json' })));
  assert.ok(!V.shouldCount(browse({}, { 'sec-purpose': 'prefetch' })));
  assert.ok(!V.shouldCount(browse({}, { 'sec-fetch-dest': 'iframe' })));
  assert.ok(!V.shouldCount(browse({}, { 'sec-fetch-mode': 'cors' })));
});
t('the same browser on the same address is the same visitor; others are not', () => {
  assert.strictEqual(V.visitorKey(browse()), V.visitorKey(browse({ path: '/shop' })));
  assert.notStrictEqual(V.visitorKey(browse()), V.visitorKey(browse({ ip: '5.29.0.1' })));
  assert.notStrictEqual(V.visitorKey(browse()), V.visitorKey(browse({}, { 'user-agent': IPHONE })));
  assert.match(V.visitorKey(browse()), /^[0-9a-f]{24}$/);
});

V.record(browse());                                    // US, home
V.record(browse({ path: '/shop' }));                   // same person, second page
V.record(browse({ path: '/product/lion-king/' }));     // same person, trailing slash
V.record(browse({ ip: '5.29.0.1' }, { 'user-agent': IPHONE }));                // IL
V.record(browse({ ip: '::ffff:1.0.2.2', path: '/product/lion-king' }));          // CN, via IPv4-mapped address
V.record(browse({ ip: '203.0.113.9' }, { 'cf-ipcountry': 'FR' }));              // country from the proxy header
V.record(browse({ ip: '192.168.1.5', path: '/order/details/MM-ABC-1234' }));     // unknown country
t('hits are written in one batch', () => assert.strictEqual(V.flush(true), 7));
t('a second flush has nothing to do', () => assert.strictEqual(V.flush(true), 0));

const S = V.stats(30);
t('unique visitors today, and their page views', () => {
  assert.strictEqual(S.today.visitors, 5);
  assert.strictEqual(S.today.views, 7);
  assert.strictEqual(S.all.visitors, 5);
  assert.strictEqual(S.week.visitors, 5);
  assert.strictEqual(S.month.visitors, 5);
});
t('visitors by country, biggest first, with names and shares', () => {
  assert.deepStrictEqual(
    S.countries.map((c) => [c.code, c.visitors, c.views]),
    [['', 1, 1], ['CN', 1, 1], ['FR', 1, 1], ['IL', 1, 1], ['US', 1, 3]].sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]))
  );
  const us = S.countries.find((c) => c.code === 'US');
  assert.strictEqual(us.name, 'United States');
  assert.strictEqual(us.flag, '🇺🇸');
  assert.strictEqual(us.share, 20);
  assert.strictEqual(S.countries.find((c) => c.code === '').name, 'Unknown');
  assert.strictEqual(V.countryLabel('IL'), 'Israel');
});
t('day-by-day series covers the whole window and ends today', () => {
  assert.strictEqual(S.series.length, 30);
  const last = S.series[S.series.length - 1];
  assert.strictEqual(last.label, new Date().toISOString().slice(0, 10));
  assert.strictEqual(last.visitors, 5);
  assert.strictEqual(S.series[0].visitors, 0);
});
t('most viewed pages, tidied', () => {
  assert.deepStrictEqual(S.pages.slice(0, 2).map((p) => [p.path, p.views]), [['/', 3], ['/product/lion-king', 2]]);
  assert.ok(S.pages.some((p) => p.path === '/order/details'), 'order reference stripped from the path');
  assert.ok(!S.pages.some((p) => p.path.length > 1 && p.path.endsWith('/')), 'no trailing slashes');
});
t('all-time view groups by month', () => {
  const A = V.stats(0);
  assert.strictEqual(A.range, 0);
  assert.strictEqual(A.series.length, 1);
  assert.strictEqual(A.series[0].label, new Date().toISOString().slice(0, 7));
  assert.strictEqual(A.series[0].visitors, 5);
  assert.strictEqual(A.since, new Date().toISOString().slice(0, 10));
});
t('an unknown range falls back to 30 days', () => assert.strictEqual(V.stats('yesterday').range, 30));
t('the same visitor again today adds views, not visitors', () => {
  V.record(browse({ path: '/genka' }));
  V.flush(true);
  const s = V.stats(7);
  assert.strictEqual(s.today.visitors, 5);
  assert.strictEqual(s.today.views, 8);
  assert.strictEqual(V.lastWeek().visitors, 5);
});
t('no IP address is stored anywhere', () => {
  const dump = JSON.stringify(db.prepare('SELECT * FROM visits').all()) + JSON.stringify(db.prepare('SELECT * FROM pageviews').all());
  for (const ip of ['8.8.8.8', '5.29.0.1', '1.0.2.2', '203.0.113.9', '192.168.1.5']) assert.ok(!dump.includes(ip), ip);
});

fs.rmSync(process.env.SHOP_DATA_DIR, { recursive: true, force: true });
console.log(`\n${pass} checks passed.`);
