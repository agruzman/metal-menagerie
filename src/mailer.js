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

async function send({ to, subject, html }) {
  if (!to) return;
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || 'shop@localhost';
  if (!transport) {
    console.log(`\n[mail:not-configured] to=${to}\n  subject=${subject}\n`);
    return;
  }
  try {
    await transport.sendMail({ from, to, subject, html });
    console.log(`[mail] sent "${subject}" to ${to}`);
  } catch (err) {
    console.error('[mail] failed:', err.message);
  }
}

function orderTable(order, s) {
  const rows = order.items
    .map(
      (i) =>
        `<tr><td style="padding:6px 12px 6px 0">${i.qty} &times; ${i.name}</td>
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
  return [
    order.customer_name,
    a.line1,
    a.line2,
    [a.postal_code, a.city].filter(Boolean).join(' '),
    a.state,
    a.country,
  ]
    .filter(Boolean)
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

module.exports = { send, sendOrderEmails, sendShippedEmail, configured };
