-- StarTier database update 11: run the daily money job (allaccess-payout) every day at 9:17 AM New York time.
create extension if not exists pg_cron;
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret', 'Secret for the daily money job');
  end if;
end $$;
create or replace function public.st_cron_secret_ok(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(length(p_secret) > 20 and p_secret = (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'), false)
$$;
revoke all on function public.st_cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.st_cron_secret_ok(text) to service_role;
select cron.unschedule('startier-daily-money') where exists (select 1 from cron.job where jobname = 'startier-daily-money');
select cron.schedule('startier-daily-money', '17 14 * * *', $$
  select net.http_post(
    url := 'https://wdrdfwfbnzvqodnmdvnv.supabase.co/functions/v1/allaccess-payout',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb)
$$);
