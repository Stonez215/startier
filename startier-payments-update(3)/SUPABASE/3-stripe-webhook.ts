// StarTier: Stripe tells us when someone paid, renewed or cancelled. This turns plans, Galaxies and purchases on and off.
// Deploy in Supabase: Edge Functions > Deploy a new function > Via Editor > name it "stripe-webhook" > paste this file.
// Then open the function's Details and turn OFF "Enforce JWT verification" (Stripe can't log in).
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (whsec_... from the Stripe webhook you create)
// Stripe events to send: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const FLAG: Record<string, string> = { pass: "has_pass", pro: "is_pro", supernova: "is_supernova" };
const ON = new Set(["active", "trialing", "past_due"]);

async function stripe(path: string) {
  const res = await fetch("https://api.stripe.com/v1" + path, { headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Stripe-Version": "2024-06-20" } });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || "stripe " + res.status);
  return d;
}

// Stripe-Signature check (HMAC SHA-256 of "timestamp.body").
async function verified(raw: string, header: string) {
  const items = header.split(",").map((p) => p.trim());
  const t = (items.find((p) => p.startsWith("t=")) || "").slice(2);
  const sigs = items.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === hex.length && [...s].every((c, i) => c === hex[i]));
}

// Turn a plan or Galaxy on/off for one member, from the subscription's current state.
async function applySub(sub: any) {
  const md = sub.metadata || {};
  const kind = md.kind, userId = md.user_id, artistId = md.artist_id || null;
  if (!userId || !(kind in FLAG || kind === "galaxy")) return;
  const on = ON.has(sub.status);
  await admin.from("subscriptions").upsert({
    id: sub.id, user_id: userId, kind, artist_id: artistId, status: sub.status,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (kind === "galaxy") {
    if (on) await admin.rpc("st_galaxy_paid", { p_user: userId, p_artist: artistId });
    else await admin.rpc("st_galaxy_ended", { p_user: userId, p_artist: artistId });
    return;
  }
  // Another active subscription for the same plan (or a free plan from an admin) keeps it on.
  const { data: others } = await admin.from("subscriptions").select("id").eq("user_id", userId).eq("kind", kind).in("status", [...ON]).neq("id", sub.id).limit(1);
  const { data: p } = await admin.from("profiles").select("comped_by").eq("id", userId).maybeSingle();
  const keep = on || !!others?.length;
  if (!keep && p?.comped_by) return; // an admin gave this member a free plan: leave it on
  await admin.from("profiles").update({ [FLAG[kind]]: keep }).eq("id", userId);
}

async function handle(evt: any) {
  const o = evt.data.object;
  switch (evt.type) {
    case "checkout.session.completed": {
      const md = o.metadata || {};
      if (o.mode === "subscription" && o.subscription) {
        await applySub(await stripe(`/subscriptions/${o.subscription}`));
      } else if (o.mode === "payment" && (md.kind === "buy" || md.kind === "tip") && o.payment_status === "paid") {
        await admin.from("purchases").upsert({
          session_id: o.id, user_id: md.user_id, artist_id: md.artist_id, kind: md.kind,
          release_id: md.release_id ? Number(md.release_id) : null, collection_id: md.collection_id ? Number(md.collection_id) : null,
          amount_cents: o.amount_total || 0,
        }, { onConflict: "session_id" });
      }
      break;
    }
    case "checkout.session.async_payment_succeeded":
      if ((o.metadata || {}).kind && o.mode === "payment") await handle({ type: "checkout.session.completed", data: { object: { ...o, payment_status: "paid" } } });
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await applySub(o);
      break;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const raw = await req.text();
  if (!SECRET || !(await verified(raw, req.headers.get("stripe-signature") || ""))) return new Response("bad signature", { status: 400 });
  try {
    await handle(JSON.parse(raw));
    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("webhook", e);
    return new Response("error", { status: 500 }); // Stripe retries later
  }
});
