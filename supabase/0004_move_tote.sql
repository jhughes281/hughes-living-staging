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
