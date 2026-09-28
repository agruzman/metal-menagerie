/**
 * shop.js — the public storefront: browsing, product pages and the cart.
 */
const express = require('express');
const { products, getSettings } = require('../db');
const { readCart, addToCart, setQty, shippingOptions } = require('../helpers');

const router = express.Router();

router.get('/', (req, res) => {
  const all = products.listed();
  res.render('home', { products: all });
});

router.get('/shop', (req, res) => {
  res.render('shop', { products: products.listed() });
});

router.get('/product/:slug', (req, res, next) => {
  const product = products.bySlug(req.params.slug);
  if (!product || !product.active) return next();
  const others = products
    .listed()
    .filter((p) => p.id !== product.id)
    .slice(0, 3);
  res.render('product', { product, others });
});

router.get('/about', (req, res) => res.render('about'));

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
    return res.redirect('/cart?msg=' + encodeURIComponent('That piece is sold out.'));
  }
  addToCart(req, product_id, qty || 1);
  res.redirect('/cart');
});

router.post('/cart/update', (req, res) => {
  const body = req.body || {};
  // Form posts qty[<id>] = n for every line at once.
  if (body.qty && typeof body.qty === 'object') {
    for (const [id, n] of Object.entries(body.qty)) setQty(req, id, n);
  }
  if (body.remove) setQty(req, body.remove, 0);
  res.redirect('/cart');
});

module.exports = router;
