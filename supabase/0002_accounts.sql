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
