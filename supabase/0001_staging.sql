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
