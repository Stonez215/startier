// StarTier: a member deletes their own account from inside the app (Apple 5.1.1(v), Google Play).
// Deploy as "delete-account" with "Enforce JWT verification" OFF (it checks the login itself).
// Secrets: STRIPE_SECRET_KEY (optional until payments are on).
//
// Fans and artists with no sales: everything is deleted right away (plans cancelled, files removed,
// account erased). Artists who have sold something or set up payouts: the request is saved and the
// StarTier team finishes it within 30 days, so buyers keep what they paid for and tax records are kept.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const BUCKETS = ["covers", "songs", "previews", "downloads", "avatars"];

async function removeFolder(bucket: string, folder: string) {
  for (let i = 0; i < 50; i++) {
    const { data } = await admin.storage.from(bucket).list(folder, { limit: 100 });
    if (!data?.length) return;
    await admin.storage.from(bucket).remove(data.map((f) => `${folder}/${f.name}`));
    if (data.length < 100) return;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "Log in first." }, 401);
    const me = u.user;
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== "DELETE") return json({ error: "Type DELETE to confirm." }, 400);

    const { data: p } = await admin.from("profiles").select("id,role,display_name").eq("id", me.id).maybeSingle();
    const { data: pa } = await admin.from("pay_accounts").select("stripe_account,stripe_customer").eq("user_id", me.id).maybeSingle();
    const { count: sold } = await admin.from("purchases").select("id", { count: "exact", head: true }).eq("artist_id", me.id);
    const { count: owed } = await admin.from("artist_earnings").select("id", { count: "exact", head: true }).eq("artist_id", me.id).in("status", ["pending", "paid"]);

    // Cancel any paid plans or Galaxies now, so nobody is charged again.
    const { data: subs } = await admin.from("subscriptions").select("id").eq("user_id", me.id).in("status", ["active", "trialing", "past_due"]);
    if (subs?.length && !STRIPE_KEY) return json({ error: "We couldn't cancel your plans. Contact support@kingjordanapps.com." }, 500);
    for (const s of subs || []) {
      const r = await fetch(`https://api.stripe.com/v1/subscriptions/${s.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
      if (!r.ok && r.status !== 404) return json({ error: "We couldn't cancel your plans. Try again, or contact support@kingjordanapps.com." }, 500);
      await admin.from("subscriptions").update({ status: "canceled", updated_at: new Date().toISOString() }).eq("id", s.id);
    }

    if (p?.role === "star" && ((sold || 0) > 0 || (owed || 0) > 0 || pa?.stripe_account)) {
      await admin.from("profiles").update({ banned: true }).eq("id", me.id);
      await admin.from("releases").update({ status: "hidden" }).eq("artist_id", me.id).eq("status", "live");
      await admin.from("support_messages").insert({
        user_id: me.id, name: p.display_name || "Member", email: me.email || "", topic: "Account deletion request",
        message: `Delete this Star account within 30 days. It has ${sold || 0} sales and ${owed || 0} earnings records. Keep buyers' purchased files and tax records; finish any payouts first. Plans were cancelled.`,
        source: "delete-account", status: "new",
      });
      return json({ queued: true, days: 30 });
    }

    // Everyone else: delete now.
    const { data: vids } = await admin.from("releases").select("bunny_video_id,preview_bunny_id").eq("artist_id", me.id);
    const bunny = (vids || []).flatMap((v) => [v.bunny_video_id, v.preview_bunny_id]).filter(Boolean);
    for (const b of BUCKETS) await removeFolder(b, me.id);
    if (bunny.length) {
      await admin.from("support_messages").insert({
        user_id: null, name: "StarTier", email: "", topic: "Delete Bunny videos",
        message: `A member deleted their account. Delete these videos in Bunny Stream: ${bunny.join(", ")}`, source: "delete-account", status: "new",
      });
    }
    const { error } = await admin.auth.admin.deleteUser(me.id);
    if (error) return json({ error: "We couldn't delete your account. Try again, or contact support@kingjordanapps.com." }, 500);
    return json({ deleted: true });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
});
