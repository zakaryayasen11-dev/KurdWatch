// send-push-function.ts
//
// A Supabase Edge Function that sends a real Web Push notification to every device a user
// has subscribed from. This is the piece that MUST run server-side: delivering a push
// requires signing the request with the VAPID *private* key, which can never safely live in
// the browser-side i.html file.
//
// ── HOW THIS GETS TRIGGERED ──
// It's meant to be called by a Supabase Database Webhook on INSERT to `user_notifications`
// (DM previews, friend requests, room invites all insert a row there already — see the
// SCHEMA NOTE near the top of i.html). Every new row automatically fires this function.
//
// ── DEPLOYMENT STEPS ──
// 1. Install the Supabase CLI if you don't have it:
//      npm install -g supabase
// 2. Log in and link this function to your project:
//      supabase login
//      supabase link --project-ref YOUR_PROJECT_REF   (find this in your Supabase project URL)
// 3. Create the function locally and paste this file's contents into it:
//      supabase functions new send-push
//      (then replace the generated index.ts with this file's contents)
// 4. Set the required secrets (never put these in client-side code):
//      supabase secrets set VAPID_PUBLIC_KEY=BDpNg-2pIDyTVBD-5-5yVzz3eQjxBVIOwUw7GHABnNtxlFeZNZJy8RGcpJLePhvieYXsG5-7HDEt62ya6JIg498
//      supabase secrets set VAPID_PRIVATE_KEY=venS8k_hYGcLAyYp-X1FmICIm3PljPG29YOubKLy_Zk
//      supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<copy from Project Settings → API → service_role>
//    (SUPABASE_URL is provided automatically inside every Edge Function, no need to set it.)
// 5. Deploy it (--no-verify-jwt because a Database Webhook calls this, not a logged-in user):
//      supabase functions deploy send-push --no-verify-jwt
// 6. In the Supabase Dashboard → Database → Webhooks → Create a new webhook:
//      Table: user_notifications | Event: INSERT | Type: Supabase Edge Function
//      Function: send-push
//
// That's it — from then on, every new DM/friend-request/room-invite notification will also
// trigger a real push to any device the recipient has granted permission on.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'https://esm.sh/web-push@3.6.7'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!

// Replace with a real contact email/URL for your project — required by the Web Push spec so
// push services can reach you if something's misconfigured.
webpush.setVapidDetails('mailto:you@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

Deno.serve(async (req) => {
  try {
    const payload = await req.json()
    // Database Webhook payload shape: { type: 'INSERT', table: 'user_notifications', record: {...} }
    const record = payload.record
    if (!record?.user_id) {
      return new Response(JSON.stringify({ error: 'no user_id in payload' }), { status: 400 })
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('endpoint,p256dh,auth')
      .eq('user_id', record.user_id)

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    if (!subs?.length) return new Response(JSON.stringify({ sent: 0, reason: 'no subscriptions' }), { status: 200 })

    const notifPayload = JSON.stringify({
      title: 'KURD WATCH',
      body: record.text || '',
      url: record.link ? `/?notif=${encodeURIComponent(record.link)}` : '/',
    })

    const results = await Promise.allSettled(
      subs.map((s) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          notifPayload
        )
      )
    )

    // Clean up subscriptions that are no longer valid (user revoked permission, uninstalled, etc.)
    const deadEndpoints = subs
      .filter((_, i) => results[i].status === 'rejected')
      .map((s) => s.endpoint)
    if (deadEndpoints.length) {
      await supabase.from('push_subscriptions').delete().in('endpoint', deadEndpoints)
    }

    return new Response(JSON.stringify({ sent: results.filter(r => r.status === 'fulfilled').length }), { status: 200 })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  }
})
