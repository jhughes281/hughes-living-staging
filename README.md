# Hughes Living Staging

Stage homes with furniture from Hughes Living Co. and Hughes Living Auctions,
and sell the furniture out of the house.

| Page | Who | What |
|---|---|---|
| `index.html` | anyone signed in | Sign-in, then Home (customers), Houses, Furniture, Requests, Services (plus Money and Accounts for staff) |
| `house.html?h=CODE` | buyers | What a house's QR code opens: every piece, by room, with price and "I want this" |
| `card.html?h=CODE` | anyone signed in | Printable counter sign with the house QR, plus a hang tag per piece |

## Who signs in

| Login | Sees | Can do |
|---|---|---|
| Hughes Living staff (`owner`) | everything, incl. cost, Money, Accounts | everything |
| Staging it myself (`self`) | own houses, free warehouse pieces, prices | add/edit own houses, place and send back pieces, print QR cards |
| Interior designer (`designer`) | same, across several client houses | same, plus client details per house |
| Realtor (`realtor`) | same, across their listings | same, plus seller details per listing |

Customers never get cost, office notes, other customers' houses, or a buyer's
phone/email: those are removed by the data layer before the page receives
anything (`stg_portal` in `supabase/0002_accounts.sql`; the demo backend in
`api.js` applies the same rules).

## Home: one dashboard per kind of account

| Login | Lands on |
|---|---|
| Staging it myself | Six steps for one house (add it, choose furniture, carpets, fee, mark staged, come-out date), with the next one called out |
| Interior designer | A board of client projects by status, the dates coming up, what is free in the warehouse |
| Realtor | One row per listing: is the QR page open, days staged, buyer requests, with the QR card and a buyer link to copy |

Staff have no dashboard; the office opens on Houses. All of it is drawn from
the same rows as the other tabs.

## Services: Richard's Carpet Cleaning

A signed-in customer can ask for a carpet cleaning at one of their own houses.
It is a request to the Hughes Living office (Services tab), not a booking and
not a payment. The estimate uses Richard's posted prices, and is priced by the
data layer, never by the page. The prices live in three places that a test
keeps equal: Richard's `pricing.js`, `services.carpet` in `config.js`, and
`stg_carpet_estimate()` in `supabase/0003_services.sql`.

## Services: Hughes Move & Tote

The second service on the Services tab: totes on their own, or a truck and
crew with totes, for clearing a house before it is staged or moving once it
sells. Same rules as the cleaning: a request to the office, priced by the data
layer. The rates are copied from the `RATES` object on Move & Tote's own
site into `services.move` in `config.js` and `stg_move_estimate()` in
`supabase/0004_move_tote.sql`, and a test keeps the three equal. The
Hughes-move-tote-mobile app repo is not a source: its prices are generator
filler. Clothes bags and wardrobe boxes are not in the form.

## Sales credit

When a piece sells out of a house that a customer account is staging, 10% of
the sale price (`saleCreditPct` in `config.js`) comes off that house's staging
fee. It is a credit on the fee, not a payout, and never more than the fee;
Hughes Living's own houses earn none. Nothing is stored: the page works it out
from the sold rows, and shows it on the house page, the dashboards, Accounts
and Money (where profit is net of it). Hughes Living bills the fee after credit.

## Which login is this, and the Guide

Each login has its own colour (green homeowner, clay designer, slate realtor,
ink office): a band under the header names the login, and the tab title does
too. The Guide tab holds what the pages know, from `guide.js`: what each login
does, what each room usually needs, and general staging practice. Dashboards
show the one topic that fits where a house is, and a house page lists what a
room is still missing. `guide.js` is words only and states no Hughes Living
policy (fees, delivery, timing).

An empty office shows "Start here" and a **Load sample data** button: two
houses and ten pieces written through the normal functions, each marked
SAMPLE in its office note, removed again with **Remove sample data**.

## Data

Same Supabase project as Hughes Living Auctions. `supabase/0001_staging.sql`
adds `stg_` tables beside the auction tables and reuses its `is_staff()`.
The browser writes to no table; every read and write goes through a function
(staff ones check `is_staff()`, two public ones are keyed by the house code).

On localhost the pages use sample data kept in the browser (`config.js`
explains; `?backend=supabase` switches).

## Going live

1. Run `supabase/0001_staging.sql`, `0002_accounts.sql`, `0003_services.sql`, then `0004_move_tote.sql` in the Supabase SQL editor, or paste `supabase/install-all.sql`, which is all four in order (all safe to re-run).
   Verify by querying for `stg_houses`, not by reading the result banner.
2. Publish this folder to GitHub Pages. `publicBase` in `config.js` is the
   address printed into every QR code, so set it before printing cards.
3. Sign in on `index.html` with an auction office account (`bidders.is_staff`).
   Customers create their own accounts from the same page. Sign-ups share the
   auction project's users, so each also gets an auction paddle, and whether a
   new account must confirm its email is the project's Auth setting.

## Tests

`node test/run-tests.mjs` applies the auction migrations plus this one to a
throwaway Postgres (borrowed from `../hughes-living-auctions/node_modules`)
and checks access, the buyer page's contents, sales, moves and requests.
