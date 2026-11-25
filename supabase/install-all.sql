-- Hughes Living Staging: everything in one file.
-- 0001_staging.sql + 0002_accounts.sql + 0003_services.sql + 0004_move_tote.sql + 0005_scans_payments.sql, in order. Safe to run twice.
-- Paste into the Supabase SQL editor (project otkkmcxgufrspwipdfgk) and press Run.
-- Built from the numbered files; edit those, not this one.


-- ======================================================================
-- 0001_staging.sql
-- ======================================================================

-- Hughes Living Staging — houses, the furniture in them, and who asked for it
--
-- Lives in the SAME database as Hughes Living Auctions and leans on one thing
-- from it: is_staff() (auctions migration 0006). Everything here is prefixed
-- stg_ so the two never collide.
--
-- The auction project's rule is kept: the browser writes to no table. Every
-- table below has row level security on, no policies, and no grants. The
-- functions are the only doors:
--
--   staff (signed in, bidders.is_staff)   stg_office, stg_save_house,
--                                          stg_save_item, stg_delete_house,
--                                          stg_delete_item, stg_set_request,
--                                          stg_catalog_import, stg_catalog_search
--   anyone with a house's QR code          stg_house_public, stg_request
--                                          (buy a piece, buy the look, or ask)
--
-- Safe to run twice.

-- ---------------------------------------------------------------- codes
-- What the QR code carries. Eight characters from an alphabet with no 0/O/1/I,
-- so a code read aloud or typed off a card survives. Houses cannot be listed
-- by the public, only opened by code, so the code is the key to the page.
create or replace function stg_new_code()
returns text
language plpgsql volatile
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v text := '';
begin
  for i in 1..8 loop
    v := v || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return v;
end;
$$;

-- ---------------------------------------------------------------- houses
create table if not exists stg_houses (
  id            bigint generated always as identity primary key,
  code          text not null unique default stg_new_code(),
  address       text not null check (length(btrim(address)) > 0),
  city          text,
  zip           text,
  -- who hired the staging: an agent, a seller, a builder. Never public.
  client_name   text,
  client_phone  text,
  client_email  text,
  listing_url   text,
  status        text not null default 'planned'
                check (status in ('planned', 'staged', 'destaged')),
  staged_on     date,
  destage_on    date,
  fee_cents     integer not null default 0 check (fee_cents >= 0),
  public_note   text,          -- printed on the buyer page
  cover_url     text,          -- a photo of the staged house, shown on the buyer page
  notes         text,          -- office only
  created_at    timestamptz not null default now()
);

comment on column stg_houses.status is
  'planned: not set up yet. staged: furniture is in and the buyer page is open. destaged: furniture is out and the buyer page says so.';

-- ---------------------------------------------------------------- furniture
create sequence if not exists stg_tag_seq start 1001;

create table if not exists stg_items (
  id            bigint generated always as identity primary key,
  tag_no        integer not null unique default nextval('stg_tag_seq'),
  title         text not null check (length(btrim(title)) > 0),
  category      text,
  -- where the piece came from: the Shopify store, an auction lot, or neither
  source        text not null default 'other'
                check (source in ('store', 'auction', 'other')),
  source_ref    text,          -- store handle / SKU, or auction lot number
  source_url    text,          -- product page a buyer can open
  photo_url     text,
  cost_cents    integer check (cost_cents  >= 0),   -- office only
  price_cents   integer check (price_cents >= 0),
  details       text,          -- size, finish, condition: printed for buyers
  notes         text,          -- office only
  status        text not null default 'available'
                check (status in ('available', 'hold', 'sold', 'retired')),
  -- where it is. null house = in the warehouse. A sold piece can stay in the
  -- house until the staging ends, which is why this is not part of status.
  house_id      bigint references stg_houses (id) on delete set null,
  room          text,
  sold_at       timestamptz,
  sold_cents    integer check (sold_cents >= 0),
  sold_to       text,
  -- the house it sold out of, kept after the piece leaves so the sale still
  -- counts toward that house
  sold_house_id bigint references stg_houses (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists stg_items_house on stg_items (house_id);

-- ---------------------------------------------------------------- where it has been
-- One row per stay in a house. Written by the trigger below, never by hand,
-- so "how long has this sofa been out" has an answer that cannot drift.
create table if not exists stg_moves (
  id          bigint generated always as identity primary key,
  item_id     bigint not null references stg_items (id) on delete cascade,
  house_id    bigint not null references stg_houses (id) on delete cascade,
  room        text,
  placed_at   timestamptz not null default now(),
  removed_at  timestamptz
);

create index if not exists stg_moves_item on stg_moves (item_id);

create or replace function stg_track_move()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.house_id is not distinct from old.house_id then
    -- same house: keep the open stay's room in step, nothing else
    if new.house_id is not null and new.room is distinct from old.room then
      update stg_moves set room = new.room
       where item_id = new.id and removed_at is null;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.house_id is not null then
    update stg_moves set removed_at = now()
     where item_id = new.id and removed_at is null;
  end if;

  if new.house_id is not null then
    insert into stg_moves (item_id, house_id, room)
    values (new.id, new.house_id, new.room);
  end if;
  return new;
end;
$$;

drop trigger if exists stg_items_track_move on stg_items;
create trigger stg_items_track_move
  after insert or update of house_id, room on stg_items
  for each row execute function stg_track_move();

-- ---------------------------------------------------------------- requests
-- Sent from the buyer page: "Buy this piece", "Buy the look" (every piece
-- still available in the house) or a plain question. None of them takes
-- money; each is an order for the office to confirm.
create table if not exists stg_requests (
  id          bigint generated always as identity primary key,
  house_id    bigint not null references stg_houses (id) on delete cascade,
  item_id     bigint references stg_items (id) on delete set null,
  item_title  text,            -- kept so the request still reads after a delete
  name        text not null,
  phone       text,
  email       text,
  note        text,
  kind        text not null default 'piece'
              check (kind in ('piece', 'look', 'question')),
  -- for 'look': what was available at the moment they asked, so the order
  -- still reads correctly after pieces sell or prices change
  piece_count integer,
  total_cents integer,
  status      text not null default 'new'
              check (status in ('new', 'contacted', 'sold', 'closed')),
  created_at  timestamptz not null default now()
);

create index if not exists stg_requests_house on stg_requests (house_id, created_at);

-- ---------------------------------------------------------------- store catalog
-- A copy of the Shopify product export, loaded from the office page, so a piece
-- can be added by searching the store instead of retyping it. Holds cost, so it
-- is as private as everything else here.
create table if not exists stg_catalog (
  handle      text not null,
  variant     text not null default '',
  sku         text,
  title       text not null,
  category    text,
  price_cents integer,
  cost_cents  integer,
  image_url   text,
  primary key (handle, variant)
);

-- ---------------------------------------------------------------- closed by default
alter table stg_houses   enable row level security;
alter table stg_items    enable row level security;
alter table stg_moves    enable row level security;
alter table stg_requests enable row level security;
alter table stg_catalog  enable row level security;

revoke all on stg_houses, stg_items, stg_moves, stg_requests, stg_catalog
  from anon, authenticated;
revoke all on sequence stg_tag_seq from anon, authenticated;

-- ---------------------------------------------------------------- helpers
create or replace function stg_require_staff()
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then
    raise exception 'not staff' using errcode = '42501';
  end if;
end;
$$;

-- '' and whitespace arrive from form fields; store them as null.
create or replace function stg_txt(p jsonb, k text)
returns text
language sql immutable
as $$ select nullif(btrim(p ->> k), '') $$;

create or replace function stg_int(p jsonb, k text)
returns integer
language sql immutable
as $$ select nullif(btrim(p ->> k), '')::integer $$;

-- ---------------------------------------------------------------- the office read
-- One call, everything the office page needs. The data is small (a few houses,
-- a few hundred pieces), so the page does its own arithmetic.
create or replace function stg_office()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform stg_require_staff();
  return jsonb_build_object(
    'houses',   coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc) from stg_houses h), '[]'::jsonb),
    'items',    coalesce((select jsonb_agg(to_jsonb(i) order by i.tag_no) from stg_items i), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from stg_requests r), '[]'::jsonb),
    'moves',    coalesce((select jsonb_agg(to_jsonb(m) order by m.placed_at) from stg_moves m), '[]'::jsonb),
    'catalog_count', (select count(*) from stg_catalog)
  );
