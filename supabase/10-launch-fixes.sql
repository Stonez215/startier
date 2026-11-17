-- StarTier database update 10 (Nov 17 2026): launch fixes.
-- Video previews, All-Access stream share, artist earnings ledger, refunds,
-- account deletion support, blocked-words filter. Safe to run more than once.

-- 1) Video previews: Stars upload their own short preview clip.
alter table public.releases add column if not exists preview_bunny_id text;
grant select (preview_bunny_id) on public.releases to anon, authenticated;

-- Non-buyers get ONLY the preview clip, never the full video.
create or replace function public.video_preview(p_release_id bigint) returns text
language sql stable security definer set search_path = '' as $$
  select r.preview_bunny_id from public.releases r
  where r.id = p_release_id and r.kind = 'video' and r.status = 'live' and r.preview_bunny_id is not null
$$;

-- The artist attaches (or removes) a preview clip on their own video.
create or replace function public.set_video_preview(p_release bigint, p_bunny text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.releases r where r.id = p_release and r.artist_id = auth.uid() and r.kind = 'video') then
    raise exception 'Only the artist can change this preview'; end if;
  if p_bunny is not null and p_bunny !~ '^[0-9a-f-]{36}$' then raise exception 'Bad video'; end if;
  if p_bunny is not null and exists (select 1 from public.releases r where r.bunny_video_id = p_bunny) then
    raise exception 'Use a separate short clip for the preview'; end if;
  update public.releases set preview_bunny_id = p_bunny where id = p_release;
end $$;
revoke all on function public.set_video_preview(bigint, text) from public, anon;
grant execute on function public.set_video_preview(bigint, text) to authenticated;

-- 2) Keep sales records when a buyer deletes their account (tax and refund records).
alter table public.purchases alter column user_id drop not null;
alter table public.purchases drop constraint if exists purchases_user_id_fkey;
alter table public.purchases add constraint purchases_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete set null;
alter table public.purchases add column if not exists charge_id text;
create index if not exists purchases_charge on public.purchases (charge_id);

-- 3) Settings StarTier can change without new code.
create table if not exists public.app_settings (key text primary key, value numeric not null, note text);
alter table public.app_settings enable row level security;
insert into public.app_settings (key, value, note) values
  ('allaccess_artist_share', 0.85, 'Share of All-Access money (after card fees) paid to artists by streams'),
  ('min_transfer_cents', 500, 'All-Access earnings wait until an artist has at least this much'),
  ('new_artist_hold_days', 60, 'Days a new artist keeps the extra 7-day payout hold')
on conflict (key) do nothing;

-- 4) Plan payments (All-Access, Star Pro, Supernova, Galaxies), recorded by the Stripe webhook.
create table if not exists public.plan_payments (
  id text primary key,                -- Stripe invoice id
  user_id uuid references public.profiles(id) on delete set null,
  kind text not null,
  subscription_id text,
  amount_cents int not null,
  fee_cents int not null default 0,
  paid_at timestamptz not null default now()
);
create index if not exists plan_payments_kind on public.plan_payments (kind, paid_at);
alter table public.plan_payments enable row level security;

