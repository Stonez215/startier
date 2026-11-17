// StarTier daily money job (run once a day by pg_cron; see 11-cron.sql).
// 1. After each month ends (+2 days), shares that month's All-Access money among artists by streams.
// 2. Sends artists any money still waiting (All-Access shares once they reach the minimum,
//    sales and tips once their payouts are set up).
// 3. Ends the 7-day new-artist payout hold after the hold period.
// Deploy as "allaccess-payout" with "Enforce JWT verification" OFF.
// Secrets: STRIPE_SECRET_KEY. The daily call carries a secret kept in the database vault ('cron_secret').
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function stripe(method: string, path: string, form?: Record<string, string>, idem?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${STRIPE_KEY}`, "Stripe-Version": "2024-06-20" };
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch("https://api.stripe.com/v1" + path, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(d?.error?.message || "stripe " + res.status) as Error & { code?: string }; err.code = d?.error?.code; throw err; }
  return d;
}

const setting = async (key: string, dflt: number) => {
  const { data } = await admin.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data ? Number(data.value) : dflt;
};
const ym = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

async function computeMonths(log: string[]) {
  const { data: first } = await admin.from("plan_payments").select("paid_at").eq("kind", "pass").order("paid_at").limit(1);
  if (!first?.length) return;
  const now = new Date();
  const d = new Date(first[0].paid_at);
  let cur = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  while (true) {
    const end = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    if (now.getTime() < end.getTime() + 2 * 86400000) break; // month not finished (+2 days for late renewals)
    const { data, error } = await admin.rpc("allaccess_compute", { p_period: ym(cur) });
    log.push(`compute ${ym(cur)}: ${error ? error.message : JSON.stringify(data)}`);
    cur = end;
  }
}

async function payPending(log: string[]) {
  const min = await setting("min_transfer_cents", 500);
  const { data: rows } = await admin.from("artist_earnings").select("id,artist_id,source,amount_cents,charge_id").eq("status", "pending").order("id").limit(2000);
  const byArtist = new Map<string, any[]>();
  for (const r of rows || []) if (r.artist_id) byArtist.set(r.artist_id, [...(byArtist.get(r.artist_id) || []), r]);
  for (const [artistId, list] of byArtist) {
    const { data: pa } = await admin.from("pay_accounts").select("stripe_account,payouts_ready").eq("user_id", artistId).maybeSingle();
    const { data: p } = await admin.from("profiles").select("banned").eq("id", artistId).maybeSingle();
    if (!pa?.stripe_account || !pa.payouts_ready || p?.banned) continue;
    // Sales and tips go one by one, tied to their charge.
    for (const e of list.filter((x) => x.source !== "allaccess" && x.charge_id)) {
      try {
        const tr = await stripe("POST", "/transfers", { amount: String(e.amount_cents), currency: "usd", destination: pa.stripe_account, source_transaction: e.charge_id, "metadata[earning_id]": String(e.id) }, `earning-${e.id}`);
        await admin.from("artist_earnings").update({ status: "paid", transfer_id: tr.id, paid_at: new Date().toISOString() }).eq("id", e.id);
      } catch (err) { log.push(`sale ${e.id}: ${(err as Error).message}`); }
    }
    // All-Access shares go together once they reach the minimum.
    const aa = list.filter((x) => x.source === "allaccess");
    const total = aa.reduce((t, x) => t + x.amount_cents, 0);
    if (!aa.length || total < min) continue;
    try {
      const tr = await stripe("POST", "/transfers", { amount: String(total), currency: "usd", destination: pa.stripe_account, transfer_group: "allaccess", "metadata[artist_id]": artistId, "metadata[earning_ids]": aa.map((x) => x.id).join(",").slice(0, 490) }, `aa-${artistId}-${aa[aa.length - 1].id}`);
      await admin.from("artist_earnings").update({ status: "paid", transfer_id: tr.id, paid_at: new Date().toISOString() }).in("id", aa.map((x) => x.id));
      log.push(`allaccess ${artistId}: ${total}`);
    } catch (err) {
      log.push(`allaccess ${artistId}: ${(err as Error).message}`);
      if ((err as any).code === "balance_insufficient") break; // StarTier's balance isn't available yet; try tomorrow
    }
  }
}

async function relaxHolds(log: string[]) {
  const days = await setting("new_artist_hold_days", 60);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const { data } = await admin.from("pay_accounts").select("user_id,stripe_account").eq("hold_relaxed", false).not("stripe_account", "is", null).lt("connected_at", cutoff).limit(200);
  for (const pa of data || []) {
    try {
      await stripe("POST", `/accounts/${pa.stripe_account}`, { "settings[payouts][schedule][interval]": "monthly", "settings[payouts][schedule][monthly_anchor]": "1", "settings[payouts][schedule][delay_days]": "minimum" });
      await admin.from("pay_accounts").update({ hold_relaxed: true }).eq("user_id", pa.user_id);
    } catch (err) { log.push(`hold ${pa.user_id}: ${(err as Error).message}`); }
  }
}

Deno.serve(async (req) => {
  const { data: ok } = await admin.rpc("st_cron_secret_ok", { p_secret: req.headers.get("x-cron-secret") || "" });
  if (ok !== true) return new Response("no", { status: 401 });
  if (!STRIPE_KEY) return new Response("payments are not switched on", { status: 200 });
  const log: string[] = [];
  try {
    await computeMonths(log);
    await payPending(log);
    await relaxHolds(log);
  } catch (e) { log.push("error: " + (e as Error).message); }
  console.log(log.join("\n"));
  return new Response(JSON.stringify({ log }), { headers: { "Content-Type": "application/json" } });
});
