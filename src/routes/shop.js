/**
 * shop.js — the public storefront: browsing, product pages, the maker, the cart.
 */
const express = require('express');
const { products, getSettings } = require('../db');
const { readCart, addToCart, setQty, shippingOptions } = require('../helpers');

const router = express.Router();

/** A hand-picked set for the front page, falling back to the first eight. */
const FEATURED = [
  'crowned-eagle', 'lion-king', 'three-wise-monkeys', 'vespa-rider',
  'money-tap', 'sisyphus', 'the-knight', 'drinking-buddies',
];

router.get('/', (req, res) => {
  const all = products.listed();
  const bySlug = Object.fromEntries(all.map((p) => [p.slug, p]));
  let featured = FEATURED.map((s) => bySlug[s]).filter(Boolean);
  if (featured.length < 4) featured = all.slice(0, 8);
  res.render('home', { products: all, featured });
});

router.get('/shop', (req, res) => {
  res.render('shop', { products: products.listed() });
});

router.get('/product/:slug', (req, res, next) => {
  const product = products.bySlug(req.params.slug);
  if (!product || !product.active) return next();
  const listed = products.listed();
  const idx = listed.findIndex((p) => p.id === product.id);
  // three neighbours in catalogue order, wrapping around
  const others = [];
  for (let k = 1; others.length < 3 && k <= listed.length; k++) {
    const p = listed[(idx + k) % listed.length];
    if (p.id !== product.id) others.push(p);
  }
  res.render('product', { product, others });
});

router.get('/genka', (req, res) => res.render('artist'));
router.get('/about', (req, res) => res.redirect(301, '/genka'));

router.get('/policies', (req, res) => {
  res.render('policies', { options: shippingOptions(0, getSettings()) });
});

/* --------------------------------- cart -------------------------------- */

router.get('/cart', (req, res) => {
  const cart = readCart(req);
  res.render('cart', { cart, options: shippingOptions(cart.subtotal_cents) });
});

router.post('/cart/add', (req, res) => {
  const { product_id, qty } = req.body;
  const product = products.byId(product_id);
  if (!product || product.stock < 1) {
    return res.redirect('/cart?msg=' + encodeURIComponent('That piece has already found a home.'));
  }
  addToCart(req, product_id, qty || 1);
  res.redirect('/cart');
});

router.post('/cart/update', (req, res) => {
  const body = req.body || {};
  // Form may post qty[<id>] = n. The body parser turns small numeric keys
  // into an array, whose indexes are NOT product ids — so only accept an object.
  if (body.qty && typeof body.qty === 'object' && !Array.isArray(body.qty)) {
    for (const [id, n] of Object.entries(body.qty)) setQty(req, id, n);
  }
  if (body.remove) setQty(req, body.remove, 0);
  res.redirect('/cart');
});

module.exports = router;