end;
$$;

-- ---------------------------------------------------------------- save a house
create or replace function stg_save_house(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint := stg_int(p, 'id');
  v    stg_houses;
begin
  perform stg_require_staff();
  if stg_txt(p, 'address') is null then
    raise exception 'A house needs an address.' using errcode = '22023';
  end if;

  if v_id is null then
    insert into stg_houses (address) values (stg_txt(p, 'address')) returning id into v_id;
  end if;

  update stg_houses set
    address      = stg_txt(p, 'address'),
    city         = stg_txt(p, 'city'),
    zip          = stg_txt(p, 'zip'),
    client_name  = stg_txt(p, 'client_name'),
    client_phone = stg_txt(p, 'client_phone'),
    client_email = stg_txt(p, 'client_email'),
    listing_url  = stg_txt(p, 'listing_url'),
    status       = coalesce(stg_txt(p, 'status'), 'planned'),
    staged_on    = stg_txt(p, 'staged_on')::date,
    destage_on   = stg_txt(p, 'destage_on')::date,
    fee_cents    = coalesce(stg_int(p, 'fee_cents'), 0),
    public_note  = stg_txt(p, 'public_note'),
    cover_url    = stg_txt(p, 'cover_url'),
    notes        = stg_txt(p, 'notes')
  where id = v_id
  returning * into v;

  if v.id is null then
    raise exception 'That house no longer exists.' using errcode = 'P0002';
  end if;
  return to_jsonb(v);
end;
$$;

-- ---------------------------------------------------------------- save a piece
create or replace function stg_save_item(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id     bigint := stg_int(p, 'id');
  v_status text   := coalesce(stg_txt(p, 'status'), 'available');
  v_house  bigint := stg_int(p, 'house_id');
  v_old    stg_items;
  v        stg_items;
begin
  perform stg_require_staff();
  if stg_txt(p, 'title') is null then
    raise exception 'A piece needs a name.' using errcode = '22023';
  end if;

  if v_id is null then
    insert into stg_items (title) values (stg_txt(p, 'title')) returning * into v_old;
    v_id := v_old.id;
  else
    select * into v_old from stg_items where id = v_id for update;
    if v_old.id is null then
      raise exception 'That piece no longer exists.' using errcode = 'P0002';
    end if;
  end if;

  update stg_items set
    title       = stg_txt(p, 'title'),
    category    = stg_txt(p, 'category'),
    source      = coalesce(stg_txt(p, 'source'), 'other'),
    source_ref  = stg_txt(p, 'source_ref'),
    source_url  = stg_txt(p, 'source_url'),
    photo_url   = stg_txt(p, 'photo_url'),
    cost_cents  = stg_int(p, 'cost_cents'),
    price_cents = stg_int(p, 'price_cents'),
    details     = stg_txt(p, 'details'),
    notes       = stg_txt(p, 'notes'),
    status      = v_status,
    house_id    = v_house,
    room        = case when v_house is null then null else stg_txt(p, 'room') end,
    -- a sale is stamped once, with the house it sold out of; un-selling clears it
    sold_at     = case when v_status = 'sold'
                       then coalesce(stg_txt(p, 'sold_at')::timestamptz, v_old.sold_at, now()) end,
    sold_cents  = case when v_status = 'sold'
                       then coalesce(stg_int(p, 'sold_cents'), stg_int(p, 'price_cents')) end,
    sold_to     = case when v_status = 'sold' then stg_txt(p, 'sold_to') end,
    sold_house_id = case when v_status = 'sold'
                         then coalesce(v_old.sold_house_id, v_house, v_old.house_id) end,
    updated_at  = now()
  where id = v_id
  returning * into v;

  return to_jsonb(v);
end;
$$;

-- ---------------------------------------------------------------- deletes
create or replace function stg_delete_item(p_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform stg_require_staff();
  delete from stg_items where id = p_id;
end;
$$;

-- A house with furniture still in it is not deleted out from under the pieces.
create or replace function stg_delete_house(p_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform stg_require_staff();
  if exists (select 1 from stg_items where house_id = p_id) then
    raise exception 'Move the furniture out of this house before deleting it.' using errcode = '23503';
  end if;
  delete from stg_houses where id = p_id;
end;
$$;

create or replace function stg_set_request(p_id bigint, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform stg_require_staff();
  update stg_requests set status = p_status where id = p_id;
end;
$$;

-- ---------------------------------------------------------------- store catalog
create or replace function stg_catalog_import(p_rows jsonb, p_replace boolean default false)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  perform stg_require_staff();
  if p_replace then
    delete from stg_catalog where true;
  end if;
  insert into stg_catalog (handle, variant, sku, title, category, price_cents, cost_cents, image_url)
  select stg_txt(r, 'handle'), coalesce(stg_txt(r, 'variant'), ''), stg_txt(r, 'sku'),
         stg_txt(r, 'title'), stg_txt(r, 'category'),
         stg_int(r, 'price_cents'), stg_int(r, 'cost_cents'), stg_txt(r, 'image_url')
    from jsonb_array_elements(p_rows) r
   where stg_txt(r, 'handle') is not null and stg_txt(r, 'title') is not null
  on conflict (handle, variant) do update set
    sku = excluded.sku, title = excluded.title, category = excluded.category,
    price_cents = excluded.price_cents, cost_cents = excluded.cost_cents,
    image_url = excluded.image_url;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function stg_catalog_search(p_q text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_q text := '%' || replace(replace(btrim(coalesce(p_q, '')), '%', ''), '_', '') || '%';
begin
  perform stg_require_staff();
  return coalesce((
    select jsonb_agg(to_jsonb(c))
      from (select * from stg_catalog
             where title ilike v_q or sku ilike v_q or handle ilike v_q
             order by title, variant
             limit 30) c
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- the buyer page
-- What a phone gets for a QR code. Deliberately a hand-built object rather
-- than to_jsonb(row): cost, office notes, the client's name and the buyer's
-- name on a sold piece must never be in it, and a column added later should
-- not leak by default.
create or replace function stg_house_public(p_code text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  h stg_houses;
begin
  select * into h from stg_houses where code = upper(btrim(coalesce(p_code, '')));
  if h.id is null then
    return jsonb_build_object('found', false);
  end if;
  if h.status <> 'staged' then
    return jsonb_build_object('found', true, 'open', false, 'address', h.address, 'city', h.city);
  end if;

  return jsonb_build_object(
    'found', true, 'open', true,
    'code', h.code, 'address', h.address, 'city', h.city, 'note', h.public_note,
    'cover_url', h.cover_url,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tag_no', i.tag_no, 'title', i.title, 'category', i.category,
               'room', coalesce(i.room, 'Around the house'),
               'price_cents', i.price_cents, 'photo_url', i.photo_url,
               'details', i.details, 'status', i.status,
               'source', i.source, 'source_url', i.source_url)
             order by i.room nulls last, i.tag_no)
        from stg_items i
       where i.house_id = h.id and i.status in ('available', 'hold', 'sold')
    ), '[]'::jsonb)
  );
end;
$$;

-- A buyer's request. Anyone holding the code can call this, so it validates
-- like a public form: lengths capped, a way to reach them required, and a
-- ceiling per house per hour so one script cannot bury the inbox.
create or replace function stg_request(
  p_code text, p_tag_no integer, p_name text, p_phone text, p_email text, p_note text,
  p_kind text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  h      stg_houses;
  i      stg_items;
  v_name text := left(btrim(coalesce(p_name, '')), 80);
  v_ph   text := nullif(left(btrim(coalesce(p_phone, '')), 30), '');
  v_em   text := nullif(left(btrim(coalesce(p_email, '')), 120), '');
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_kind text := coalesce(nullif(btrim(p_kind), ''), case when p_tag_no is null then 'question' else 'piece' end);
  v_n     integer;
  v_total integer;
begin
  if v_kind not in ('piece', 'look', 'question') then
    raise exception 'Unknown kind of request.' using errcode = '22023';
  end if;
  select * into h from stg_houses where code = upper(btrim(coalesce(p_code, '')));
  if h.id is null or h.status <> 'staged' then
    raise exception 'This house is not taking requests.' using errcode = '22023';
  end if;
  if v_name = '' then
    raise exception 'Please give your name.' using errcode = '22023';
  end if;
  if v_ph is null and v_em is null then
    raise exception 'Leave a phone number or an email so we can reach you.' using errcode = '22023';
  end if;

  if v_kind = 'look' then
    -- the look is whatever is still available, priced here rather than trusted from the page
    select count(*)::int, coalesce(sum(price_cents), 0)::int into v_n, v_total
      from stg_items where house_id = h.id and status = 'available';
    if v_n = 0 then
      raise exception 'Nothing in this home is available right now.' using errcode = '22023';
    end if;
  elsif p_tag_no is not null then
    select * into i from stg_items where tag_no = p_tag_no and house_id = h.id;
    if i.id is null then
      raise exception 'That piece is not in this house.' using errcode = '22023';
    end if;
    if i.status = 'sold' then
      raise exception 'That piece has already sold.' using errcode = '22023';
    end if;
  end if;

  if (select count(*) from stg_requests
       where house_id = h.id and created_at > now() - interval '1 hour') >= 40 then
    raise exception 'Too many requests just now. Please call us instead.' using errcode = '54000';
  end if;

  insert into stg_requests (house_id, item_id, item_title, name, phone, email, note, kind, piece_count, total_cents)
  values (h.id, i.id, i.title, v_name, v_ph, v_em, v_note, v_kind, v_n, v_total);
  return true;
end;
$$;

-- ---------------------------------------------------------------- who may call what
-- CREATE FUNCTION grants EXECUTE to PUBLIC and anon inherits PUBLIC, so revoke
-- from public first (auctions 0004 learned this the hard way), then grant back.
revoke execute on function stg_new_code()                          from public;
revoke execute on function stg_track_move()                        from public;
revoke execute on function stg_require_staff()                     from public;
revoke execute on function stg_office()                            from public;
revoke execute on function stg_save_house(jsonb)                   from public;
revoke execute on function stg_save_item(jsonb)                    from public;
revoke execute on function stg_delete_item(bigint)                 from public;
revoke execute on function stg_delete_house(bigint)                from public;
revoke execute on function stg_set_request(bigint, text)           from public;
revoke execute on function stg_catalog_import(jsonb, boolean)      from public;
revoke execute on function stg_catalog_search(text)                from public;
revoke execute on function stg_house_public(text)                  from public;
revoke execute on function stg_request(text, integer, text, text, text, text, text) from public;

-- staff doors: any signed-in account may knock, is_staff decides inside
grant execute on function stg_office()                       to authenticated;
grant execute on function stg_save_house(jsonb)              to authenticated;
grant execute on function stg_save_item(jsonb)               to authenticated;
grant execute on function stg_delete_item(bigint)            to authenticated;
grant execute on function stg_delete_house(bigint)           to authenticated;
grant execute on function stg_set_request(bigint, text)      to authenticated;
grant execute on function stg_catalog_import(jsonb, boolean) to authenticated;
grant execute on function stg_catalog_search(text)           to authenticated;

-- public doors: the QR code is the key
grant execute on function stg_house_public(text) to anon, authenticated;
grant execute on function stg_request(text, integer, text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------- photos
-- Supabase only (plain Postgres has no storage schema). A public-read bucket:
-- the photos are of furniture shown to buyers anyway. Only staff can add,
-- replace or remove.
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('staging', 'staging', true)
    on conflict (id) do nothing;

    drop policy if exists stg_photos_insert on storage.objects;
    drop policy if exists stg_photos_update on storage.objects;
    drop policy if exists stg_photos_delete on storage.objects;

    create policy stg_photos_insert on storage.objects
      for insert to authenticated
      with check (bucket_id = 'staging' and public.is_staff());
    create policy stg_photos_update on storage.objects
      for update to authenticated
      using (bucket_id = 'staging' and public.is_staff());
    create policy stg_photos_delete on storage.objects
      for delete to authenticated
      using (bucket_id = 'staging' and public.is_staff());
  end if;
end $$;

-- ---------------------------------------------------------------- verification
-- Fail the migration rather than ship a hole.
do $$
declare
  v_leak text;
begin
  select string_agg(format('%s %s to %s', table_name, privilege_type, grantee), ', ')
    into v_leak
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name like 'stg\_%'
     and grantee in ('anon', 'authenticated', 'PUBLIC');
  if v_leak is not null then
    raise exception 'staging table reachable from the browser: %', v_leak;
  end if;

  if has_function_privilege('anon', 'stg_office()', 'execute')
     or has_function_privilege('anon', 'stg_save_item(jsonb)', 'execute')
     or has_function_privilege('anon', 'stg_save_house(jsonb)', 'execute')
     or has_function_privilege('anon', 'stg_catalog_search(text)', 'execute') then
    raise exception 'a staff function is executable by anon';
  end if;

  raise notice 'staging verified: tables closed, staff doors need a session, two public doors';
end $$;

-- ======================================================================
-- 0002_accounts.sql
-- ======================================================================

-- Hughes Living Staging — customer accounts
--
-- Two kinds of people besides Hughes Living staff can sign in:
--
--   self      someone staging their own house (a homeowner, an agent)
--   designer  an interior designer staging for clients
--   realtor   an agent staging their listings
--
-- All three borrow Hughes Living furniture. Each sees only their own houses, the
-- pieces in them, and what is free in the warehouse to place. Neither ever
-- sees what a piece cost, the office notes, another customer's houses, or a
-- buyer's phone number: Hughes Living makes the sale.
--
-- Same rule as 0001: no table is readable or writable from the browser. Staff
-- keep stg_office(); customers get their own three doors:
--
--   stg_register          make (or update) my account after signing up
--   stg_portal            everything my screens need, already filtered
--   stg_portal_save_house add or edit one of MY houses
--   stg_place             put a free piece in one of my houses, or send it back
--
-- Needs 0001_staging.sql. Safe to run twice.

-- ---------------------------------------------------------------- accounts
create table if not exists stg_accounts (
  id          uuid primary key references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('self', 'designer', 'realtor')),
  name        text not null check (length(btrim(name)) > 0),
  studio      text,            -- a designer's studio, a realtor's brokerage
  phone       text,
  email       text,
  created_at  timestamptz not null default now()
);

alter table stg_accounts enable row level security;
revoke all on stg_accounts from anon, authenticated;

-- null = one of Hughes Living's own stagings
alter table stg_houses
  add column if not exists account_id uuid references stg_accounts (id) on delete set null;

create index if not exists stg_houses_account on stg_houses (account_id);

-- ---------------------------------------------------------------- who am I
-- What the page asks first. Staff answer as 'owner'; a customer gets their
-- account; a signed-in user with neither (an auction bidder, say) gets null
-- and is shown the "finish creating your account" form.
create or replace function stg_my_account()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  a stg_accounts;
begin
  if auth.uid() is null then
    return null;
  end if;
  if is_staff() then
    return jsonb_build_object('kind', 'owner', 'name', 'Hughes Living',
      'email', (select u.email from auth.users u where u.id = auth.uid()));
  end if;
  select * into a from stg_accounts where id = auth.uid();
  if a.id is null then
    return null;
  end if;
  return jsonb_build_object('kind', a.kind, 'name', a.name, 'studio', a.studio,
                            'phone', a.phone, 'email', a.email);
end;
$$;

-- The kind is chosen once. Calling this again updates the contact details but
-- cannot turn one kind of account into the other, and cannot make staff.
create or replace function stg_register(p_kind text, p_name text, p_studio text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text := left(btrim(coalesce(p_name, '')), 80);
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if p_kind not in ('self', 'designer', 'realtor') then
    raise exception 'Choose staging it myself, interior designer or realtor.' using errcode = '22023';
  end if;
  if v_name = '' then
    raise exception 'Please give your name.' using errcode = '22023';
  end if;

  insert into stg_accounts (id, kind, name, studio, phone, email)
  values (auth.uid(), p_kind, v_name,
          nullif(left(btrim(coalesce(p_studio, '')), 80), ''),
          nullif(left(btrim(coalesce(p_phone, '')), 30), ''),
          (select u.email from auth.users u where u.id = auth.uid()))
  on conflict (id) do update set
    name = excluded.name, studio = excluded.studio, phone = excluded.phone;

  return stg_my_account();
end;
$$;

-- The caller's account id, or an error. Every customer door starts here.
create or replace function stg_require_account()
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v uuid;
begin
  select id into v from stg_accounts where id = auth.uid();
  if v is null then
    raise exception 'no staging account' using errcode = '42501';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------- the customer read
-- Hand-built objects, like the buyer page: cost_cents, office notes, sold_to
-- and buyers' contact details are simply not in them.
create or replace function stg_portal()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := stg_require_account();
begin
  return jsonb_build_object(
    'houses', coalesce((
      select jsonb_agg(to_jsonb(h) - 'notes' order by h.created_at desc)
        from stg_houses h where h.account_id = v_me), '[]'::jsonb),

    -- pieces in my houses, pieces that sold out of my houses, and whatever is
    -- free in the warehouse for me to place
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'tag_no', i.tag_no, 'title', i.title, 'category', i.category,
               'source', i.source, 'source_url', i.source_url, 'photo_url', i.photo_url,
               'price_cents', i.price_cents, 'details', i.details, 'status', i.status,
               'house_id', i.house_id, 'room', i.room,
               'sold_at', i.sold_at, 'sold_cents', i.sold_cents, 'sold_house_id', i.sold_house_id)
             order by i.tag_no)
        from stg_items i
       where i.house_id in (select id from stg_houses where account_id = v_me)
          or i.sold_house_id in (select id from stg_houses where account_id = v_me)
          or (i.house_id is null and i.status = 'available')), '[]'::jsonb),

    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'house_id', r.house_id, 'item_id', r.item_id, 'item_title', r.item_title,
               'name', r.name, 'note', r.note, 'kind', r.kind, 'piece_count', r.piece_count,
               'total_cents', r.total_cents, 'status', r.status, 'created_at', r.created_at)
             order by r.created_at desc)
        from stg_requests r
       where r.house_id in (select id from stg_houses where account_id = v_me)), '[]'::jsonb),

    'moves', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.placed_at)
        from stg_moves m
       where m.house_id in (select id from stg_houses where account_id = v_me)), '[]'::jsonb),

    'catalog_count', 0
  );
