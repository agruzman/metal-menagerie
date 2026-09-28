/**
 * test.js — checks the parts where a bug would cost real money: prices,
 * cart limits, stock levels and the "don't charge twice" guard.
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
const { products, images, orders, getSettings, setSetting, seed, db } = require('./src/db');
const H = require('./src/helpers');

let pass = 0;
const t = (name, fn) => { try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n      ' + e.message); process.exitCode = 1; } };

console.log('\nSEED');
seed();
t('three starter products exist', () => assert.strictEqual(products.listed().length, 3));
t('stock seeded', () => assert.strictEqual(products.bySlug('wrench-legged-beetle').stock, 2));

console.log('\nPRODUCTS');
products.create({ slug: 'test-moth', name: 'Test Moth', price_cents: 1234, stock: 1, active: 1, sort_order: 9 });
const moth = products.bySlug('test-moth');
t('create stores every column in the right order', () => {
  assert.strictEqual(moth.name, 'Test Moth');
  assert.strictEqual(moth.price_cents, 1234);
  assert.strictEqual(moth.stock, 1);
  assert.strictEqual(moth.sort_order, 9);
  assert.strictEqual(moth.subtitle, '');
});
products.update(moth.id, { ...moth, name: 'Test Moth II', stock: 5, active: 0, image: '/uploads/x.jpg' });
t('update changes the right columns', () => {
  const m = products.byId(moth.id);
  assert.strictEqual(m.name, 'Test Moth II');
  assert.strictEqual(m.stock, 5);
  assert.strictEqual(m.active, 0);
  assert.strictEqual(m.image, '/uploads/x.jpg');
  assert.strictEqual(m.slug, 'test-moth');
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
t('static seeded photo paths are left alone', () => { images.removeIfUnused('/uploads/ladybug.jpg'); });

console.log('\nMONEY');
t('money formats', () => assert.strictEqual(H.money(6800), '$68.00'));
t('toCents from "68.00"', () => assert.strictEqual(H.toCents('68.00'), 6800));
t('toCents from "$1,234.5"', () => assert.strictEqual(H.toCents('$1234.5'), 123450));
t('toCents rounds', () => assert.strictEqual(H.toCents('0.015'), 2));
t('slugify', () => assert.strictEqual(H.slugify('The Wrench-Legged Beetle!'), 'the-wrench-legged-beetle'));

console.log('\nCART');
const req = { session: {} };
const beetle = products.bySlug('wrench-legged-beetle');   // stock 2, 95.00
const bug    = products.bySlug('ladybird-in-red');        // stock 4, 68.00
H.addToCart(req, beetle.id, 1);
H.addToCart(req, bug.id, 2);
t('cart counts items', () => assert.strictEqual(H.readCart(req).count, 3));
t('cart subtotal is right', () =>
  assert.strictEqual(H.readCart(req).subtotal_cents, 9500 + 2 * 6800));
H.addToCart(req, beetle.id, 99);
t('cannot add more than stock', () => assert.strictEqual(req.session.cart[beetle.id], 2));
H.setQty(req, bug.id, 0);
t('setting qty 0 removes the line', () => assert.strictEqual(H.readCart(req).lines.length, 1));

console.log('\nSHIPPING');
let opts = H.shippingOptions(1000);
t('two options offered', () => assert.strictEqual(opts.length, 2));
t('domestic costs $8', () => assert.strictEqual(opts[0].cents, 800));
t('international costs $24', () => assert.strictEqual(opts[1].cents, 2400));
t('free over threshold', () => assert.strictEqual(H.shippingOptions(15000)[0].cents, 0));
t('threshold is exclusive below', () => assert.strictEqual(H.shippingOptions(14999)[0].cents, 800));
setSetting('free_shipping_over_cents', '0');
t('threshold of 0 disables free shipping', () => assert.strictEqual(H.shippingOptions(999999)[0].cents, 800));
setSetting('free_shipping_over_cents', '15000');

console.log('\nORDER + STOCK');
H.setQty(req, beetle.id, 2);
const cart = H.readCart(req);
const order = orders.create({
  provider: 'demo', status: 'pending', items: H.cartToItems(cart.lines),
  subtotal_cents: cart.subtotal_cents, total_cents: cart.subtotal_cents,
});
t('order ref generated', () => assert.match(order.ref, /^MM-/));
t('order starts pending', () => assert.strictEqual(order.status, 'pending'));
t('stock untouched while pending', () => assert.strictEqual(products.byId(beetle.id).stock, 2));

const applied = orders.markPaid(order.id, {
  email: 'buyer@example.com', customer_name: 'A Buyer',
  address: { line1: '1 Forge Lane', city: 'Leeds', country: 'GB' },
  shipping_cents: 2400, total_cents: cart.subtotal_cents + 2400,
  shipping_label: 'International', provider_ref: 'demo-1',
});
t('markPaid reports it applied', () => assert.strictEqual(applied, true));
const paid = orders.byRef(order.ref);
t('order is paid', () => assert.strictEqual(paid.status, 'paid'));
t('stock decremented by 2', () => assert.strictEqual(products.byId(beetle.id).stock, 0));
t('total includes shipping', () => assert.strictEqual(paid.total_cents, 19000 + 2400));
t('address stored', () => assert.strictEqual(paid.address.city, 'Leeds'));
t('items frozen at purchase price', () => assert.strictEqual(paid.items[0].price_cents, 9500));

const again = orders.markPaid(order.id, { email: 'buyer@example.com' });
t('duplicate webhook is ignored', () => assert.strictEqual(again, false));
t('stock not double-decremented', () => assert.strictEqual(products.byId(beetle.id).stock, 0));

console.log('\nSOLD-OUT BEHAVIOUR');
const req2 = { session: {} };
H.addToCart(req2, beetle.id, 1);
t('sold-out item cannot enter a cart', () => assert.strictEqual(H.readCart(req2).count, 0));

console.log('\nREFUND RESTOCKS');
for (const i of paid.items) products.adjustStock(i.id, i.qty);
db.prepare('UPDATE orders SET stock_applied = 0 WHERE id = ?').run(paid.id);
orders.setStatus(paid.id, 'refunded', {});
t('stock returned to the shelf', () => assert.strictEqual(products.byId(beetle.id).stock, 2));
t('stock never goes negative', () => {
  products.adjustStock(beetle.id, -99);
  assert.strictEqual(products.byId(beetle.id).stock, 0);
  products.adjustStock(beetle.id, 2);
});

console.log('\nDASHBOARD FIGURES');
const s = orders.stats();
t('stats count only paid/shipped', () => assert.strictEqual(typeof s.revenue_cents, 'number'));
t('refunded order left the revenue figure', () => assert.strictEqual(s.count, 0));

fs.rmSync(process.env.SHOP_DATA_DIR, { recursive: true, force: true });
console.log(`\n${pass} checks passed.`);
