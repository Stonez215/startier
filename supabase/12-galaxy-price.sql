-- StarTier database update 12 (Nov 17 2026): Galaxies are $1.75 a month ($0.99 to the artist).
-- 150 stays allowed only while older copies of the app are still open; switch to (price_cents = 175) later.
alter table public.galaxies drop constraint if exists galaxies_price_cents_check;
alter table public.galaxies add constraint galaxies_price_cents_check check (price_cents in (150, 175));
alter table public.galaxies alter column price_cents set default 175;