end;
$$;

-- ---------------------------------------------------------------- my houses
-- A customer sets where and when; Hughes Living sets the fee and keeps the
-- office note, so neither is taken from the form here.
create or replace function stg_portal_save_house(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid   := stg_require_account();
  v_id bigint := stg_int(p, 'id');
  v    stg_houses;
begin
  if stg_txt(p, 'address') is null then
    raise exception 'A house needs an address.' using errcode = '22023';
  end if;
  if coalesce(stg_txt(p, 'status'), 'planned') not in ('planned', 'staged', 'destaged') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;

  if v_id is null then
    insert into stg_houses (address, account_id) values (stg_txt(p, 'address'), v_me)
    returning id into v_id;
  end if;

  update stg_houses set
    address      = stg_txt(p, 'address'),
    city         = stg_txt(p, 'city'),
    zip          = stg_txt(p, 'zip'),
    client_name  = stg_txt(p, 'client_name'),
    client_phone = stg_txt(p, 'client_phone'),
    client_email = stg_txt(p, 'client_email'),
    listing_url  = stg_txt(p, 'listing_url'),
    status       = coalesce(stg_txt(p, 'status'), 'planned'),
    staged_on    = stg_txt(p, 'staged_on')::date,
    destage_on   = stg_txt(p, 'destage_on')::date,
    public_note  = stg_txt(p, 'public_note'),
    cover_url    = stg_txt(p, 'cover_url')
  where id = v_id and account_id = v_me
  returning * into v;

  if v.id is null then
    raise exception 'That is not one of your houses.' using errcode = '42501';
  end if;
  return to_jsonb(v) - 'notes';
end;
$$;

-- ---------------------------------------------------------------- placing furniture
-- The one thing a customer may do to a piece: move it between the warehouse
-- and their own houses. Staff may use it too, with no limits.
create or replace function stg_place(p_item bigint, p_house bigint, p_room text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid;
  i       stg_items;
  v_room  text := nullif(left(btrim(coalesce(p_room, '')), 60), '');
begin
  select * into i from stg_items where id = p_item for update;
  if i.id is null then
    raise exception 'That piece no longer exists.' using errcode = 'P0002';
  end if;

  if not is_staff() then
    v_me := stg_require_account();
    -- where it is now: free in the warehouse, or already in one of my houses
    if not ((i.house_id is null and i.status = 'available')
            or exists (select 1 from stg_houses where id = i.house_id and account_id = v_me)) then
      raise exception 'That piece is not yours to move.' using errcode = '42501';
    end if;
    if i.status = 'sold' then
      raise exception 'That piece has sold. Hughes Living will collect it.' using errcode = '42501';
    end if;
    -- where it is going: back to the warehouse, or one of my houses
    if p_house is not null
       and not exists (select 1 from stg_houses where id = p_house and account_id = v_me) then
      raise exception 'That is not one of your houses.' using errcode = '42501';
    end if;
  end if;

  update stg_items set
    house_id = p_house,
    room = case when p_house is null then null else v_room end,
    updated_at = now()
  where id = p_item;
end;
$$;

-- ---------------------------------------------------------------- staff: see the accounts
-- Replaces 0001's versions: the office read now lists accounts, and a house
-- can be assigned to one.
create or replace function stg_office()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform stg_require_staff();
  return jsonb_build_object(
    'houses',   coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc) from stg_houses h), '[]'::jsonb),
    'items',    coalesce((select jsonb_agg(to_jsonb(i) order by i.tag_no) from stg_items i), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from stg_requests r), '[]'::jsonb),
    'moves',    coalesce((select jsonb_agg(to_jsonb(m) order by m.placed_at) from stg_moves m), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from stg_accounts a), '[]'::jsonb),
    'catalog_count', (select count(*) from stg_catalog)
  );
