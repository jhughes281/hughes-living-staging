-- Hughes Living Staging — the staging agreement
--
-- A customer account (homeowner, designer, realtor) must accept the staging
-- agreement before it can do anything: add a house, place furniture, ask for a
-- service. This records WHO accepted, WHICH version, and WHEN, and keeps every
-- acceptance, so a later version does not overwrite the proof of an earlier one.
--
-- The wording itself lives on the site (terms.html) and its version string in
-- config.js. When the wording changes, the version changes, and the page asks
-- everyone to accept again. The database only insists that SOME version has
-- been accepted; which one is current is the page's business.
--
-- Staff are not customers and accept nothing.
--
-- Needs 0001 and 0002. Safe to run twice.

alter table stg_accounts add column if not exists agreed_version text;
alter table stg_accounts add column if not exists agreed_at timestamptz;

-- Every acceptance, oldest first. Never updated, never deleted except with the account.
create table if not exists stg_agreements (
  id         bigint generated always as identity primary key,
  account_id uuid not null references stg_accounts (id) on delete cascade,
  version    text not null check (length(btrim(version)) between 1 and 40),
  agreed_at  timestamptz not null default now()
);

create index if not exists stg_agreements_account on stg_agreements (account_id);

alter table stg_agreements enable row level security;
revoke all on stg_agreements from anon, authenticated;

-- ---------------------------------------------------------------- who am I
-- As in 0002, plus what this account has agreed to. A null agreed_version
-- means "not yet": the page shows the agreement before anything else.
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
                            'phone', a.phone, 'email', a.email,
                            'agreed_version', a.agreed_version, 'agreed_at', a.agreed_at);
end;
$$;

-- ---------------------------------------------------------------- accepting
create or replace function stg_accept_terms(p_version text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_version text := left(btrim(coalesce(p_version, '')), 40);
begin
  if auth.uid() is null or not exists (select 1 from stg_accounts where id = auth.uid()) then
    raise exception 'no staging account' using errcode = '42501';
  end if;
  if v_version = '' then
    raise exception 'Which version of the agreement?' using errcode = '22023';
  end if;

  insert into stg_agreements (account_id, version) values (auth.uid(), v_version);
  update stg_accounts set agreed_version = v_version, agreed_at = now() where id = auth.uid();
  return stg_my_account();
end;
$$;

-- ---------------------------------------------------------------- the gate
-- Every customer door (stg_portal, stg_portal_save_house, stg_place, the
-- service and scan-count functions) starts by calling this, so one check here
-- closes all of them to an account that has not accepted.
create or replace function stg_require_account()
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  a stg_accounts;
begin
  select * into a from stg_accounts where id = auth.uid();
  if a.id is null then
    raise exception 'no staging account' using errcode = '42501';
  end if;
  if a.agreed_version is null then
    raise exception 'agreement not accepted' using errcode = '42501';
  end if;
  return a.id;
end;
$$;

-- ---------------------------------------------------------------- who may call what
revoke execute on function stg_my_account()       from public;
revoke execute on function stg_accept_terms(text) from public;
revoke execute on function stg_require_account()  from public;

grant execute on function stg_my_account()       to authenticated;
grant execute on function stg_accept_terms(text) to authenticated;

do $$
begin
  if has_table_privilege('anon', 'stg_agreements', 'select')
     or has_table_privilege('authenticated', 'stg_agreements', 'select') then
    raise exception 'stg_agreements is readable from the browser';
  end if;
  if has_function_privilege('anon', 'stg_accept_terms(text)', 'execute') then
    raise exception 'the agreement can be accepted without signing in';
  end if;
  raise notice 'agreement verified: acceptances recorded, customer doors closed until one exists';
end $$;
