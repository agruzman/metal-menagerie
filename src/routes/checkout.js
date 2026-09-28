/**
 * checkout.js — taking the money.
 *
 * The card details never touch this server. We hand the buyer to Stripe's own
 * hosted checkout page, Stripe charges the card and collects the shipping
 * address, then tells us the result. That is what keeps you out of PCI
 * compliance work, and it is why this file is short.
 *
 * If STRIPE_SECRET_KEY is missing, the shop falls back to DEMO MODE: a plain
 * form that records a real order without charging anything, so you can test
 * the whole flow before you ever sign up to Stripe.
 */
const express = require('express');
const { products, orders, getSettings } = require('../db');
const {
  readCart,
  clearCart,
  cartToItems,
  shippingOptions,
  shippingOptionById,
  money,
} = require('../helpers');
const { sendOrderEmails } = require('../mailer');

const router = express.Router();

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const LIVE = Boolean(STRIPE_KEY);
const stripe = LIVE ? require('stripe')(STRIPE_KEY) : null;
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const PUBLIC_IMAGES = BASE_URL.startsWith('https://');

/** Refuses to sell what is not on the shelf. Returns an error string or null. */
function stockProblem(cart) {
  for (const line of cart.lines) {
    const fresh = products.byId(line.product.id);
    if (!fresh || !fresh.active) return `${line.product.name} is no longer available.`;
    if (fresh.stock < line.qty) {
      return fresh.stock === 0
        ? `${fresh.name} has just sold out.`
        : `Only ${fresh.stock} of ${fresh.name} left — please lower the quantity.`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Start checkout                                                      *
 * ------------------------------------------------------------------ */

router.post('/checkout', async (req, res, next) => {
  try {
    const settings = getSettings();
    const cart = readCart(req);
    if (cart.count === 0) return res.redirect('/cart');

    const problem = stockProblem(cart);
    if (problem) return res.redirect('/cart?msg=' + encodeURIComponent(problem));

    const items = cartToItems(cart.lines);
    const order = orders.create({
      provider: LIVE ? 'stripe' : 'demo',
      status: 'pending',
      items,
      subtotal_cents: cart.subtotal_cents,
      total_cents: cart.subtotal_cents,
      currency: settings.currency,
    });

    if (!LIVE) {
      return res.redirect(`/checkout/demo/${order.ref}`);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: order.ref,
      metadata: { order_ref: order.ref },
      line_items: items.map((i) => ({
        quantity: i.qty,
        price_data: {
          currency: settings.currency,
          unit_amount: i.price_cents,
          product_data: {
            name: i.name,
            ...(PUBLIC_IMAGES && i.image ? { images: [BASE_URL + i.image] } : {}),
          },
        },
      })),
      shipping_address_collection: {
        allowed_countries: settings.ship_countries
          .split(',')
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean),
      },
      phone_number_collection: { enabled: true },
      shipping_options: shippingOptions(cart.subtotal_cents, settings).map((o) => ({
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: o.label,
          fixed_amount: { amount: o.cents, currency: settings.currency },
          delivery_estimate: {
            minimum: { unit: 'business_day', value: o.days[0] },
            maximum: { unit: 'business_day', value: o.days[1] },
          },
        },
      })),
      success_url: `${BASE_URL}/order/success?ref=${order.ref}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cart?msg=${encodeURIComponent('Checkout cancelled — your cart is still here.')}`,
    });

    orders.setStatus(order.id, 'pending');
    require('../db').db
      .prepare('UPDATE orders SET provider_ref = ? WHERE id = ?')
      .run(session.id, order.id);

    res.redirect(303, session.url);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * Demo mode checkout (only when Stripe is not configured)             *
 * ------------------------------------------------------------------ */

router.get('/checkout/demo/:ref', (req, res, next) => {
  if (LIVE) return next();
  const order = orders.byRef(req.params.ref);
  if (!order || order.status !== 'pending') return res.redirect('/cart');
  res.render('checkout_demo', {
    order,
    options: shippingOptions(order.subtotal_cents),
  });
});

router.post('/checkout/demo/:ref', async (req, res, next) => {
  try {
    if (LIVE) return next();
    const order = orders.byRef(req.params.ref);
    if (!order || order.status !== 'pending') return res.redirect('/cart');

    const b = req.body;
    const option = shippingOptionById(b.shipping, order.subtotal_cents);

    orders.markPaid(order.id, {
      email: b.email,
      customer_name: b.name,
      phone: b.phone,
      address: {
        line1: b.line1,
        line2: b.line2,
        city: b.city,
        state: b.state,
        postal_code: b.postal_code,
        country: b.country,
      },
      shipping_cents: option.cents,
      total_cents: order.subtotal_cents + option.cents,
      shipping_label: option.label,
      provider_ref: 'demo-' + order.ref,
    });

    const finished = orders.byRef(order.ref);
    await sendOrderEmails(finished);
    clearCart(req);
    res.redirect(`/order/success?ref=${order.ref}`);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * Stripe webhook — the authoritative "the money arrived" message.     *
 * ------------------------------------------------------------------ */

async function webhook(req, res) {
  if (!LIVE) return res.json({ received: true, note: 'demo mode' });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[stripe] webhook received but STRIPE_WEBHOOK_SECRET is not set.');
    return res.status(400).send('webhook secret not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      secret
    );
  } catch (err) {
    console.error('[stripe] bad webhook signature:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    try {
      // The session Stripe posts here has the shipping rate as a bare id, so
      // fetch it again with the rate expanded — otherwise the chosen shipping
      // method arrives with no name on it.
      const full = await stripe.checkout.sessions.retrieve(event.data.object.id, {
        expand: ['shipping_cost.shipping_rate'],
      });
      await finalizeStripeSession(full);
    } catch (err) {
      console.error('[stripe] could not finalize order:', err);
    }
  }

  res.json({ received: true });
}

/** Turns a paid Stripe session into a paid order. Safe to call twice. */
async function finalizeStripeSession(session) {
  const ref = session.client_reference_id || session.metadata?.order_ref;
  const order = ref ? orders.byRef(ref) : orders.byProviderRef(session.id);
  if (!order || order.stock_applied === 1) return order;
  if (session.payment_status !== 'paid') return order;

  const ship = session.shipping_details || session.customer_details || {};
  const applied = orders.markPaid(order.id, {
    email: session.customer_details?.email || '',
    customer_name: ship.name || session.customer_details?.name || '',
    phone: session.customer_details?.phone || '',
    address: ship.address || session.customer_details?.address || {},
    shipping_cents: session.shipping_cost?.amount_total ?? 0,
    total_cents: session.amount_total ?? order.total_cents,
    shipping_label:
      session.shipping_cost?.shipping_rate?.display_name ||
      session.shipping_options?.[0]?.shipping_rate?.display_name ||
      '',
    provider_ref: session.id,
  });

  const fresh = orders.byRef(order.ref);
  if (applied) {
    console.log(`[order] ${fresh.ref} paid — ${money(fresh.total_cents)}`);
    await sendOrderEmails(fresh);
  }
  return fresh;
}

/* ------------------------------------------------------------------ *
 * Thank-you page                                                      *
 * ------------------------------------------------------------------ */

router.get('/order/success', async (req, res, next) => {
  try {
    let order = req.query.ref ? orders.byRef(req.query.ref) : null;

    // Safety net: if the webhook has not landed yet (or was never set up),
    // ask Stripe directly whether this session was paid.
    if (LIVE && order && order.status === 'pending' && req.query.session_id) {
      const session = await stripe.checkout.sessions.retrieve(req.query.session_id, {
        expand: ['shipping_cost.shipping_rate'],
      });
      order = (await finalizeStripeSession(session)) || order;
    }

    if (order && order.status !== 'pending') clearCart(req);
    res.render('success', { order });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, webhook, finalizeStripeSession, LIVE };