end;
$$;

create or replace function stg_save_house(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint := stg_int(p, 'id');
  v    stg_houses;
begin
  perform stg_require_staff();
  if stg_txt(p, 'address') is null then
    raise exception 'A house needs an address.' using errcode = '22023';
  end if;

  if v_id is null then
    insert into stg_houses (address) values (stg_txt(p, 'address')) returning id into v_id;
  end if;

  update stg_houses set
    address      = stg_txt(p, 'address'),
    city         = stg_txt(p, 'city'),
    zip          = stg_txt(p, 'zip'),
    client_name  = stg_txt(p, 'client_name'),
    client_phone = stg_txt(p, 'client_phone'),
    client_email = stg_txt(p, 'client_email'),
    listing_url  = stg_txt(p, 'listing_url'),
    status       = coalesce(stg_txt(p, 'status'), 'planned'),
    staged_on    = stg_txt(p, 'staged_on')::date,
    destage_on   = stg_txt(p, 'destage_on')::date,
    fee_cents    = coalesce(stg_int(p, 'fee_cents'), 0),
    public_note  = stg_txt(p, 'public_note'),
    cover_url    = stg_txt(p, 'cover_url'),
    notes        = stg_txt(p, 'notes'),
    account_id   = stg_txt(p, 'account_id')::uuid
  where id = v_id
  returning * into v;

  if v.id is null then
    raise exception 'That house no longer exists.' using errcode = 'P0002';
  end if;
  return to_jsonb(v);
end;
$$;

-- ---------------------------------------------------------------- who may call what
revoke execute on function stg_my_account()                           from public;
revoke execute on function stg_register(text, text, text, text)       from public;
revoke execute on function stg_require_account()                      from public;
revoke execute on function stg_portal()                               from public;
revoke execute on function stg_portal_save_house(jsonb)               from public;
revoke execute on function stg_place(bigint, bigint, text)            from public;

grant execute on function stg_my_account()                     to authenticated;
grant execute on function stg_register(text, text, text, text) to authenticated;
grant execute on function stg_portal()                         to authenticated;
grant execute on function stg_portal_save_house(jsonb)         to authenticated;
grant execute on function stg_place(bigint, bigint, text)      to authenticated;

do $$
begin
  if has_table_privilege('anon', 'stg_accounts', 'select')
     or has_table_privilege('authenticated', 'stg_accounts', 'select') then
    raise exception 'stg_accounts is readable from the browser';
  end if;
  if has_function_privilege('anon', 'stg_portal()', 'execute')
     or has_function_privilege('anon', 'stg_place(bigint, bigint, text)', 'execute')
     or has_function_privilege('anon', 'stg_register(text, text, text, text)', 'execute') then
    raise exception 'a customer function is executable without signing in';
  end if;
  raise notice 'accounts verified: table closed, customer doors need a session';
end $$;

-- ======================================================================
-- 0003_services.sql
-- ======================================================================

-- Hughes Living Staging — services for a house
--
-- A signed-in customer can ask for carpet cleaning at one of their own houses
-- (Richard's Carpet Cleaning & Upholstery). It is a request, not a booking and
-- not a payment: it lands in the Hughes Living office, which arranges the visit.
--
-- The estimate is priced HERE, from the same numbers Richard's own site uses
-- (first room, a flat amount for each room after it, flat add-ons). The page
-- sends what was chosen, never a price.
--
-- Same rule as 0001 and 0002: no table is readable or writable from the
-- browser. Three doors:
--
--   stg_service_request   ask for a cleaning at one of my houses
--   stg_services_list     my requests (staff: everyone's)
--   stg_set_service       staff: any status. Customer: cancel my own new one.
--
-- Needs 0001_staging.sql and 0002_accounts.sql. Safe to run twice.

create table if not exists stg_services (
  id             bigint generated always as identity primary key,
  house_id       bigint not null references stg_houses (id) on delete cascade,
  account_id     uuid references stg_accounts (id) on delete set null,   -- null = asked for by staff
  service        text not null default 'carpet' check (service in ('carpet')),
  rooms          integer not null default 0 check (rooms between 0 and 8),
  addons         text[] not null default '{}',
  estimate_cents integer not null check (estimate_cents > 0),
  preferred_on   date,
  note           text,
  status         text not null default 'new'
                 check (status in ('new', 'scheduled', 'done', 'cancelled')),
  created_at     timestamptz not null default now()
);

create index if not exists stg_services_house on stg_services (house_id);

alter table stg_services enable row level security;
revoke all on stg_services from anon, authenticated;

-- ---------------------------------------------------------------- the price
-- Must match DEFAULT_PRICE_BOOK in richards-carpet-cleaning (pricing.js) and
-- services.carpet in this site's config.js. test/run-tests.mjs compares them.
create or replace function stg_carpet_estimate(p_rooms integer, p_addons text[])
returns integer
language plpgsql immutable set search_path = public as $$
declare
  v_total integer := 0;
  v_key   text;
  v_cents integer;
begin
  if p_rooms is null or p_rooms < 0 or p_rooms > 8 then
    raise exception 'Choose between 0 and 8 rooms.' using errcode = '22023';
  end if;
  if p_rooms > 0 then
    v_total := 7900 + (p_rooms - 1) * 2000;
  end if;
  for v_key in select distinct unnest(coalesce(p_addons, '{}')) loop
    v_cents := case v_key
      when 'addon_hall'       then 2500
      when 'addon_stairs'     then 4500
      when 'addon_pet'        then 4900
      when 'addon_scotchgard' then 3900
      when 'addon_sofa'       then 7900
    end;
    if v_cents is null then
      raise exception 'Unknown add-on.' using errcode = '22023';
    end if;
    v_total := v_total + v_cents;
  end loop;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------- asking
create or replace function stg_service_request(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     uuid;
  v_house  stg_houses;
  v_rooms  integer := coalesce(stg_int(p, 'rooms'), 0);
  v_addons text[];
  v_total  integer;
  v        stg_services;
begin
  select * into v_house from stg_houses where id = stg_int(p, 'house_id');
  if is_staff() then
    v_me := v_house.account_id;
  else
    v_me := stg_require_account();
    if v_house.id is not null and v_house.account_id is distinct from v_me then
      v_house := null;                       -- someone else's house reads the same as no house
    end if;
  end if;
  if v_house.id is null then
    raise exception 'That is not one of your houses.' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct a order by a), '{}') into v_addons
    from jsonb_array_elements_text(
           case when jsonb_typeof(p -> 'addons') = 'array' then p -> 'addons' else '[]'::jsonb end) a;

  v_total := stg_carpet_estimate(v_rooms, v_addons);
  if v_total = 0 then
    raise exception 'Choose at least one room or add-on.' using errcode = '22023';
  end if;

  insert into stg_services (house_id, account_id, rooms, addons, estimate_cents, preferred_on, note)
  values (v_house.id, v_me, v_rooms, v_addons, v_total,
          stg_txt(p, 'preferred_on')::date, left(stg_txt(p, 'note'), 500))
  returning * into v;
  return to_jsonb(v);
end;
$$;

-- ---------------------------------------------------------------- reading
create or replace function stg_services_list()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid;
begin
  if is_staff() then
    return coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at desc) from stg_services s), '[]'::jsonb);
  end if;
  v_me := stg_require_account();
  return coalesce((
    select jsonb_agg(to_jsonb(s) order by s.created_at desc)
      from stg_services s
     where s.house_id in (select id from stg_houses where account_id = v_me)), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- status
create or replace function stg_set_service(p_id bigint, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid;
  v    stg_services;
begin
  if p_status not in ('new', 'scheduled', 'done', 'cancelled') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  select * into v from stg_services where id = p_id for update;
  if v.id is null then
    raise exception 'That request no longer exists.' using errcode = 'P0002';
  end if;

  if not is_staff() then
    v_me := stg_require_account();
    if not exists (select 1 from stg_houses where id = v.house_id and account_id = v_me) then
      raise exception 'That is not one of your requests.' using errcode = '42501';
    end if;
    if p_status <> 'cancelled' or v.status <> 'new' then
      raise exception 'Only a request that has not been scheduled yet can be cancelled here.' using errcode = '42501';
    end if;
  end if;

  update stg_services set status = p_status where id = p_id;
end;
$$;

-- ---------------------------------------------------------------- who may call what
revoke execute on function stg_carpet_estimate(integer, text[]) from public;
revoke execute on function stg_service_request(jsonb)           from public;
revoke execute on function stg_services_list()                  from public;
revoke execute on function stg_set_service(bigint, text)        from public;

grant execute on function stg_service_request(jsonb)    to authenticated;
grant execute on function stg_services_list()           to authenticated;
grant execute on function stg_set_service(bigint, text) to authenticated;

do $$
begin
  if has_table_privilege('anon', 'stg_services', 'select')
     or has_table_privilege('authenticated', 'stg_services', 'select') then
    raise exception 'stg_services is readable from the browser';
  end if;
  if has_function_privilege('anon', 'stg_service_request(jsonb)', 'execute')
     or has_function_privilege('anon', 'stg_services_list()', 'execute')
     or has_function_privilege('anon', 'stg_set_service(bigint, text)', 'execute') then
    raise exception 'a service function is executable without signing in';
  end if;
  raise notice 'services verified: table closed, every door needs a session';
end $$;

-- ======================================================================
-- 0004_move_tote.sql
-- ======================================================================

-- Hughes Living Staging — a second service: Hughes Move & Tote Co.
--
-- Beside carpet cleaning (0003), a signed-in customer can ask Hughes Move & Tote
-- for reusable totes, or for a truck and crew with totes, at one of their own
-- houses: to clear a house out before it is staged, or to move once it sells.
-- Like the cleaning, it is a request to the Hughes Living office: no booking,
-- no payment.
--
-- The estimate is priced HERE from the rates on Move & Tote's own site. The
-- page sends what was chosen, never a price. A move is billed by the hour, so
-- its estimate is only as good as the hours asked for.
--
-- Needs 0001, 0002 and 0003. Safe to run twice.

alter table stg_services add column if not exists details jsonb;   -- what was chosen, for a move

alter table stg_services drop constraint if exists stg_services_service_check;
alter table stg_services add constraint stg_services_service_check
  check (service in ('carpet', 'move'));

-- ---------------------------------------------------------------- the price
-- Must match RATES in hughes-move-tote/index.html and services.move in this
-- site's config.js. test/run-tests.mjs compares them.
-- Returns what was chosen, tidied, with estimate_cents added.
create or replace function stg_move_estimate(p jsonb)
returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_mode   text    := case when p ->> 'mode' = 'move' then 'move' else 'totes' end;
  v_totes  integer := coalesce(stg_int(p, 'totes'), 0);
  v_weeks  integer := coalesce(stg_int(p, 'weeks'), 1);
  v_truck  text    := p ->> 'truck';
  v_movers integer := coalesce(stg_int(p, 'movers'), 2);
  v_hours  integer := coalesce(stg_int(p, 'hours'), 2);
  v_rate   integer;
  v_total  integer;
begin
  if v_totes < (case when v_mode = 'move' then 0 else 1 end) or v_totes > 200 then
    raise exception 'Totes must be between % and 200.', (case when v_mode = 'move' then 0 else 1 end) using errcode = '22023';
  end if;
  if v_weeks < 1 or v_weeks > 12 then
    raise exception 'Weeks must be between 1 and 12.' using errcode = '22023';
  end if;

  if v_mode = 'totes' then
    -- rental only: the per-tote rate steps down as the count rises, with an order minimum
    v_rate  := case when v_totes >= 40 then 225 when v_totes >= 20 then 275 else 350 end;
    v_total := greatest(v_totes * v_rate * v_weeks, 9900);
    return jsonb_build_object('mode', v_mode, 'totes', v_totes, 'weeks', v_weeks, 'estimate_cents', v_total);
  end if;

  v_rate := case v_truck when '16ft' then 10900 when '26ft' then 12900 end;   -- per hour, with 2 movers
  if v_rate is null then
    raise exception 'Choose a 16 ft or a 26 ft truck.' using errcode = '22023';
  end if;
  if v_movers < 2 or v_movers > 4 then
    raise exception 'Movers must be between 2 and 4.' using errcode = '22023';
  end if;
  if v_hours < 2 or v_hours > 12 then
    raise exception 'Hours must be between 2 and 12.' using errcode = '22023';
  end if;
  v_total := (v_rate + (v_movers - 2) * 4500) * v_hours    -- crew, by the hour
           + 9500                                          -- trip fee
           + v_totes * 150 * v_weeks;                      -- totes at the bundled rate
  return jsonb_build_object('mode', v_mode, 'totes', v_totes, 'weeks', v_weeks, 'truck', v_truck,
                            'movers', v_movers, 'hours', v_hours, 'estimate_cents', v_total);
end;
$$;

-- ---------------------------------------------------------------- asking
-- Replaces 0003's version: the same door now takes either service.
create or replace function stg_service_request(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      uuid;
  v_house   stg_houses;
  v_service text := coalesce(stg_txt(p, 'service'), 'carpet');
  v_rooms   integer := 0;
  v_addons  text[] := '{}';
  v_details jsonb;
  v_total   integer;
  v         stg_services;
begin
  if v_service not in ('carpet', 'move') then
    raise exception 'Unknown service.' using errcode = '22023';
  end if;

  select * into v_house from stg_houses where id = stg_int(p, 'house_id');
  if is_staff() then
    v_me := v_house.account_id;
  else
    v_me := stg_require_account();
    if v_house.id is not null and v_house.account_id is distinct from v_me then
      v_house := null;                       -- someone else's house reads the same as no house
    end if;
  end if;
  if v_house.id is null then
    raise exception 'That is not one of your houses.' using errcode = '42501';
  end if;

  if v_service = 'move' then
    v_details := stg_move_estimate(p);
    v_total   := (v_details ->> 'estimate_cents')::integer;
    v_details := v_details - 'estimate_cents';
  else
    v_rooms := coalesce(stg_int(p, 'rooms'), 0);
    select coalesce(array_agg(distinct a order by a), '{}') into v_addons
      from jsonb_array_elements_text(
             case when jsonb_typeof(p -> 'addons') = 'array' then p -> 'addons' else '[]'::jsonb end) a;
    v_total := stg_carpet_estimate(v_rooms, v_addons);
    if v_total = 0 then
      raise exception 'Choose at least one room or add-on.' using errcode = '22023';
    end if;
  end if;

  insert into stg_services (house_id, account_id, service, rooms, addons, details, estimate_cents, preferred_on, note)
  values (v_house.id, v_me, v_service, v_rooms, v_addons, v_details, v_total,
          stg_txt(p, 'preferred_on')::date, left(stg_txt(p, 'note'), 500))
  returning * into v;
  return to_jsonb(v);
end;
$$;

revoke execute on function stg_move_estimate(jsonb)   from public;
revoke execute on function stg_service_request(jsonb) from public;
grant  execute on function stg_service_request(jsonb) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'stg_service_request(jsonb)', 'execute')
     or has_function_privilege('anon', 'stg_move_estimate(jsonb)', 'execute') then
    raise exception 'a service function is executable without signing in';
  end if;
  raise notice 'move & tote verified: the request door still needs a session';
end $$;

-- ======================================================================
-- 0005_scans_payments.sql
-- ======================================================================

-- Hughes Living Staging — QR page opens, and a payment link on an order
--
-- 1. Scans. How many times a house's buyer page was opened, kept as one
--    number per house per day. Nothing about the visitor is stored: no IP, no
--    device, no cookie. The page calls stg_scan once per browser session, so
--    a reload is not a second scan. It is a count of opens, not of people.
--
-- 2. Payment link. Hughes Living still takes the payment itself (a Shopify
--    draft order, a card processor's link). The office can now paste that
--    link on the buyer's order, send it, and mark the order paid. No card
--    details ever touch this database.
--
-- Needs 0001 and 0002. Does NOT need 0003 or 0004. Safe to run twice.

-- ---------------------------------------------------------------- scans
create table if not exists stg_scans (
  house_id bigint  not null references stg_houses (id) on delete cascade,
  day      date    not null,
  n        integer not null default 0 check (n >= 0),
  primary key (house_id, day)
);

alter table stg_scans enable row level security;
revoke all on stg_scans from anon, authenticated;

-- The third public door, beside stg_house_public and stg_request. It answers
-- nothing, so a wrong or closed code looks the same as a right one.
create or replace function stg_scan(p_code text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_house bigint;
begin
  select id into v_house from stg_houses
   where code = upper(btrim(coalesce(p_code, ''))) and status = 'staged';
  if v_house is null then
    return;
  end if;
  insert into stg_scans (house_id, day, n)
  values (v_house, (now() at time zone 'America/Chicago')::date, 1)
  on conflict (house_id, day) do update set n = stg_scans.n + 1;
end;
$$;

-- Staff see every house's counts; a customer sees their own houses'.
create or replace function stg_scans_list()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid;
begin
  if is_staff() then
    return coalesce((select jsonb_agg(to_jsonb(s) order by s.day) from stg_scans s), '[]'::jsonb);
  end if;
  v_me := stg_require_account();
  return coalesce((
    select jsonb_agg(to_jsonb(s) order by s.day)
      from stg_scans s
     where s.house_id in (select id from stg_houses where account_id = v_me)), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- payment link
alter table stg_requests add column if not exists pay_url text;
alter table stg_requests add column if not exists paid_at timestamptz;

-- Staff only. The link must be https, so nothing odd is sent to a buyer.
-- Customers never receive pay_url: stg_portal builds its rows by hand.
create or replace function stg_set_request_pay(p_id bigint, p_url text, p_paid boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
  perform stg_require_staff();
  if v_url is not null and v_url !~* '^https://[^[:space:]]+$' then
    raise exception 'A payment link starts with https://' using errcode = '22023';
  end if;
  update stg_requests set
    pay_url = v_url,
    paid_at = case when coalesce(p_paid, false) then coalesce(paid_at, now()) else null end
  where id = p_id;
  if not found then
    raise exception 'That request no longer exists.' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------- who may call what
revoke execute on function stg_scan(text)                           from public;
revoke execute on function stg_scans_list()                         from public;
revoke execute on function stg_set_request_pay(bigint, text, boolean) from public;

grant execute on function stg_scan(text)                             to anon, authenticated;
grant execute on function stg_scans_list()                           to authenticated;
grant execute on function stg_set_request_pay(bigint, text, boolean) to authenticated;

do $$
begin
  if has_table_privilege('anon', 'stg_scans', 'select')
     or has_table_privilege('authenticated', 'stg_scans', 'select') then
    raise exception 'stg_scans is readable from the browser';
  end if;
  if has_function_privilege('anon', 'stg_scans_list()', 'execute')
     or has_function_privilege('anon', 'stg_set_request_pay(bigint, text, boolean)', 'execute') then
    raise exception 'a scans or payment function is executable without signing in';
  end if;
  raise notice 'scans and payment links verified';
end $$;
