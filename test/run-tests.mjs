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
  ok(true, 'auction core + staging + accounts applied, each a second time');

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

  await as('authenticated', STAFF);
  office = (await db.query('select stg_office() o')).rows[0].o;
  ok(office.accounts.length === 2 && office.houses.length === 2, 'staff see both accounts and every house');
  ok((await db.query('select stg_my_account() a')).rows[0].a.kind === 'owner', 'staff sign in as the owner');
  await db.query('select stg_place($1,null,null)', [spare.id]);
  ok(true, 'staff can move any piece');

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
