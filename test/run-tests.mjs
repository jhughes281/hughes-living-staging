// Applies the auction core + the staging migration to a throwaway Postgres and
// checks the staging rules: who can call what, what the buyer page leaks
// (nothing), and that moves, sales and requests behave.
//
// Borrows embedded-postgres and pg from the auctions repo next door, since the
// two share one database anyway:
//   node test/run-tests.mjs
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const AUCTIONS = join(here, '..', '..', 'hughes-living-auctions');
const require = createRequire(join(AUCTIONS, 'package.json'));
const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');
const pg = require('pg');

const PORT = 5439;
const DATA = join(tmpdir(), 'hls-staging-pgdata');
if (existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });

const server = new EmbeddedPostgres({
  databaseDir: DATA, user: 'postgres', password: 'postgres', port: PORT, persistent: false,
});
await server.initialise();
await server.start();

let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}`); };

const db = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'postgres', database: 'postgres' });
await db.connect();
db.on('notice', () => {});

async function refused(sql, params, label) {
  await db.query('begin');
  try { await db.query(sql, params); ok(false, label + ' (was allowed)'); }
  catch (e) { ok(true, `${label} — ${e.message}`); }
  await db.query('rollback');
}
const as = async (role, uid) => {
  await db.query('reset role');
  await db.query(`select set_config('test.uid', $1, false)`, [uid || '']);
  if (role) await db.query(`set role ${role}`);
};

try {
  console.log('== applying ==');
  const mig = join(AUCTIONS, 'supabase', 'migrations');
  const files = [join(AUCTIONS, 'test', '00_auth_shim.sql'),
                 ...readdirSync(mig).filter(f => f.endsWith('.sql')).sort().map(f => join(mig, f))];
  for (const f of files) await db.query(readFileSync(f, 'utf8'));
  const staging = readFileSync(join(here, '..', 'supabase', '0001_staging.sql'), 'utf8');
  await db.query(staging);
  await db.query(staging);                                   // safe to run twice
  const accounts = readFileSync(join(here, '..', 'supabase', '0002_accounts.sql'), 'utf8');
  await db.query(accounts);
  await db.query(accounts);
  const services = readFileSync(join(here, '..', 'supabase', '0003_services.sql'), 'utf8');
  await db.query(services);
  await db.query(services);
  const moveTote = readFileSync(join(here, '..', 'supabase', '0004_move_tote.sql'), 'utf8');
  await db.query(moveTote);
  await db.query(moveTote);
  const scans = readFileSync(join(here, '..', 'supabase', '0005_scans_payments.sql'), 'utf8');
  await db.query(scans);
  await db.query(scans);
  ok(true, 'auction core + staging + accounts + services + move & tote + scans applied, each a second time');

  // two accounts: one staff, one ordinary bidder
  const STAFF = '11111111-1111-1111-1111-111111111111';
  const BUYER = '22222222-2222-2222-2222-222222222222';
  await db.query(`insert into auth.users (id, email) values ($1,'office@example.com'), ($2,'buyer@example.com')`, [STAFF, BUYER]);
  await db.query(`update bidders set is_staff = true where id = $1`, [STAFF]);

  console.log('\n== who can reach what ==');
  await as('anon');
  await refused('select * from stg_items', [], 'anon cannot read the furniture table');
  await refused('select * from stg_houses', [], 'anon cannot list houses');
  await refused('select stg_office()', [], 'anon cannot open the office');
  await refused(`select stg_save_item('{"title":"x"}')`, [], 'anon cannot add furniture');
  await as('authenticated', BUYER);
  await refused('select * from stg_requests', [], 'a signed-in bidder cannot read requests');
  await refused('select stg_office()', [], 'a signed-in bidder cannot open the office');
  await refused(`select stg_save_house('{"address":"1 Test St"}')`, [], 'a signed-in bidder cannot add a house');
  await refused(`select stg_catalog_search('sofa')`, [], 'a signed-in bidder cannot search the cost catalog');

  console.log('\n== the office ==');
  await as('authenticated', STAFF);
  const house = (await db.query(`select stg_save_house($1) h`, [JSON.stringify({
    address: '4410 Sample Oak Ln', city: 'Houston', client_name: 'Private Agent', cover_url: 'https://example.com/look.webp',
    client_phone: '555-0100', status: 'staged', fee_cents: 150000, notes: 'lockbox on gas meter' })])).rows[0].h;
  ok(/^[A-HJ-NP-Z2-9]{8}$/.test(house.code), `house saved with code ${house.code}`);

  const sofa = (await db.query(`select stg_save_item($1) i`, [JSON.stringify({
    title: 'Grey sectional', cost_cents: 40000, price_cents: 94900, notes: 'scuff on back leg',
    house_id: house.id, room: 'Living room', source: 'store', source_url: 'https://hugheslivingco.com/products/x' })])).rows[0].i;
  const lamp = (await db.query(`select stg_save_item($1) i`, [JSON.stringify({
    title: 'Arc lamp', cost_cents: 3000, price_cents: 8900, house_id: house.id, room: 'Living room' })])).rows[0].i;
  const spare = (await db.query(`select stg_save_item($1) i`, [JSON.stringify({ title: 'Warehouse bench', price_cents: 12000 })])).rows[0].i;
  ok(sofa.tag_no === 1001 && lamp.tag_no === 1002, 'tag numbers are issued in order from 1001');
  ok(spare.house_id === null && spare.room === null, 'a piece with no house is in the warehouse');

  let office = (await db.query('select stg_office() o')).rows[0].o;
  ok(office.houses.length === 1 && office.items.length === 3, 'office read returns houses and pieces');
  ok(office.moves.length === 2 && office.moves.every(m => m.removed_at === null), 'placing a piece opens a stay');

  await refused(`select stg_delete_house($1)`, [house.id], 'a house with furniture in it cannot be deleted');
  await refused(`select stg_save_item('{"title":"  "}')`, [], 'a piece needs a name');

  console.log('\n== the buyer page ==');
  await as('anon');
  let pub = (await db.query('select stg_house_public($1) p', [house.code.toLowerCase()])).rows[0].p;
  ok(pub.open && pub.items.length === 2, 'the code opens the house (case does not matter) with its 2 pieces');
  ok(pub.cover_url === 'https://example.com/look.webp', "the house's cover photo is on the buyer page");
  const wire = JSON.stringify(pub);
  ok(!/cost|40000|scuff|lockbox|Private Agent|555-0100|fee/.test(wire), 'no cost, office notes, client or fee on the wire');
  ok((await db.query(`select stg_house_public('NOPE2345') p`)).rows[0].p.found === false, 'a wrong code finds nothing');

  ok((await db.query(`select stg_request($1,$2,'Dana','555-0111',null,'Is the sofa firm?') r`, [house.code, sofa.tag_no])).rows[0].r === true,
     'a buyer can ask for a piece');
  await refused(`select stg_request($1,$2,'Dana',null,null,null)`, [house.code, sofa.tag_no], 'a request needs a phone or an email');
  await refused(`select stg_request($1,$2,'Dana','555',null,null)`, [house.code, spare.tag_no], 'a piece from another place cannot be requested here');
  await refused(`select stg_request('NOPE2345',null,'Dana','555',null,null)`, [], 'a wrong code takes no requests');
  ok((await db.query(`select stg_request($1,null,'Lee','555-0144',null,null,'look') r`, [house.code])).rows[0].r === true,
     'a buyer can buy the look');
  await refused(`select stg_request($1,null,'Lee','555',null,null,'gift')`, [house.code], 'an unknown kind of request is refused');

  console.log('\n== selling and moving ==');
  await as('authenticated', STAFF);
  const sold = (await db.query(`select stg_save_item($1) i`, [JSON.stringify({ ...sofa, status: 'sold', sold_cents: 90000, sold_to: 'Dana' })])).rows[0].i;
  ok(sold.sold_at && sold.sold_house_id === house.id && sold.house_id === house.id, 'a sale is stamped with its house and the piece can stay put');
  const out = (await db.query(`select stg_save_item($1) i`, [JSON.stringify({ ...sold, house_id: null })])).rows[0].i;
  ok(out.house_id === null && out.sold_house_id === house.id, 'after pickup the sale still counts toward that house');
  office = (await db.query('select stg_office() o')).rows[0].o;
  ok(office.moves.filter(m => m.item_id === sofa.id && m.removed_at).length === 1, 'leaving the house closes the stay');
  const pieceReq = office.requests.filter(r => r.kind === 'piece')[0], lookReq = office.requests.filter(r => r.kind === 'look')[0];
  ok(office.requests.length === 2 && pieceReq.item_title === 'Grey sectional', 'the piece order reached the office');
  ok(lookReq.piece_count === 2 && lookReq.total_cents === 94900 + 8900 && lookReq.item_id === null,
     'the look order records the 2 available pieces and their total, priced by the database');
  await db.query(`select stg_set_request($1,'contacted')`, [pieceReq.id]);

  await as('anon');
  pub = (await db.query('select stg_house_public($1) p', [house.code])).rows[0].p;
  ok(pub.items.length === 1 && pub.items[0].title === 'Arc lamp', 'a piece that left is off the buyer page');
  ok(!/Dana/.test(JSON.stringify(pub)), "the buyer's name is not on the page");

  await as('authenticated', STAFF);
  await db.query(`select stg_save_house($1)`, [JSON.stringify({ ...house, status: 'destaged' })]);
  await as('anon');
  pub = (await db.query('select stg_house_public($1) p', [house.code])).rows[0].p;
  ok(pub.found && pub.open === false && !pub.items, 'a destaged house shows a closed page with no list');
  await refused(`select stg_request($1,null,'Dana','555',null,null)`, [house.code], 'a destaged house takes no requests');

  console.log('\n== store catalog ==');
  await as('authenticated', STAFF);
  const n = (await db.query(`select stg_catalog_import($1, true) n`, [JSON.stringify([
    { handle: 'joy-ii-black', variant: 'Sofa', sku: 'S133-SOFA', title: 'Joy II Black Sofa', price_cents: 59999, cost_cents: 25500 },
    { handle: 'joy-ii-black', variant: 'Loveseat', sku: 'S133-LOVE', title: 'Joy II Black Loveseat', price_cents: 49999, cost_cents: 21000 },
    { handle: '', title: 'no handle' }])])).rows[0].n;
  ok(n === 2, 'catalog import keeps the valid rows');
  ok((await db.query(`select stg_catalog_search('joy') r`)).rows[0].r.length === 2, 'catalog search finds them');

  console.log('\n== customer logins: staging it myself, interior designer ==');
  const SELF = '33333333-3333-3333-3333-333333333333';
  await as(null);
  await db.query(`insert into auth.users (id, email) values ($1,'home@example.com')`, [SELF]);
  await as('anon');
  await refused('select stg_portal()', [], 'nobody opens the portal without signing in');
  await as('authenticated', BUYER);
  ok((await db.query('select stg_my_account() a')).rows[0].a === null, 'a signed-in user with no staging account is nobody here');
  await refused('select stg_portal()', [], 'and cannot open the portal');
  await refused(`select stg_register('owner','Sneaky',null,null)`, [], 'nobody can register as staff');
  const des = (await db.query(`select stg_register('designer','Dee Designer','Dee Interiors','555-0122') a`)).rows[0].a;
  ok(des.kind === 'designer' && des.email === 'buyer@example.com', 'an interior designer account is created');
  ok((await db.query(`select stg_register('self','Dee D',null,null) a`)).rows[0].a.kind === 'designer', 'the kind of account cannot be switched afterwards');
  await refused('select stg_office()', [], 'a designer cannot open the staff office');
  await refused(`select stg_save_item('{"title":"x"}')`, [], 'a designer cannot add or edit furniture');

  const dh = (await db.query('select stg_portal_save_house($1) h', [JSON.stringify({
    address: '12 Client Ct', client_name: 'The Client', status: 'staged', fee_cents: 99900, notes: 'sneaky', cover_url: 'https://example.com/d.webp' })])).rows[0].h;
  ok(dh.cover_url === 'https://example.com/d.webp', 'a designer can set the cover photo of their house');
  ok(dh.fee_cents === 0 && !('notes' in dh), 'a designer adds a house but cannot set the fee or the office note');
  await db.query('select stg_place($1,$2,$3)', [spare.id, dh.id, 'Entry']);
  let portal = (await db.query('select stg_portal() p')).rows[0].p;
  ok(portal.houses.length === 1 && portal.houses[0].address === '12 Client Ct', 'the designer sees only their own house');
  ok(portal.items.some(x => x.id === spare.id && x.house_id === dh.id), 'and can place a free warehouse piece in it');
  ok(!/cost_cents|sold_to|lockbox|scuff|4410 Sample/.test(JSON.stringify(portal)), 'no cost, office notes or other houses in the portal');
  await refused('select stg_place($1,$2,null)', [lamp.id, dh.id], "a designer cannot take a piece out of someone else's house");
  await refused('select stg_place($1,$2,null)', [spare.id, house.id], "or put one into someone else's house");
  await refused('select stg_portal_save_house($1)', [JSON.stringify({ id: house.id, address: 'Mine now' })], "or edit someone else's house");

  await as('anon');
  await db.query(`select stg_request($1,$2,'Pat','555-0133','pat@example.com','Love it')`, [dh.code, spare.tag_no]);
  await as('authenticated', BUYER);
  portal = (await db.query('select stg_portal() p')).rows[0].p;
  ok(portal.requests.length === 1 && portal.requests[0].kind === 'piece' && !/555-0133|pat@example/.test(JSON.stringify(portal)), "the designer sees the order but not the buyer's phone or email");
  await as('authenticated', STAFF);
  await db.query(`select stg_save_item($1)`, [JSON.stringify({ ...spare, house_id: dh.id, status: 'hold' })]);
  await as('anon');
  await refused(`select stg_request($1,null,'Pat','555',null,null,'look')`, [dh.code], 'the look cannot be bought when nothing is available');
  await as('authenticated', STAFF);
  await db.query(`select stg_save_item($1)`, [JSON.stringify({ ...spare, house_id: dh.id, status: 'available' })]);

  await as('authenticated', SELF);
  const me = (await db.query(`select stg_register('self','Sam Seller',null,null) a`)).rows[0].a;
  ok(me.kind === 'self', 'a staging-it-myself account is created');
  portal = (await db.query('select stg_portal() p')).rows[0].p;
  ok(portal.houses.length === 0 && !portal.items.some(x => x.id === spare.id), "a second customer sees none of the first one's houses or pieces");
  await refused('select stg_place($1,null,null)', [spare.id], "and cannot move the first customer's piece");

  const AGENT = '44444444-4444-4444-4444-444444444444';
  await as(null);
  await db.query(`insert into auth.users (id, email) values ($1,'agent@example.com')`, [AGENT]);
  await as('authenticated', AGENT);
  const agent = (await db.query(`select stg_register('realtor','Rae Realtor','Rae Realty','555-0177') a`)).rows[0].a;
  ok(agent.kind === 'realtor' && agent.studio === 'Rae Realty', 'a realtor account is created, with its brokerage');
  const listing = (await db.query('select stg_portal_save_house($1) h', [JSON.stringify({ address: '9 Listing Ln', client_name: 'The Seller' })])).rows[0].h;
  portal = (await db.query('select stg_portal() p')).rows[0].p;
  ok(portal.houses.length === 1 && portal.houses[0].id === listing.id, 'the realtor sees only their own listing');
  await refused('select stg_place($1,$2,null)', [spare.id, listing.id], "and cannot take a piece out of the designer's house");

  await as('authenticated', STAFF);
  office = (await db.query('select stg_office() o')).rows[0].o;
  ok(office.accounts.length === 3 && office.houses.length === 3, 'staff see all three accounts and every house');
  ok((await db.query('select stg_my_account() a')).rows[0].a.kind === 'owner', 'staff sign in as the owner');
  await db.query('select stg_place($1,null,null)', [spare.id]);
  ok(true, 'staff can move any piece');

  console.log('\n== services: carpet cleaning ==');
  await as('anon');
  await refused('select * from stg_services', [], 'anon cannot read service requests');
  await refused('select stg_services_list()', [], 'anon cannot list service requests');
  await refused('select stg_service_request($1)', [JSON.stringify({ house_id: dh.id, rooms: 3 })], 'anon cannot ask for a cleaning');

  await as('authenticated', BUYER);
  const clean = (await db.query('select stg_service_request($1) s', [JSON.stringify({
    house_id: dh.id, rooms: 3, addons: ['addon_hall', 'addon_hall'], estimate_cents: 1, preferred_on: '2026-12-01', note: 'Before install' })])).rows[0].s;
  ok(clean.estimate_cents === 14400 && clean.status === 'new' && clean.addons.length === 1,
     'the designer asks for 3 rooms + hallway: priced by the database at $144, whatever the page sent');
  await refused('select stg_service_request($1)', [JSON.stringify({ house_id: listing.id, rooms: 2 })], "a designer cannot ask for a cleaning at someone else's house");
  await refused('select stg_service_request($1)', [JSON.stringify({ house_id: house.id, rooms: 2 })], "or at one of Hughes Living's own houses");
  await refused('select stg_service_request($1)', [JSON.stringify({ house_id: dh.id, rooms: 0 })], 'a request needs at least one room or add-on');
  await refused('select stg_service_request($1)', [JSON.stringify({ house_id: dh.id, rooms: 9 })], 'no more than 8 rooms');
  await refused('select stg_service_request($1)', [JSON.stringify({ house_id: dh.id, rooms: 1, addons: ['addon_free'] })], 'an unknown add-on is refused');
  await refused('select stg_set_service($1,$2)', [clean.id, 'done'], 'a customer cannot mark their own request done');

  await as('authenticated', AGENT);
  ok((await db.query('select stg_services_list() l')).rows[0].l.length === 0, "the realtor sees none of the designer's requests");
  await refused('select stg_set_service($1,$2)', [clean.id, 'cancelled'], "and cannot cancel one");

  await as('authenticated', STAFF);
  ok((await db.query('select stg_services_list() l')).rows[0].l.length === 1, 'staff see every request');
  await db.query('select stg_set_service($1,$2)', [clean.id, 'scheduled']);
  await as('authenticated', BUYER);
  let mineList = (await db.query('select stg_services_list() l')).rows[0].l;
  ok(mineList.length === 1 && mineList[0].status === 'scheduled', 'the designer sees it scheduled');
  await refused('select stg_set_service($1,$2)', [clean.id, 'cancelled'], 'and can no longer cancel it here');
  const second = (await db.query('select stg_service_request($1) s', [JSON.stringify({ house_id: dh.id, rooms: 0, addons: ['addon_sofa'] })])).rows[0].s;
  await db.query('select stg_set_service($1,$2)', [second.id, 'cancelled']);
  mineList = (await db.query('select stg_services_list() l')).rows[0].l;
  ok(second.estimate_cents === 7900 && mineList.find(x => x.id === second.id).status === 'cancelled', 'a new request can be cancelled by the customer who made it');

  // one price book, three copies: Richard's site, this site's config.js, and the database
  await as(null);
  const cfgSrc = readFileSync(join(here, '..', 'config.js'), 'utf8');
  const win = { location: { search: '', hostname: 'localhost' } };
  new Function('window', 'location', 'localStorage', 'URLSearchParams', cfgSrc)(win, win.location, { getItem: () => null, setItem() {} }, URLSearchParams);
  const book = win.HLS_CONFIG.services.carpet;
  const sqlPrice = async (rooms, addons) => (await db.query('select stg_carpet_estimate($1,$2) c', [rooms, addons])).rows[0].c;
  let same = (await sqlPrice(1, [])) === book.firstRoomCents
    && (await sqlPrice(2, [])) === book.firstRoomCents + book.extraRoomCents
    && (await sqlPrice(book.maxRooms, [])) === book.firstRoomCents + (book.maxRooms - 1) * book.extraRoomCents;
  for (const a of book.addons) same = same && (await sqlPrice(0, [a.key])) === a.cents;
  ok(same, 'config.js and the database price a cleaning the same way');
  const richards = join(here, '..', '..', 'richards-carpet-cleaning', 'supabase', 'functions', '_shared', 'pricing.js');
  if (existsSync(richards)) {
    const src = readFileSync(richards, 'utf8').replace(/^export /gm, '');
    const R = new Function(src + '; return { DEFAULT_PRICE_BOOK, MAX_ROOMS };')();
    const rb = R.DEFAULT_PRICE_BOOK;
    ok(R.MAX_ROOMS === book.maxRooms && rb.rooms.first_cents === book.firstRoomCents && rb.rooms.additional_cents === book.extraRoomCents
       && rb.addons.length === book.addons.length
       && rb.addons.every(a => book.addons.some(b => b.key === a.key && b.cents === a.amount_cents && b.label === a.label)),
       "and both match Richard's own price book");
  } else {
    console.log("  skip  Richard's repo is not next door, so his price book was not compared");
  }

  console.log('\n== services: Hughes Move & Tote ==');
  await as('anon');
  await refused('select stg_service_request($1)', [JSON.stringify({ service: 'move', house_id: dh.id, mode: 'totes', totes: 30, weeks: 2 })], 'anon cannot ask for totes');
  await as('authenticated', BUYER);
  const ask = async (o) => (await db.query('select stg_service_request($1) s', [JSON.stringify({ service: 'move', house_id: dh.id, ...o })])).rows[0].s;
  const totes30 = await ask({ mode: 'totes', totes: 30, weeks: 2, estimate_cents: 1 });
  ok(totes30.service === 'move' && totes30.estimate_cents === 30 * 275 * 2 && totes30.details.mode === 'totes' && !('estimate_cents' in totes30.details),
     '30 totes for 2 weeks: the 20-39 tier, $165, priced by the database');
  ok((await ask({ mode: 'totes', totes: 5, weeks: 1 })).estimate_cents === 9900, '5 totes for a week comes up to the $99 order minimum');
  ok((await ask({ mode: 'totes', totes: 40, weeks: 2 })).estimate_cents === 40 * 225 * 2, '40 totes for 2 weeks reach the lowest tier, $180');
  const crew = await ask({ mode: 'move', truck: '26ft', movers: 3, hours: 4, totes: 20, weeks: 2 });
  ok(crew.estimate_cents === (12900 + 4500) * 4 + 9500 + 20 * 150 * 2 && crew.details.truck === '26ft',
     'a 26 ft truck, 3 movers, 4 hours, 20 bundled totes: $851');
  ok((await ask({ mode: 'move', truck: '16ft', hours: 2 })).estimate_cents === 10900 * 2 + 9500, 'a crew with no totes is allowed: 2 hours + trip fee');
  for (const [bad, why] of [
    [{ mode: 'totes', totes: 0, weeks: 1 }, 'a rental needs at least one tote'],
    [{ mode: 'totes', totes: 201, weeks: 1 }, 'no more than 200 totes'],
    [{ mode: 'totes', totes: 10, weeks: 13 }, 'no more than 12 weeks'],
    [{ mode: 'move', truck: '40ft', hours: 3 }, 'an unknown truck is refused'],
    [{ mode: 'move', truck: '16ft', hours: 1 }, 'the 2-hour minimum holds'],
    [{ mode: 'move', truck: '16ft', hours: 3, movers: 5 }, 'no more than 4 movers'],
  ]) await refused('select stg_service_request($1)', [JSON.stringify({ service: 'move', house_id: dh.id, ...bad })], why);
  await refused('select stg_service_request($1)', [JSON.stringify({ service: 'move', house_id: listing.id, mode: 'totes', totes: 30, weeks: 1 })], "and not at someone else's house");
  await refused('select stg_service_request($1)', [JSON.stringify({ service: 'paint', house_id: dh.id })], 'an unknown service is refused');
  const stillCarpet = (await db.query('select stg_service_request($1) s', [JSON.stringify({ house_id: dh.id, rooms: 2 })])).rows[0].s;
  ok(stillCarpet.service === 'carpet' && stillCarpet.estimate_cents === 9900, 'a carpet request still works through the same door');

  // one rate card, three copies: Move & Tote's site, this site's config.js, and the database
  await as(null);
  const mv = win.HLS_CONFIG.services.move;
  const est = async (o) => (await db.query('select stg_move_estimate($1) e', [JSON.stringify(o)])).rows[0].e.estimate_cents;
  const tier = (n) => mv.toteTiers.find(t => n >= t.min).cents;
  let sameMove = true;
  for (const n of [1, 19, 20, 39, 40, 200]) sameMove = sameMove && (await est({ mode: 'totes', totes: n, weeks: 3 })) === Math.max(n * tier(n) * 3, mv.toteMinimumCents);
  for (const truck of Object.keys(mv.truckHourlyCents)) {
    sameMove = sameMove && (await est({ mode: 'move', truck, movers: 4, hours: 5, totes: 10, weeks: 2 }))
      === (mv.truckHourlyCents[truck] + 2 * mv.extraMoverCents) * 5 + mv.tripFeeCents + 10 * mv.toteWithMoveCents * 2;
  }
  ok(sameMove, 'config.js and the database price totes and a move the same way');
  const moveSite = join(here, '..', '..', 'hughes-move-tote', 'index.html');
  const rates = existsSync(moveSite) && readFileSync(moveSite, 'utf8').match(/const RATES = (\{[\s\S]*?\n    \});/);
  if (rates) {
    const R = new Function('return ' + rates[1])();
    const c = (d) => Math.round(d * 100);
    ok(R.toteTiers.length === mv.toteTiers.length && R.toteTiers.every((t, k) => t.min === mv.toteTiers[k].min && c(t.rate) === mv.toteTiers[k].cents)
       && c(R.toteWithMove) === mv.toteWithMoveCents && c(R.toteMinimum) === mv.toteMinimumCents
       && Object.keys(R.truckHourly).length === Object.keys(mv.truckHourlyCents).length
       && Object.keys(R.truckHourly).every(k => c(R.truckHourly[k]) === mv.truckHourlyCents[k])
       && c(R.extraMoverHourly) === mv.extraMoverCents && c(R.tripFee) === mv.tripFeeCents && R.minimumHours === mv.minHours,
       "and both match the RATES on Move & Tote's own site");
  } else {
    console.log("  skip  Move & Tote's site is not next door, so its RATES were not compared");
  }

  console.log('\n== QR page opens ==');
  await as('authenticated', STAFF);
  await db.query('select stg_save_house($1)', [JSON.stringify({ ...dh, status: 'staged', account_id: BUYER })]);
  await as('anon');
  await refused('select * from stg_scans', [], 'anon cannot read the scan counts');
  await refused('select stg_scans_list()', [], 'anon cannot list scan counts');
  await db.query('select stg_scan($1)', [dh.code]);
  await db.query('select stg_scan($1)', [dh.code.toLowerCase()]);
  await db.query('select stg_scan($1)', [' ' + dh.code + ' ']);
  await db.query('select stg_scan($1)', ['NOPE0000']);
  await db.query('select stg_scan($1)', [listing.code]);                 // a planned house: its page is closed
  await as('authenticated', BUYER);
  let sc = (await db.query('select stg_scans_list() l')).rows[0].l;
  ok(sc.length === 1 && sc[0].n === 3 && sc[0].house_id === dh.id && Object.keys(sc[0]).sort().join() === 'day,house_id,n',
     'three opens of a staged house are one row of 3, holding nothing about the visitor');
  await as('authenticated', AGENT);
  ok((await db.query('select stg_scans_list() l')).rows[0].l.length === 0, "the realtor sees no counts for the designer's house, and none for a closed page");
  await as('authenticated', STAFF);
  ok((await db.query('select stg_scans_list() l')).rows[0].l.length === 1, 'staff see every count');

  console.log('\n== payment link on an order ==');
  const order = (await db.query('select stg_office() o')).rows[0].o.requests.find(r => r.house_id === dh.id);
  await refused('select stg_set_request_pay($1,$2,false)', [order.id, 'http://pay.example/x'], 'a payment link must be https');
  await refused('select stg_set_request_pay($1,$2,false)', [order.id, 'javascript:alert(1)'], 'and cannot be a script');
  await db.query('select stg_set_request_pay($1,$2,false)', [order.id, ' https://pay.example/inv/123 ']);
  let paidRow = (await db.query('select stg_office() o')).rows[0].o.requests.find(r => r.id === order.id);
  ok(paidRow.pay_url === 'https://pay.example/inv/123' && paidRow.paid_at === null, 'staff save a payment link on the order');
  await db.query('select stg_set_request_pay($1,$2,true)', [order.id, 'https://pay.example/inv/123']);
  paidRow = (await db.query('select stg_office() o')).rows[0].o.requests.find(r => r.id === order.id);
  ok(paidRow.paid_at !== null, 'and mark it paid');
  await db.query('select stg_set_request_pay($1,$2,false)', [order.id, 'https://pay.example/inv/123']);
  ok((await db.query('select stg_office() o')).rows[0].o.requests.find(r => r.id === order.id).paid_at === null, 'or not paid again');
  await as('authenticated', BUYER);
  await refused('select stg_set_request_pay($1,$2,true)', [order.id, 'https://pay.example/mine'], 'a customer cannot set a payment link');
  ok(!/pay\.example|pay_url|paid_at/.test(JSON.stringify((await db.query('select stg_portal() p')).rows[0].p)), 'and never receives one');
  await as('anon');
  await refused('select stg_set_request_pay($1,$2,true)', [order.id, 'https://pay.example/x'], 'nor can anyone signed out');

  await as(null);
  // the auction project's own guarantee must still hold with staging installed
  const leak = (await db.query(`select count(*)::int n from information_schema.role_table_grants
    where table_schema='public' and grantee in ('anon','authenticated')
      and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`)).rows[0].n;
  ok(leak === 0, 'still no browser write privilege on any table (auctions 0004 rule)');
} catch (e) {
  fail++;
  console.log(`  ERROR: ${e.message}${e.position ? ' at char ' + e.position : ''}`);
}

await db.end().catch(() => {});
await server.stop();
rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
