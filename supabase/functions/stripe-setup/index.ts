// StarTier one-time setup: connects Stripe to the stripe-webhook function and keeps the signing
// secret in the database vault, so nobody has to copy secrets by hand. Safe to run again.
// Called from the database (same secret as the daily money job). Deploy with JWT verification OFF.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const URL_ = `${Deno.env.get("SUPABASE_URL")}/functions/v1/stripe-webhook`;
const EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "customer.subscription.created",
  "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "charge.refunded", "charge.dispute.created"];

async function stripe(method: string, path: string, form?: Record<string, string>) {
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method, headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d?.error?.message || "stripe " + res.status);
  return d;
}

Deno.serve(async (req) => {
  const { data: ok } = await admin.rpc("st_cron_secret_ok", { p_secret: req.headers.get("x-cron-secret") || "" });
  if (ok !== true) return new Response("no", { status: 401 });
  if (!STRIPE_KEY) return Response.json({ error: "STRIPE_SECRET_KEY is missing" });
  try {
    const { data: have } = await admin.rpc("st_webhook_secret");
    const list = await stripe("GET", "/webhook_endpoints?limit=100");
    const mine = (list.data || []).filter((w: any) => w.url === URL_);
    if (mine.length && have) {
      // Already connected: make sure it listens for every event we need.
      const form: Record<string, string> = {}; EVENTS.forEach((e, i) => form[`enabled_events[${i}]`] = e);
      await stripe("POST", `/webhook_endpoints/${mine[0].id}`, { ...form, disabled: "false" });
      return Response.json({ status: "already connected", id: mine[0].id, livemode: mine[0].livemode });
    }
    // Stripe only shows a signing secret when the endpoint is created, so replace any old one.
    for (const w of mine) await stripe("DELETE", `/webhook_endpoints/${w.id}`);
    const form: Record<string, string> = { url: URL_, api_version: "2024-06-20", description: "StarTier payments (Supabase stripe-webhook)" };
    EVENTS.forEach((e, i) => form[`enabled_events[${i}]`] = e);
    const w = await stripe("POST", "/webhook_endpoints", form);
    const { error } = await admin.rpc("st_save_webhook_secret", { p_secret: w.secret });
    if (error) throw new Error(error.message);
    return Response.json({ status: "connected", id: w.id, livemode: w.livemode, events: EVENTS.length });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
