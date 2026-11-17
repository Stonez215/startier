// StarTier: Stripe tells us when someone paid, renewed, cancelled, got a refund or opened a dispute.
// Deploy in Supabase as "stripe-webhook" with "Enforce JWT verification" OFF (Stripe can't log in).
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (whsec_... from the Stripe webhook endpoint)
// Stripe events to send: checkout.session.completed, checkout.session.async_payment_succeeded,
//   customer.subscription.created, customer.subscription.updated, customer.subscription.deleted,
//   invoice.paid, charge.refunded, charge.dispute.created
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const FLAG: Record<string, string> = { pass: "has_pass", pro: "is_pro", supernova: "is_supernova" };
const ON = new Set(["active", "trialing", "past_due"]);

async function stripe(method: string, path: string, form?: Record<string, string>, idem?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${STRIPE_KEY}`, "Stripe-Version": "2024-06-20" };
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch("https://api.stripe.com/v1" + path, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined });
  const d = await res.json().catch(() => ({}));
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

// Send each pending earning for this sale to the artist's Stripe account. Anyone whose payouts
// aren't set up yet stays "pending"; allaccess-payout retries every day.
async function payEarnings(sessionId: string, chargeId: string, group: string | null) {
  const { data: rows } = await admin.from("artist_earnings").select("id,artist_id,amount_cents").eq("session_id", sessionId).eq("status", "pending");
  for (const e of rows || []) {
    if (!e.artist_id || e.amount_cents <= 0) continue;
    const { data: pa } = await admin.from("pay_accounts").select("stripe_account,payouts_ready").eq("user_id", e.artist_id).maybeSingle();
    if (!pa?.stripe_account || !pa.payouts_ready) continue;
    try {
      const tr = await stripe("POST", "/transfers", {
        amount: String(e.amount_cents), currency: "usd", destination: pa.stripe_account,
        source_transaction: chargeId, ...(group ? { transfer_group: group } : {}),
        "metadata[earning_id]": String(e.id), "metadata[session_id]": sessionId,
      }, `earning-${e.id}`);
      await admin.from("artist_earnings").update({ status: "paid", transfer_id: tr.id, paid_at: new Date().toISOString() }).eq("id", e.id);
    } catch (err) { console.error("transfer", e.id, (err as Error).message); }
  }
}

async function recordSale(o: any) {
  const md = o.metadata || {};
  const s = await stripe("GET", `/checkout/sessions/${o.id}?expand[]=payment_intent`);
  const pi = s.payment_intent || {};
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
  await admin.from("purchases").upsert({
    session_id: o.id, user_id: md.user_id, artist_id: md.artist_id, kind: md.kind,
    release_id: md.release_id ? Number(md.release_id) : null, collection_id: md.collection_id ? Number(md.collection_id) : null,
    amount_cents: o.amount_total || 0, charge_id: chargeId || null,
  }, { onConflict: "session_id" });
  const artistCents = Number(md.artist_cents || 0);
  if (!md.artist_id || !(artistCents > 0)) return; // older checkouts paid the artist directly
  // Who gets the artist's share: a song's active split (collaborators), otherwise the artist alone.
  let parts: { artist_id: string; cents: number }[] = [{ artist_id: md.artist_id, cents: artistCents }];
  if (md.kind === "buy" && md.release_id) {
    const { data } = await admin.rpc("st_split_recipients", { p_release: Number(md.release_id), p_owner: md.artist_id, p_cents: artistCents });
    if (Array.isArray(data) && data.length) parts = data;
  }
  for (const p of parts) {
    if (!(p.cents > 0)) continue;
    await admin.from("artist_earnings").upsert({
      artist_id: p.artist_id, source: md.kind === "tip" ? "tip" : "sale", session_id: o.id, charge_id: chargeId || null,
      release_id: md.release_id ? Number(md.release_id) : null, amount_cents: p.cents,
    }, { onConflict: "session_id,artist_id", ignoreDuplicates: true });
  }
  if (chargeId) await payEarnings(o.id, chargeId, pi.transfer_group || null);
}

// Plan renewals: record each paid invoice (All-Access money is shared with artists monthly).
async function recordInvoice(inv: any) {
  if (!(inv.amount_paid > 0)) return;
  let md = inv.subscription_details?.metadata || inv.parent?.subscription_details?.metadata || null;
  const subId = inv.subscription || inv.parent?.subscription_details?.subscription || null;
  if ((!md || !md.kind) && subId) md = (await stripe("GET", `/subscriptions/${typeof subId === "string" ? subId : subId.id}`)).metadata;
  if (!md?.kind) return;
  await admin.from("plan_payments").upsert({
    id: inv.id, user_id: md.user_id || null, kind: md.kind, subscription_id: typeof subId === "string" ? subId : subId?.id || null,
    amount_cents: inv.amount_paid, fee_cents: Math.round(inv.amount_paid * 0.029) + 30,
    paid_at: new Date(((inv.status_transitions?.paid_at) || inv.created) * 1000).toISOString(),
  }, { onConflict: "id" });
}

// Refund or dispute: take back what was sent to artists for that charge, and remove the purchase.
async function undoCharge(chargeId: string, full: boolean, why: string) {
  if (!chargeId || !full) return;
  const { data: rows } = await admin.from("artist_earnings").select("id,status,transfer_id").eq("charge_id", chargeId).in("status", ["pending", "paid"]);
  for (const e of rows || []) {
    try {
      if (e.status === "paid" && e.transfer_id) await stripe("POST", `/transfers/${e.transfer_id}/reversals`, { "metadata[reason]": why }, `reverse-${e.id}`);
      await admin.from("artist_earnings").update({ status: e.status === "paid" ? "reversed" : "cancelled" }).eq("id", e.id);
    } catch (err) { console.error("reversal", e.id, (err as Error).message); }
  }
  await admin.from("purchases").delete().eq("charge_id", chargeId);
}

async function handle(evt: any) {
  const o = evt.data.object;
  switch (evt.type) {
    case "checkout.session.completed": {
      const md = o.metadata || {};
      if (o.mode === "subscription" && o.subscription) {
        await applySub(await stripe("GET", `/subscriptions/${o.subscription}`));
      } else if (o.mode === "payment" && (md.kind === "buy" || md.kind === "tip") && o.payment_status === "paid") {
        await recordSale(o);
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
    case "invoice.paid":
      await recordInvoice(o);
      break;
    case "charge.refunded":
      await undoCharge(o.id, o.refunded === true || o.amount_refunded >= o.amount, "refund");
      break;
    case "charge.dispute.created":
      await undoCharge(typeof o.charge === "string" ? o.charge : o.charge?.id, true, "dispute");
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
