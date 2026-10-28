-- StarTier database update 9 (Oct 27 2026): payments.
-- All-Access, Star Pro, Supernova, Galaxies, buying, tips and artist payouts through Stripe.
-- Safe to run more than once.

-- 1) Stripe ids live in their own table (not on the public profile)
create table if not exists public.pay_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  stripe_customer text,
  stripe_account text,
  payouts_ready boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.pay_accounts enable row level security;
drop policy if exists "See your own payment account" on public.pay_accounts;
create policy "See your own payment account" on public.pay_accounts for select to authenticated using (user_id = auth.uid());

-- 2) Monthly plans and Galaxy memberships (one row per Stripe subscription)
create table if not exists public.subscriptions (
  id text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('pass','pro','supernova','galaxy')),
  artist_id uuid references public.profiles(id) on delete cascade,
  status text not null,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_user on public.subscriptions (user_id, kind, status);
alter table public.subscriptions enable row level security;
drop policy if exists "See your own plans" on public.subscriptions;
create policy "See your own plans" on public.subscriptions for select to authenticated using (user_id = auth.uid());

-- 3) Purchases and tips
create table if not exists public.purchases (
  id bigint generated always as identity primary key,
  session_id text unique not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  artist_id uuid references public.profiles(id) on delete set null,
  kind text not null check (kind in ('buy','tip')),
  release_id bigint references public.releases(id) on delete set null,
  collection_id bigint references public.collections(id) on delete set null,
  amount_cents int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists purchases_user on public.purchases (user_id, kind);
create index if not exists purchases_artist on public.purchases (artist_id, created_at);
alter table public.purchases enable row level security;
drop policy if exists "See what you bought and what you sold" on public.purchases;
create policy "See what you bought and what you sold" on public.purchases for select to authenticated
  using (user_id = auth.uid() or artist_id = auth.uid());

-- 4) Did this member buy this release (on its own, or inside an album / series / collection)?
create or replace function public.st_owns(p_release bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.purchases pu
    where pu.user_id = auth.uid() and pu.kind = 'buy'
      and (pu.release_id = p_release
           or pu.collection_id in (select ci.collection_id from public.collection_items ci where ci.release_id = p_release)))
$$;

-- 5) Buyers get the full version: wrap the existing full_access() rule.
--    The old rule is kept as full_access_base(); the new one adds "or you bought it".
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'full_access_base') then
    alter function public.full_access(bigint) rename to full_access_base;
  end if;
end $$;
create or replace function public.full_access(p_release bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.full_access_base(p_release), false) or public.st_owns(p_release)
$$;
-- The two file rules below point at full_access(); re-make them so they use the new version.
drop policy if exists "Full songs play if free, or for the artist" on storage.objects;
create policy "Full songs play if free, or for the artist" on storage.objects for select
  using (bucket_id = 'songs' and ((storage.foldername(name))[1] = auth.uid()::text or exists (
    select 1 from public.releases r
    where r.audio_path = objects.name and split_part(objects.name, '/', 1) = r.artist_id::text and public.full_access(r.id))));
drop policy if exists "Free downloads for everyone" on storage.objects;
create policy "Free downloads for everyone" on storage.objects for select
  using (bucket_id = 'downloads' and ((storage.foldername(name))[1] = auth.uid()::text or exists (
    select 1 from public.releases r
    where r.file_path = objects.name and split_part(objects.name, '/', 1) = r.artist_id::text and public.full_access(r.id))));
grant execute on function public.st_owns(bigint) to anon, authenticated;
grant execute on function public.full_access(bigint) to anon, authenticated;

-- 6) Galaxy memberships from payments (only the payment system can call these)
create or replace function public.st_galaxy_paid(p_user uuid, p_artist uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.galaxy_members (artist_id, user_id, status) values (p_artist, p_user, 'active')
  on conflict (artist_id, user_id) do update set status = case when public.galaxy_members.status = 'comped' then 'comped' else 'active' end;
end $$;
create or replace function public.st_galaxy_ended(p_user uuid, p_artist uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.galaxy_members where artist_id = p_artist and user_id = p_user and status = 'active';
end $$;
revoke all on function public.st_galaxy_paid(uuid, uuid) from public, anon, authenticated;
revoke all on function public.st_galaxy_ended(uuid, uuid) from public, anon, authenticated;
grant execute on function public.st_galaxy_paid(uuid, uuid) to service_role;
grant execute on function public.st_galaxy_ended(uuid, uuid) to service_role;

-- 7) Members can't give themselves Supernova or a free plan from the app
create or replace function public.profile_money_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated','anon') and not coalesce(public.is_admin(), false) then
    if new.is_supernova is distinct from old.is_supernova or new.is_pro is distinct from old.is_pro
       or new.has_pass is distinct from old.has_pass
       or new.comped_by is distinct from old.comped_by or new.comped_at is distinct from old.comped_at then
      raise exception 'You can''t change that' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profile_money_guard on public.profiles;
create trigger profile_money_guard before update on public.profiles
  for each row execute function public.profile_money_guard();

-- 8) What the app shows: my purchases, and my earnings (for artists)
create or replace function public.my_money() returns json
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then return null; end if;
  return json_build_object(
    'owned', (select coalesce(json_agg(distinct x.rid), '[]'::json) from (
                select pu.release_id as rid from public.purchases pu where pu.user_id = me and pu.kind = 'buy' and pu.release_id is not null
                union
                select ci.release_id from public.purchases pu join public.collection_items ci on ci.collection_id = pu.collection_id
                where pu.user_id = me and pu.kind = 'buy') x),
    'owned_collections', (select coalesce(json_agg(distinct pu.collection_id), '[]'::json) from public.purchases pu where pu.user_id = me and pu.kind = 'buy' and pu.collection_id is not null),
    'payouts_ready', coalesce((select pa.payouts_ready from public.pay_accounts pa where pa.user_id = me), false),
    'payouts_started', exists (select 1 from public.pay_accounts pa where pa.user_id = me and pa.stripe_account is not null),
    'has_billing', exists (select 1 from public.pay_accounts pa where pa.user_id = me and pa.stripe_customer is not null),
    'plans', (select coalesce(json_agg(json_build_object('kind', s.kind, 'artist_id', s.artist_id, 'status', s.status, 'renews', s.current_period_end)), '[]'::json)
              from public.subscriptions s where s.user_id = me and s.status in ('active','trialing','past_due')),
    'sales_30', (select coalesce(sum(pu.amount_cents), 0) from public.purchases pu where pu.artist_id = me and pu.created_at > now() - interval '30 days'),
    'sales_count_30', (select count(*) from public.purchases pu where pu.artist_id = me and pu.created_at > now() - interval '30 days'),
    'galaxy_paid', (select count(*) from public.subscriptions s where s.artist_id = me and s.kind = 'galaxy' and s.status in ('active','trialing','past_due'))
  );
end $$;
grant execute on function public.my_money() to authenticated;

-- 9) Artists who can be paid (so the app knows when to show Buy, Tip and Join)
create or replace function public.payable_stars() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select pa.user_id from public.pay_accounts pa join public.profiles p on p.id = pa.user_id
  where pa.payouts_ready and p.role = 'star' and not p.banned
$$;
grant execute on function public.payable_stars() to anon, authenticated;

select 'StarTier update 9 (payments) installed' as result;
