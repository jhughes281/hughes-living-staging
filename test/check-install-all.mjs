// Runs supabase/install-all.sql (the one-paste file) on a throwaway Postgres,
// twice, on top of the auction core, and checks it is still the numbered
// files in order:  node test/check-install-all.mjs
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

const sql = (f) => readFileSync(join(here, '..', 'supabase', f), 'utf8');
const all = sql('install-all.sql');
const parts = ['0001_staging.sql', '0002_accounts.sql', '0003_services.sql', '0004_move_tote.sql', '0005_scans_payments.sql'];
let at = 0, inOrder = true;
for (const f of parts) { const i = all.indexOf(sql(f), at); if (i < 0) inOrder = false; at = i + 1; }

const PORT = 5440, DATA = join(tmpdir(), 'hls-install-all-pgdata');
if (existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });
const server = new EmbeddedPostgres({ databaseDir: DATA, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
await server.initialise();
await server.start();
const db = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'postgres', database: 'postgres' });
await db.connect();
db.on('notice', () => {});

let bad = inOrder ? 0 : 1;
console.log(inOrder ? 'ok    install-all.sql holds every numbered file, unchanged and in order'
                    : 'FAIL  install-all.sql is out of date: rebuild it from the numbered files');
try {
  const mig = join(AUCTIONS, 'supabase', 'migrations');
  for (const f of [join(AUCTIONS, 'test', '00_auth_shim.sql'),
                   ...readdirSync(mig).filter(f => f.endsWith('.sql')).sort().map(f => join(mig, f))]) {
    await db.query(readFileSync(f, 'utf8'));
  }
  await db.query(all);
  await db.query(all);
  const t = (await db.query(`select count(*)::int n from information_schema.tables where table_schema='public' and table_name like 'stg\\_%'`)).rows[0].n;
  const f = (await db.query(`select count(distinct proname)::int n from pg_proc where proname like 'stg\\_%'`)).rows[0].n;
  console.log(`ok    ran twice with no error: ${t} stg_ tables, ${f} stg_ functions`);
  if (t !== 8) { bad++; console.log('FAIL  expected 8 stg_ tables'); }
} catch (e) {
  bad++;
  console.log('FAIL  ' + e.message);
}
await db.end().catch(() => {});
await server.stop();
rmSync(DATA, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
