// StarTier payments: one function the app calls for every money action.
// Deploy in Supabase: Edge Functions > Deploy a new function > Via Editor > name it "stripe-pay" > paste this file.
// Secrets (Edge Functions > Secrets): STRIPE_SECRET_KEY, SITE_URL (https://startier.app)
//
// Actions (POST JSON { action, ... } with the member's login):
//   plan      { plan: 'pass' | 'pro' | 'supernova' }  All-Access, Star Pro, Supernova (monthly)
//   galaxy    { artist_id }                           $1.50/mo Galaxy, the artist is paid through Stripe Connect
//   buy       { release_id } or { collection_id }     one-time purchase, artist paid through Stripe Connect
//   tip       { artist_id, cents }                    one-time tip
//   portal    {}                                      Stripe page to update the card or cancel plans
//   connect   {}                                      artist: set up payouts (or open the payouts dashboard)
//   connect_status {}                                 artist: are payouts on?
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// ---- prices and splits (cents). Change here if prices change. ----
const PLAN = {
  pass:      { cents: 699,  name: "StarTier All-Access", flag: "has_pass" },
  pro:       { cents: 899,  name: "StarTier Star Pro", flag: "is_pro" },
  supernova: { cents: 2499, name: "StarTier Supernova", flag: "is_supernova" },
} as const;
const GALAXY_CENTS = 150;          // fan pays
const GALAXY_ARTIST_CENTS = 80;    // artist gets
const PASS_OFF = 0.20;             // All-Access members get 20% off purchases
const KEEP = { rising: 0.85, pro: 0.90, supernova: 0.92 }; // artist's share of sales and tips
const TIP_MIN = 100, TIP_MAX = 50000;
// Buyers pay a service fee on purchases and tips that covers card processing (2.9% + 30c),
// so the artist's share and StarTier's share are never eaten by Stripe's fee.
const serviceFee = (cents: number) => Math.ceil((cents + 30) / (1 - 0.029)) - cents;
const feeLine = (n: number, fee: number) => ({
  [`line_items[${n}][quantity]`]: "1", [`line_items[${n}][price_data][currency]`]: "usd",
  [`line_items[${n}][price_data][unit_amount]`]: String(fee), [`line_items[${n}][price_data][product_data][name]`]: "Service fee",
});

const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const SITE = (Deno.env.get("SITE_URL") ?? "https://startier.app").replace(/\/+$/, "");
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class Oops extends Error {}

async function stripe(method: string, path: string, form?: Record<string, string>) {
  if (!STRIPE_KEY) throw new Oops("Payments are not switched on yet.");
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error("stripe", path, data?.error?.message); throw new Oops(data?.error?.message || "Stripe had a problem. Try again."); }
  return data;
}

// One Stripe Price per plan, found by lookup key (made the first time it is needed).
async function priceId(key: string, cents: number, name: string) {
  const lk = `startier_${key}_${cents}`;
  const found = await stripe("GET", `/prices?active=true&limit=1&lookup_keys[]=${lk}`);
  if (found.data?.length) return found.data[0].id as string;
  const p = await stripe("POST", "/prices", {
    currency: "usd", unit_amount: String(cents), "recurring[interval]": "month",
    "product_data[name]": name, lookup_key: lk, "metadata[kind]": key,
  });
  return p.id as string;
}

async function profile(id: string) {
  const { data } = await admin.from("profiles").select("*").eq("id", id).maybeSingle();
  if (!data) throw new Oops("Finish signing up first.");
  if (data.banned) throw new Oops("This account is paused.");
  return data;
}

// Stripe ids are kept in pay_accounts (private), not on the public profile.
async function payAcct(userId: string) {
  const { data } = await admin.from("pay_accounts").select("*").eq("user_id", userId).maybeSingle();
  return data || { user_id: userId, stripe_customer: null, stripe_account: null, payouts_ready: false };
}
const savePay = (userId: string, patch: Record<string, unknown>) =>
  admin.from("pay_accounts").upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() });

async function customer(me: any, email: string) {
  const pa = await payAcct(me.id);
  if (pa.stripe_customer) return pa.stripe_customer as string;
  const c = await stripe("POST", "/customers", { email: email || "", name: me.display_name || "", "metadata[user_id]": me.id });
  await savePay(me.id, { stripe_customer: c.id });
  return c.id as string;
}

async function payee(artistId: string) {
  const a = await profile(artistId).catch(() => null);
  if (!a || a.role !== "star") throw new Oops("That artist was not found.");
  const pa = await payAcct(artistId);
  if (!pa.stripe_account || !pa.payouts_ready) throw new Oops(`${a.display_name || "This artist"} hasn't turned on payouts yet. Follow them and check back soon.`);
  const keep = a.is_supernova ? KEEP.supernova : a.is_pro ? KEEP.pro : KEEP.rising;
  return { a: { ...a, stripe_account: pa.stripe_account }, keep };
}