-- 5) Artist earnings ledger: every cent owed to a Star, from sales, tips or All-Access.
create table if not exists public.artist_earnings (
  id bigint generated always as identity primary key,
  artist_id uuid references public.profiles(id) on delete set null,
  source text not null check (source in ('sale','tip','allaccess')),
  period text,                         -- 'YYYY-MM' for All-Access
  release_id bigint references public.releases(id) on delete set null,
  session_id text,                     -- Stripe checkout session for sales and tips
  charge_id text,
  amount_cents int not null check (amount_cents >= 0),
  status text not null default 'pending' check (status in ('pending','paid','reversed','cancelled')),
  transfer_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create unique index if not exists artist_earnings_sale on public.artist_earnings (session_id, artist_id);
create unique index if not exists artist_earnings_aa on public.artist_earnings (period, artist_id, release_id) where source = 'allaccess';
create index if not exists artist_earnings_pending on public.artist_earnings (status, artist_id);
create index if not exists artist_earnings_charge on public.artist_earnings (charge_id);
alter table public.artist_earnings enable row level security;
drop policy if exists "See your own earnings" on public.artist_earnings;
create policy "See your own earnings" on public.artist_earnings for select to authenticated using (artist_id = auth.uid());

create table if not exists public.allaccess_periods (
  period text primary key, pool_cents int not null, artist_pool_cents int not null,
  streams int not null, computed_at timestamptz not null default now()
);
alter table public.allaccess_periods enable row level security;

-- When an artist connected payouts (for the new-artist hold).
alter table public.pay_accounts add column if not exists connected_at timestamptz;
alter table public.pay_accounts add column if not exists hold_relaxed boolean not null default false;

-- 6) Split a release's artist money by its active split (shares are basis points of the owner's part).
create or replace function public.st_split_recipients(p_release bigint, p_owner uuid, p_cents int)
returns table (artist_id uuid, cents int)
language plpgsql stable security definer set search_path = '' as $$
declare sh jsonb; given int := 0; e record; c int;
begin
  select s.shares into sh from public.release_splits s where s.release_id = p_release and s.status = 'active';
  if sh is not null and p_release is not null then
    for e in select key, value from jsonb_each(sh) loop
      c := floor(p_cents * (e.value)::int / 10000.0);
      if c > 0 then artist_id := e.key::uuid; cents := c; given := given + c; return next; end if;
    end loop;
  end if;
  artist_id := p_owner; cents := p_cents - given; return next;
end $$;
revoke all on function public.st_split_recipients(bigint, uuid, int) from public, anon, authenticated;
grant execute on function public.st_split_recipients(bigint, uuid, int) to service_role;

-- 7) All-Access stream share for one month. Each member counts once per song or video per day.
create or replace function public.allaccess_compute(p_period text) returns json
language plpgsql security definer set search_path = '' as $$
declare p_start timestamptz := (p_period || '-01')::date::timestamptz;
        p_end timestamptz := ((p_period || '-01')::date + interval '1 month')::timestamptz;
        share numeric := coalesce((select value from public.app_settings where key = 'allaccess_artist_share'), 0.85);
        pool int; apool int; total int; r record; rc record; amt int;
begin
  if exists (select 1 from public.allaccess_periods where period = p_period) then return json_build_object('done', true); end if;
  if now() < p_end + interval '2 days' then raise exception 'That month is not finished yet'; end if;
  select coalesce(sum(amount_cents - fee_cents), 0) into pool from public.plan_payments
    where kind = 'pass' and paid_at >= p_start and paid_at < p_end;
  apool := floor(pool * share);
  create temp table if not exists aa_plays (release_id bigint, owner uuid, n int) on commit drop;
  delete from aa_plays;
  insert into aa_plays
    select rp.release_id, r.artist_id, count(distinct (rp.user_id, (rp.played_at at time zone 'America/New_York')::date))
    from public.release_plays rp join public.releases r on r.id = rp.release_id
    where rp.played_at >= p_start and rp.played_at < p_end
      and r.kind in ('song', 'video') and coalesce(r.form, 'long') <> 'short'
      and rp.user_id is not null and rp.user_id <> r.artist_id
      and rp.user_id in (select pp.user_id from public.plan_payments pp
                         where pp.kind = 'pass' and pp.paid_at >= p_start - interval '31 days' and pp.paid_at < p_end)
    group by 1, 2;
  select coalesce(sum(n), 0) into total from aa_plays;
  if total > 0 and apool > 0 then
    for r in select * from aa_plays loop
      amt := floor(apool::numeric * r.n / total);
      if amt > 0 then
        for rc in select * from public.st_split_recipients(r.release_id, r.owner, amt) loop
          if rc.cents > 0 then
            insert into public.artist_earnings (artist_id, source, period, release_id, amount_cents)
            values (rc.artist_id, 'allaccess', p_period, r.release_id, rc.cents)
            on conflict (period, artist_id, release_id) where source = 'allaccess' do nothing;
          end if;
        end loop;
      end if;
    end loop;
  end if;
  insert into public.allaccess_periods (period, pool_cents, artist_pool_cents, streams) values (p_period, pool, apool, total);
  return json_build_object('period', p_period, 'pool', pool, 'artist_pool', apool, 'streams', total);
