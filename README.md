# Metal Menagerie — a small shop that sells handmade metal statues

A complete, self-contained online shop: a catalogue, a cart, real card
payments, shipping choices, stock that counts itself down, order emails and a
password-protected back office for running the whole thing.

It is deliberately small: eight JavaScript files and a folder of templates.
Everything lives in one SQLite database — a file on your laptop, or a free
hosted one when the shop is online — and it runs for $0 a month (section 5).

---

## 1. Run it on your own machine (about five minutes)

You need [Node.js](https://nodejs.org) — download the LTS version and install
it. Then, in a terminal, from this folder:

```bash
npm install          # fetch the libraries (once)
cp .env.example .env # make your settings file
npm start            # start the shop
```

Open **http://localhost:3000** for the shop and
**http://localhost:3000/admin** for the back office.

Before you log in to the admin, open `.env` in any text editor and change:

```
ADMIN_PASSWORD=whatever-you-want
SESSION_SECRET=any-long-random-gibberish
```

Stop the server with `Ctrl-C`. Restart it with `npm start`.

> **Demo mode.** With no Stripe keys in `.env`, checkout still works end to
> end — a plain address form stands in for the card page, the order is
> recorded and stock goes down, but nothing is charged. Use it to try the
> whole flow before you sign up to anything.

Run `npm test` at any point to check the money and stock logic still behaves
(33 assertions, runs in a second, uses a throwaway database).

---

## 2. How the thing is put together

```
server.js            starts everything, wires the pieces together
src/db.js            the database: products, orders, settings, uploaded photos
src/helpers.js       money, cart and shipping arithmetic
src/sqlite.js        opens the database (local file, or Turso when hosted)
src/paths.js         where the local database lives
src/mailer.js        order emails
src/routes/shop.js     the public pages and the cart
src/routes/checkout.js payment, shipping, the Stripe webhook
src/routes/admin.js    everything under /admin
views/               the HTML templates
public/              stylesheet and the four starter photos
data/shop.db         your entire shop, in one file  ← back this up
deploy.sh            puts the shop online for $0 (section 5)
render.yaml          tells Render how to run it
.github/workflows/   the 5-minute keep-alive ping
```

Three ideas are worth knowing, because they are where shops usually go wrong:

**Money is stored in whole cents, never decimals.** `$68.00` is the number
`6800`. Computers cannot represent `0.1 + 0.2` exactly, and if you add prices
as decimals you will eventually be out by a penny, on a real invoice.

**Card details never touch this server.** When the buyer clicks Checkout they
are sent to Stripe's own hosted page. Stripe takes the card number, charges
it, and tells us the result. That single decision is what keeps you out of PCI
compliance paperwork, and it is why `checkout.js` is under 300 lines.

**Stock is only reduced when the money actually arrives.** Not when something
is put in a cart, not when checkout starts — only when Stripe confirms
payment. That confirmation can arrive twice (Stripe retries), so the order
carries a `stock_applied` flag and the second message is ignored. Without it,
one sale would empty two pieces off your shelf.

---

## 3. Running the shop day to day

Everything is at `/admin`.

**Dashboard** — how much you have sold, what is waiting to be posted, and a
list of your stock with `+` / `−` buttons. When you finish a new piece, press
`+`. That is the whole inventory system.

**Products** — add a piece, write a description, set a price, upload a photo,
say how many exist. Untick *Show this piece in the shop* to keep a draft
hidden. Photos are best square, shot on a plain surface in daylight.

**Orders** — open one and you get the address, a packing slip to copy into the
box, and a status dropdown. Set it to **shipped**, paste in a tracking number,
and the buyer is emailed automatically. Set it to **cancelled** or
**refunded** and the items go back into stock on their own. (Refunding the
*money* is a separate click in your Stripe dashboard — this only fixes your
inventory.)

**Settings** — shop name, currency, shipping prices, which countries you post
to, free-shipping threshold, and the shipping/returns text. No code involved.

---

## 4. Turning on real card payments

1. Create an account at [stripe.com](https://stripe.com). It is free to open;
   they take a cut per sale rather than a monthly fee. You will be asked for
   business and bank details before you can accept live payments.
2. In the Stripe dashboard, leave the **Test mode** switch on for now.
3. Go to *Developers → API keys* and copy the **Secret key** (starts with
   `sk_test_`). Paste it into `.env`:

   ```
   STRIPE_SECRET_KEY=sk_test_...
   ```
4. Restart the server. The terminal should now say `Payments: Stripe`.
5. Buy something from your own shop. On the card form use Stripe's test card:

   | Field | Value |
   |---|---|
   | Number | `4242 4242 4242 4242` |
   | Expiry | any future date |
   | CVC | any 3 digits |
   | Postcode | any |

   The order should appear in `/admin/orders` marked **paid**, and the stock
   count should have dropped.

6. When you are ready for real money: complete Stripe's account activation,
   flip out of Test mode, and swap the key for the live one (`sk_live_...`).

### The webhook (do this before you take real orders)

A webhook is Stripe phoning your server to say "that one paid". The shop has a
safety net — if the buyer lands back on the thank-you page, it asks Stripe
directly — but a buyer who closes the tab too early would otherwise leave an
order stuck as *pending*. Set the webhook up and that cannot happen.

Once your shop is on the internet (section 5):

1. Stripe dashboard → *Developers → Webhooks → Add endpoint*.
2. URL: `https://your-domain.com/webhooks/stripe`
3. Event to listen for: `checkout.session.completed`.
4. Copy the **Signing secret** (`whsec_...`) into `.env`:

   ```
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

To test webhooks on your own laptop, install the
[Stripe CLI](https://docs.stripe.com/stripe-cli) and run
`stripe listen --forward-to localhost:3000/webhooks/stripe`; it prints a
`whsec_` secret to use locally.

---

## 5. Putting it on the internet for $0

### The free stack, and why it is shaped this way

In 2026 no free hosting tier gives you a disk that survives a restart — that
is the thing they charge for. So the free version splits the shop in three
free pieces:

| Piece | Service | Free plan | What it holds |
|---|---|---|---|
| Server | [Render](https://render.com) | 750 h/month, 512 MB, no card | the running app |
| Database | [Turso](https://turso.tech) | 5 GB, no card | products, orders, settings, uploaded photos |
| Keep-alive | GitHub Actions | free for public repos | a ping every 5 min so nothing sleeps |

The catch with Render's free tier is that it dozes off after 15 idle minutes
and the next visitor waits 30–60 s. The GitHub ping prevents that, and the
same ping keeps Turso from archiving an idle database. One always-on service
uses ~744 of Render's 750 free hours, which is exactly why the number is 750.

Uploaded photos go into the database rather than onto the disk for the same
reason — the disk is not yours to keep.

### Do it

```bash
bash deploy.sh
```

The script installs two small command-line tools if you lack them (GitHub's
`gh`, Turso's `turso`), pushes the code to a GitHub repository, creates the
database, and opens Render's one-click deploy page with everything pre-filled
except three secrets, which it prints for you to paste. Three browser tabs will
ask you to click **Authorize** — GitHub, Turso, Render. That is the whole job;
budget ten minutes.

When Render finishes it shows an address like
`https://metal-menagerie.onrender.com`. Paste it back into the script when it
asks, and the keep-alive switches on.

- Shop: `https://<address>` — Admin: `https://<address>/admin`
- The admin password is printed by the script and also visible on Render under
  *Environment*.

### Afterwards

- A custom domain (~$12/year) goes in Render → *Settings → Custom Domains*;
  HTTPS is automatic. Update `BASE_URL` in Render's environment to match.
- Add the Stripe webhook from section 4 using the final address.
- **Back up**: `turso db shell metal-menagerie .dump > backup.sql` from time to
  time. Turso also keeps point-in-time restore on its own side.

### If you would rather pay $7/month

Render's Starter instance never sleeps and can have a real disk. Skip Turso:
leave `TURSO_DATABASE_URL` empty, attach a disk at `/var/data`, and set
`SHOP_DATA_DIR=/var/data/shop`. Everything then lives in one file again.

---

## 6. What this costs

| | |
|---|---|
| The software | free, it's yours |
| Server | $0 on Render's free tier (or $7/mo for one that never needs the keep-alive) |
| Database | $0 on Turso's free plan |
| Domain name | roughly $12 a year — optional, the `.onrender.com` address works |
| Stripe | no monthly fee — around **2.9% + 30¢** per successful card payment in the US; rates differ by country, so check [stripe.com/pricing](https://stripe.com/pricing) for yours |
| Email | free with a Gmail app password, or ~$1/mo for a proper sending service |

So: a few dollars a month, plus a slice of each sale. For comparison, hosted
shop platforms typically run $29–39/month *before* their own transaction fees,
which is the trade — you save the subscription, you own the code, and nobody
else can change the rules on you. What you give up is someone else being on
call when something breaks.

If your friend would rather never see a terminal again, that trade may not be
worth it, and a hosted platform is the honest recommendation. If he is willing
to run two commands and press deploy, this is cheaper and entirely his.

---

## 7. Email receipts (optional)

Leave the `SMTP_*` lines in `.env` empty and emails are just printed in the
terminal — handy while testing. To send real ones with Gmail:

1. Turn on 2-step verification on the Google account.
2. Create an **App password** (Google Account → Security → App passwords).
3. Fill in `.env`:

   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=you@gmail.com
   SMTP_PASS=the-16-character-app-password
   MAIL_FROM=you@gmail.com
   ```

Set *Contact email* in admin settings to wherever you want new-order
notifications to land.

---

## 8. When something goes wrong

**"Could not open a database" on startup.** Your Node is too old — the shop
uses the SQLite built into Node 22.13 and newer. Install the current LTS from
nodejs.org and run `npm install` again.

**Render runs `pip install -r requirements.txt` — the service was created
with the Python runtime.** It still works: `requirements.txt`, `setup.py`,
`app.py` and `gunicorn.conf.py` exist precisely for this case. The Python
build installs the Node dependencies, and whatever Python start command the
service has (`gunicorn app:app`, `python app.py`, …) hands over to
`server.js`. The cleaner fix, when you have a minute, is Settings → *Build* →
*Source* → **Edit** → Runtime **Node**, build `npm install --omit=dev`, start
`npm start`; the Python files then simply go unused.

**Port 3000 is already in use.** Change `PORT=3001` in `.env`.

**An order is stuck on *pending*.** The payment never completed, or the
webhook is not set up. Check *Payments* in the Stripe dashboard: if the money
is there, set the order to *paid* by hand and fix the webhook.

**Everything vanished after a deploy.** On the free stack that means
`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` are missing on Render, so the app
fell back to the throwaway local disk. Check Render → *Environment*. On the
$7 stack it means the disk is missing or `SHOP_DATA_DIR` is not pointing at it.

**The site takes a minute to load the first time.** Render's free tier fell
asleep, which means the keep-alive is not running. On GitHub, open *Actions*
and check that "Keep the shop awake" is enabled and that the `APP_URL`
variable (*Settings → Secrets and variables → Actions*) has the right address.
The repository must be public for the minutes to be free.

**Render says the database is archived / cannot connect.** Turso parks a
free database after 10 idle days. `turso db unarchive metal-menagerie` wakes
it (or use the Turso dashboard). The keep-alive prevents this in the first
place.

**`deploy.sh` stops with "refusing to allow an OAuth App to create or update
workflow".** Run `gh auth refresh -s workflow` and re-run the script.

**A photo will not upload.** JPG, PNG, WEBP, GIF or AVIF, up to 8 MB. Photos
straight off a phone are sometimes larger — export a smaller copy.

---

## 9. Sensible next steps, in order of usefulness

1. Better photographs. This matters more than any feature on this list.
2. A discount-code field at checkout (Stripe supports it in a few lines).
3. Postage priced by weight — every product already stores its grams.
4. A "tell me when it's back" email box on sold-out pieces.
5. A commissions form, since one-off requests are where this kind of work
   usually earns most.

---

Built for selling one-of-a-kind objects: small numbers, high care, no
subscriptions.
