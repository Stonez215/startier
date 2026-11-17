-- StarTier database update 13 (Nov 17 2026): the Stripe webhook signing secret lives in the vault.
-- stripe-setup creates the Stripe webhook and saves the secret here; stripe-webhook reads it.
create or replace function public.st_webhook_secret() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'stripe_webhook_secret'
$$;
revoke all on function public.st_webhook_secret() from public, anon, authenticated;
grant execute on function public.st_webhook_secret() to service_role;

create or replace function public.st_save_webhook_secret(p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  if p_secret !~ '^whsec_' then raise exception 'bad secret'; end if;
  select id into sid from vault.secrets where name = 'stripe_webhook_secret';
  if sid is null then perform vault.create_secret(p_secret, 'stripe_webhook_secret', 'Stripe webhook signing secret');
  else perform vault.update_secret(sid, p_secret); end if;
end $$;
revoke all on function public.st_save_webhook_secret(text) from public, anon, authenticated;
grant execute on function public.st_save_webhook_secret(text) to service_role;
