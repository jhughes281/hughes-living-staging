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
