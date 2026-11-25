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
