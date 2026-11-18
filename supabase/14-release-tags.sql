-- Several genres/categories per release (songs, videos, art), including names artists type themselves.
-- genre/category keep the main one; tags holds all of them (up to 5, 30 chars each).
create or replace function public.st_tags_ok(t text[]) returns boolean
language sql immutable set search_path = '' as $$
  select t is null or (cardinality(t) <= 5 and not exists (
    select 1 from unnest(t) x where x is null or char_length(x) < 1 or char_length(x) > 40))
$$;
alter table public.releases add column if not exists tags text[] not null default '{}';
alter table public.releases drop constraint if exists releases_tags_ok;
alter table public.releases add constraint releases_tags_ok check (public.st_tags_ok(tags));
grant select (tags) on public.releases to anon, authenticated;
grant insert (tags), update (tags) on public.releases to authenticated;
-- the word filter also checks typed-in genre names
drop trigger if exists st_text_guard on public.releases;
create trigger st_text_guard before insert or update on public.releases
  for each row execute function public.st_text_guard('title', 'description', 'tags');
-- existing releases: copy their one genre/category into tags
update public.releases set tags = array[coalesce(genre, category)] where tags = '{}' and coalesce(genre, category) is not null;
