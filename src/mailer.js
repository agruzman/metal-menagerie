/**
 * mailer.js — order emails.
 *
 * If no SMTP settings are present in .env, emails are printed to the terminal
 * instead of being sent. The shop still works; you just won't get a receipt.
 */
const nodemailer = require('nodemailer');
const { getSettings } = require('./db');
const { money } = require('./helpers');

const configured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);

const transport = configured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

async function send({ to, subject, html, replyTo }) {
  if (!to) return;
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || 'shop@localhost';
  if (!transport) {
    console.log(`\n[mail:not-configured] to=${to}\n  subject=${subject}\n`);
    return;
  }
  try {
    await transport.sendMail({ from, to, subject, html, ...(replyTo ? { replyTo } : {}) });
    console.log(`[mail] sent "${subject}" to ${to}`);
  } catch (err) {
    console.error('[mail] failed:', err.message);
  }
}

/** Anything typed by a buyer goes through this before it lands in HTML. */
const esc = (v) =>
  String(v ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function orderTable(order, s) {
  const rows = order.items
    .map(
      (i) =>
        `<tr><td style="padding:6px 12px 6px 0">${i.qty} &times; ${esc(i.name)}</td>
         <td style="padding:6px 0;text-align:right">${money(i.price_cents * i.qty, s)}</td></tr>`
    )
    .join('');
  return `
  <table style="border-collapse:collapse;font:14px/1.5 system-ui,sans-serif">
    ${rows}
    <tr><td style="padding:6px 12px 6px 0;border-top:1px solid #ddd">Shipping</td>
        <td style="padding:6px 0;text-align:right;border-top:1px solid #ddd">${money(order.shipping_cents, s)}</td></tr>
    <tr><td style="padding:6px 12px 6px 0;font-weight:700">Total</td>
        <td style="padding:6px 0;text-align:right;font-weight:700">${money(order.total_cents, s)}</td></tr>
  </table>`;
}

function addressBlock(order) {
  const a = order.address || {};
  const { countryName } = require('./countries');
  return [
    order.customer_name,
    a.line1,
    a.line2,
    [a.postal_code, a.city].filter(Boolean).join(' '),
    a.state,
    countryName(a.country),
  ]
    .filter(Boolean)
    .map(esc)
    .join('<br>');
}

async function sendOrderEmails(order) {
  const s = getSettings();

  await send({
    to: order.email,
    subject: `${s.store_name} — order ${order.ref} confirmed`,
    html: `
      <div style="font:15px/1.6 system-ui,sans-serif;color:#222">
        <h2 style="margin:0 0 4px">Thank you.</h2>
        <p>Your order <strong>${order.ref}</strong> is confirmed and will be
        packed and dispatched within 3 working days. You will get a second
        email with tracking when it leaves the workshop.</p>
        ${orderTable(order, s)}
        <p style="margin-top:20px"><strong>Shipping to</strong><br>${addressBlock(order)}</p>
        <p style="color:#777;font-size:13px">${s.store_name} · ${s.contact_email}</p>
      </div>`,
  });

  await send({
    to: s.contact_email,
    subject: `New order ${order.ref} — ${money(order.total_cents, s)}`,
    html: `
      <div style="font:15px/1.6 system-ui,sans-serif">
        <h2>New order ${order.ref}</h2>
        ${orderTable(order, s)}
        <p><strong>Ship to</strong><br>${addressBlock(order)}<br>${order.email}</p>
      </div>`,
  });
}

/**
 * An order request came in (no payment yet). The owner gets everything needed
 * to reply — with Reply-To set to the buyer, so answering is one click — and
 * the buyer gets a confirmation saying what happens next.
 */
async function sendOrderRequestEmails(order) {
  const s = getSettings();
  const { countryName } = require('./countries');
  const a = order.address || {};

  await send({
    to: s.contact_email,
    replyTo: order.email,
    subject: `New order request ${order.ref} — ${money(order.total_cents, s)} — ${String(order.customer_name).replace(/[\r\n]/g, ' ')} (${countryName(a.country)})`,
    html: `
      <div style="font:15px/1.6 system-ui,sans-serif;color:#222">
        <h2 style="margin:0 0 6px">New order request</h2>
        <p style="margin:0 0 16px;color:#666">${order.ref} · ${order.created_at} · payment not yet arranged</p>
        ${orderTable(order, s)}
        <h3 style="margin:22px 0 6px">Buyer</h3>
        <p style="margin:0">
          <strong>${esc(order.customer_name)}</strong><br>
          <a href="mailto:${esc(order.email)}">${esc(order.email)}</a><br>
          ${esc(order.phone)}
        </p>
        <h3 style="margin:22px 0 6px">Ship to</h3>
        <p style="margin:0">${addressBlock(order)}</p>
        ${order.notes ? `<h3 style="margin:22px 0 6px">Message</h3><p style="margin:0;white-space:pre-wrap">${esc(order.notes)}</p>` : ''}
        <p style="margin-top:26px;padding:12px 14px;background:#f5f1ea;border-radius:6px">
          <strong>Next:</strong> reply to this email to confirm the piece is available and
          how to pay (PayPal / bank transfer). Then open the order in the admin panel and set
          it to <em>paid</em> — that takes the piece off the shelf.
        </p>
      </div>`,
  });

  await send({
    to: order.email,
    replyTo: s.contact_email,
    subject: `${s.store_name} — we received your request (${order.ref})`,
    html: `
      <div style="font:15px/1.6 system-ui,sans-serif;color:#222">
        <h2 style="margin:0 0 4px">Thank you, ${esc(order.customer_name.split(' ')[0] || 'there')}.</h2>
        <p>Your request <strong>${order.ref}</strong> has reached the workshop. Every piece
        exists exactly once, so we first confirm it is still on the shelf — you will hear from
        us within a day with the exact shipping cost and how to pay. Nothing is charged until then.</p>
        ${orderTable(order, s)}
        <p style="margin-top:20px"><strong>Shipping to</strong><br>${addressBlock(order)}</p>
        <p style="color:#777;font-size:13px">${s.store_name} · ${s.contact_email}</p>
      </div>`,
  });
}

async function sendShippedEmail(order) {
  const s = getSettings();
  await send({
    to: order.email,
    subject: `${s.store_name} — order ${order.ref} is on its way`,
    html: `
      <div style="font:15px/1.6 system-ui,sans-serif;color:#222">
        <h2 style="margin:0 0 4px">It's on the way.</h2>
        <p>Order <strong>${order.ref}</strong> has been dispatched.</p>
        ${order.tracking ? `<p>Tracking number: <strong>${order.tracking}</strong></p>` : ''}
        <p style="color:#777;font-size:13px">${s.store_name} · ${s.contact_email}</p>
      </div>`,
  });
}

module.exports = { send, sendOrderEmails, sendOrderRequestEmails, sendShippedEmail, configured };