const back = (what: string) => ({ success_url: `${SITE}/?paid=${what}&s={CHECKOUT_SESSION_ID}`, cancel_url: `${SITE}/?paid=cancel` });

async function activeSub(userId: string, kinds: string[], artistId?: string) {
  let q = admin.from("subscriptions").select("*").eq("user_id", userId).in("kind", kinds).in("status", ["active", "trialing", "past_due"]);
  if (artistId) q = q.eq("artist_id", artistId);
  const { data } = await q.limit(1);
  return data && data[0];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "Log in first." }, 401);
    const user = u.user;
    const body = await req.json().catch(() => ({}));
    const me = await profile(user.id);

    switch (body.action) {
      case "plan": {
        const plan = body.plan as keyof typeof PLAN;
        if (!PLAN[plan]) throw new Oops("Pick a plan.");
        if (plan !== "pass" && me.role !== "star") throw new Oops("Star Pro and Supernova are for artist accounts.");
        if (await activeSub(me.id, [plan])) throw new Oops("You already have that plan.");
        // Switching between Star Pro and Supernova: change the plan on the same subscription.
        const other = plan === "pro" ? "supernova" : plan === "supernova" ? "pro" : null;
        const cur = other ? await activeSub(me.id, [other]) : null;
        const price = await priceId(plan, PLAN[plan].cents, PLAN[plan].name);
        if (cur) {
          const sub = await stripe("GET", `/subscriptions/${cur.id}`);
          await stripe("POST", `/subscriptions/${cur.id}`, {
            "items[0][id]": sub.items.data[0].id, "items[0][price]": price,
            proration_behavior: "create_prorations", "metadata[kind]": plan,
          });
          await admin.from("subscriptions").update({ kind: plan, updated_at: new Date().toISOString() }).eq("id", cur.id);
          await admin.from("profiles").update({ [PLAN[other!].flag]: false, [PLAN[plan].flag]: true }).eq("id", me.id);
          return json({ done: true });
        }
        const s = await stripe("POST", "/checkout/sessions", {
          mode: "subscription", customer: await customer(me, user.email ?? ""), client_reference_id: me.id,
          "line_items[0][price]": price, "line_items[0][quantity]": "1",
          "metadata[kind]": plan, "metadata[user_id]": me.id,
          "subscription_data[metadata][kind]": plan, "subscription_data[metadata][user_id]": me.id,
          allow_promotion_codes: "true", ...back("plan"),
        });
        return json({ url: s.url });
      }

      case "galaxy": {
        const artistId = String(body.artist_id || "");
        if (artistId === me.id) throw new Oops("That's your own Galaxy.");
        const { data: g } = await admin.from("galaxies").select("artist_id,name").eq("artist_id", artistId).maybeSingle();
        if (!g) throw new Oops("This artist doesn't have a Galaxy yet.");
        if (await activeSub(me.id, ["galaxy"], artistId)) throw new Oops("You're already in this Galaxy.");
        const { a } = await payee(artistId);
        const price = await priceId("galaxy", GALAXY_CENTS, "StarTier Galaxy membership");
        const feePct = (((GALAXY_CENTS - GALAXY_ARTIST_CENTS) / GALAXY_CENTS) * 100).toFixed(2);
        const s = await stripe("POST", "/checkout/sessions", {
          mode: "subscription", customer: await customer(me, user.email ?? ""), client_reference_id: me.id,
          "line_items[0][price]": price, "line_items[0][quantity]": "1",
          "metadata[kind]": "galaxy", "metadata[user_id]": me.id, "metadata[artist_id]": artistId,
          "subscription_data[metadata][kind]": "galaxy", "subscription_data[metadata][user_id]": me.id, "subscription_data[metadata][artist_id]": artistId,
          "subscription_data[transfer_data][destination]": a.stripe_account,
          "subscription_data[application_fee_percent]": feePct,
          "subscription_data[description]": `${g.name || (a.display_name + "'s Galaxy")} on StarTier`,
          ...back("galaxy"),
        });
        return json({ url: s.url });
      }

      case "buy": {
        let title = "", artistId = "", cents = 0, ref: Record<string, string> = {};
        if (body.release_id) {
          const { data: r } = await admin.from("releases").select("id,artist_id,title,price_cents,status,kind").eq("id", Number(body.release_id)).maybeSingle();
          if (!r || r.status !== "live") throw new Oops("That item isn't available.");
          title = r.title; artistId = r.artist_id; cents = r.price_cents || 0; ref = { "metadata[release_id]": String(r.id) };
          const { data: own } = await admin.from("purchases").select("id").eq("user_id", me.id).eq("release_id", r.id).eq("kind", "buy").limit(1);
          if (own?.length) throw new Oops("You already own this.");
        } else if (body.collection_id) {
          const { data: c } = await admin.from("collections").select("*").eq("id", Number(body.collection_id)).maybeSingle();
          if (!c) throw new Oops("That collection isn't available.");
          title = c.title; artistId = c.artist_id; cents = c.price_cents || 0; ref = { "metadata[collection_id]": String(c.id) };
          const { data: own } = await admin.from("purchases").select("id").eq("user_id", me.id).eq("collection_id", c.id).eq("kind", "buy").limit(1);
          if (own?.length) throw new Oops("You already own this.");
        } else throw new Oops("Pick something to buy.");
        if (cents <= 0) throw new Oops("This one is free.");
        if (artistId === me.id) throw new Oops("That's your own release.");
        const { a, keep } = await payee(artistId);
        if (me.has_pass) cents = Math.round(cents * (1 - PASS_OFF));
        cents = Math.max(50, cents);
        const svc = serviceFee(cents);
        const fee = cents - Math.floor(cents * keep) + svc;
        const s = await stripe("POST", "/checkout/sessions", {
          mode: "payment", customer: await customer(me, user.email ?? ""), client_reference_id: me.id,
          "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][unit_amount]": String(cents),
          "line_items[0][price_data][product_data][name]": `${title} by ${a.display_name}`.slice(0, 120),
          ...(me.has_pass ? { "line_items[0][price_data][product_data][description]": "All-Access 20% off applied" } : {}),
          ...feeLine(1, svc),
          "payment_intent_data[transfer_data][destination]": a.stripe_account,
          "payment_intent_data[application_fee_amount]": String(fee),
          "metadata[kind]": "buy", "metadata[user_id]": me.id, "metadata[artist_id]": artistId, ...ref,
          ...back("buy"),
        });
        return json({ url: s.url });
      }

      case "tip": {
        const artistId = String(body.artist_id || "");
        const cents = Math.round(Number(body.cents) || 0);
        if (cents < TIP_MIN || cents > TIP_MAX) throw new Oops("Tips can be $1 to $500.");
        if (artistId === me.id) throw new Oops("You can't tip yourself.");
        const { a } = await payee(artistId);
        const svc = serviceFee(cents);
        const fee = cents - Math.floor(cents * KEEP.rising) + svc;
        const s = await stripe("POST", "/checkout/sessions", {
          mode: "payment", customer: await customer(me, user.email ?? ""), client_reference_id: me.id,
          "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][unit_amount]": String(cents),
          "line_items[0][price_data][product_data][name]": `Tip for ${a.display_name}`.slice(0, 120),
          ...feeLine(1, svc),
          "payment_intent_data[transfer_data][destination]": a.stripe_account,
          "payment_intent_data[application_fee_amount]": String(fee),
          "metadata[kind]": "tip", "metadata[user_id]": me.id, "metadata[artist_id]": artistId,
          ...back("tip"),
        });
        return json({ url: s.url });
      }

      case "portal": {
        const pa = await payAcct(me.id);
        if (!pa.stripe_customer) throw new Oops("You don't have any paid plans yet.");
        const s = await stripe("POST", "/billing_portal/sessions", { customer: pa.stripe_customer, return_url: `${SITE}/?paid=back` })
          .catch((e) => { throw new Oops(/configuration/i.test(e.message) ? "The billing page isn't switched on yet. Try again soon." : e.message); });
        return json({ url: s.url });
      }

      case "connect":
      case "connect_status": {
        if (me.role !== "star") throw new Oops("Payouts are for artist accounts.");
        const pa = await payAcct(me.id);
        let acct = pa.stripe_account as string | null;
        if (!acct) {
          if (body.action === "connect_status") return json({ connected: false, ready: false });
          const a = await stripe("POST", "/accounts", {
            type: "express", country: "US", email: user.email ?? "",
            "capabilities[transfers][requested]": "true",
            "business_profile[product_description]": "Music, videos and art sold on StarTier",
            "business_profile[url]": `${SITE}`,
            "metadata[user_id]": me.id,
          });
          acct = a.id as string;
          await savePay(me.id, { stripe_account: acct, payouts_ready: false });
        }
        const a = await stripe("GET", `/accounts/${acct}`);
        const ready = !!(a.details_submitted && a.payouts_enabled && a.capabilities?.transfers === "active");
        if (ready !== !!pa.payouts_ready) await savePay(me.id, { payouts_ready: ready });
        if (body.action === "connect_status") return json({ connected: true, ready, due: (a.requirements?.currently_due || []).length });
        if (a.details_submitted) {
          const l = await stripe("POST", `/accounts/${acct}/login_links`, {});
          return json({ url: l.url, ready });
        }
        const link = await stripe("POST", "/account_links", {
          account: acct, type: "account_onboarding",
          refresh_url: `${SITE}/?paid=connect-retry`, return_url: `${SITE}/?paid=connect`,
        });
        return json({ url: link.url, ready });
      }

      default:
        throw new Oops("Unknown action.");
    }
  } catch (e) {
    if (e instanceof Oops) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
});
