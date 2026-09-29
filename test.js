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
t('thumbnails resolve to the -sm copy', () =>
  assert.strictEqual(H.thumb('/uploads/lion-king.jpg'), '/uploads/lion-king-sm.jpg'));
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

fs.rmSync(process.env.SHOP_DATA_DIR, { recursive: true, force: true });
console.log(`\n${pass} checks passed.`);