end $$;
revoke all on function public.allaccess_compute(text) from public, anon, authenticated;
grant execute on function public.allaccess_compute(text) to service_role;

-- 8) What the artist sees: money owed and paid (added to my_money()).
create or replace function public.my_earnings() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'pending_cents', coalesce((select sum(amount_cents) from public.artist_earnings where artist_id = auth.uid() and status = 'pending'), 0),
    'paid_cents', coalesce((select sum(amount_cents) from public.artist_earnings where artist_id = auth.uid() and status = 'paid'), 0),
    'allaccess_cents', coalesce((select sum(amount_cents) from public.artist_earnings where artist_id = auth.uid() and source = 'allaccess' and status in ('pending','paid')), 0))
  where auth.uid() is not null
$$;
revoke all on function public.my_earnings() from public, anon;
grant execute on function public.my_earnings() to authenticated;

-- 9) Blocked-words filter for names, bios, posts, comments, messages, titles and Galaxy names.
create or replace function public.st_text_ok(t text) returns boolean
language sql immutable set search_path = '' as $$
  select t is null or lower(t) !~ ('(^|[^a-z])('
    || 'n[i1!]gg(a|er|as|ers|az)|f[a@]gg?(ot|ots|it)|k[i1]ke|sp[i1]c|ch[i1]nk|wetback|tr[a@]nny|c[o0]{2}n|g[o0]{2}k|raghead|towelhead|beaner'
    || '|child ?p[o0]rn|cp links|kill yourself|kys'
    || ')([^a-z]|$)')
$$;
create or replace function public.st_text_guard() returns trigger
language plpgsql set search_path = '' as $$
declare col text; val text;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  foreach col in array tg_argv loop
    execute format('select ($1).%I::text', col) into val using new;
    if not public.st_text_ok(val) then
      raise exception 'That has words StarTier doesn''t allow. Please change it.' using errcode = '22023';
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists st_text_guard on public.posts;
create trigger st_text_guard before insert or update on public.posts for each row execute function public.st_text_guard('body');
drop trigger if exists st_text_guard on public.comments;
create trigger st_text_guard before insert or update on public.comments for each row execute function public.st_text_guard('body');
drop trigger if exists st_text_guard on public.profiles;
create trigger st_text_guard before insert or update on public.profiles for each row execute function public.st_text_guard('display_name', 'bio', 'city');
drop trigger if exists st_text_guard on public.releases;
create trigger st_text_guard before insert or update on public.releases for each row execute function public.st_text_guard('title', 'description');
drop trigger if exists st_text_guard on public.collections;
create trigger st_text_guard before insert or update on public.collections for each row execute function public.st_text_guard('title', 'description');
drop trigger if exists st_text_guard on public.galaxies;
create trigger st_text_guard before insert or update on public.galaxies for each row execute function public.st_text_guard('name', 'perks');

-- send_message runs as the database owner, so check its text directly too.
create or replace function public.st_message_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not public.st_text_ok(new.body) then
    raise exception 'That has words StarTier doesn''t allow. Please change it.' using errcode = '22023'; end if;
  return new;
end $$;
drop trigger if exists st_message_guard on public.messages;
create trigger st_message_guard before insert on public.messages for each row execute function public.st_message_guard();

-- 10) Security advisor fix.
alter function public.galaxy_members_guard() set search_path = '';
