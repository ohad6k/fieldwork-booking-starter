# Fieldwork Workshop Booking

A ready-to-book programme for a paper, print or textile studio. Guests choose a workshop, reserve the last seat and manage their ticket from the same browser. Connect Supabase to share availability across devices.

[Try the live demo](https://fieldwork-studio-gallery-w15.vercel.app) · [See the mobile ticket](docs/images/ticket-390.png)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fohad6k%2Ffieldwork-booking-starter&project-name=fieldwork-booking-starter&repository-name=fieldwork-booking-starter)

![Fieldwork Studio’s live workshop programme with three dated classes and their remaining seats](docs/images/programme-1440.png)

Next.js 16 App Router, React 19 and vanilla CSS. Guest booking uses browser storage by default. Supabase adds a transactional PostgreSQL seat guard.

[Reservation screen](docs/images/reserve-1440.png) · [Mobile programme](docs/images/mobile-workshops.png)

## Book your first seat

In the live demo, choose **Reserve a seat → Confirm reservation** under *Folded forms*. Reload, open **My tickets**, and select the workshop. **Cancel reservation → Release seat** returns the seat. The demo stores tickets in the browser.

To run your own copy, use Node.js 24 in the repository root.

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). No environment values are required for the browser demo.

## Make the programme yours

Fieldwork lists one upcoming date per workshop and features the first class in the [catalogue](lib/programme.mjs). Edit the catalogue for the browser demo and the [SQL seed](supabase/seed.sql) for connected mode. Update the slug, capacity, sample reservations and schedule offset in both places when you want matching starting programmes. Offsets are counted from Saturday at 00:00 UTC. A null database offset makes a workshop a one-off. Add workshop artwork at `public/studies/<slug>.webp` and thumbnails at `public/studies/thumbs/<slug>-96.webp` and `<slug>-192.webp`.

## Share availability with Supabase

1. In a Supabase project's SQL Editor, run the [migration](supabase/migrations/20261122222124_workshop_capacity.sql), then the [seed](supabase/seed.sql).
2. Add the values below in your hosting project's server environment or create `.env.local` for local development. Paste your Project URL and server secret in place of the placeholders. If you connected through the gallery's Supabase integration, check for `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Fieldwork accepts either URL variable with either server key. [Supabase key guide](https://supabase.com/docs/guides/api/api-keys)

   ```dotenv
   SUPABASE_URL=<your project URL>
   SUPABASE_SECRET_KEY=<your server secret>
   ```

3. Restart `npm run dev` locally or redeploy the hosted project. **Studio bookings** identifies shared availability. Guests manage their tickets in the browser where they booked. The booking endpoint accepts guests without sign-in or built-in rate limits. For a public studio, you can rate-limit requests to `/api/booking` in Vercel Firewall. To enforce a per-person allowance, require sign-in. [Vercel rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) · [Supabase Auth](https://supabase.com/docs/guides/auth)

After a recurring class closes, run [reschedule.sql](supabase/reschedule.sql) to schedule its next date from its stored offset. Past tickets keep their dates. You can automate this step with [Supabase Cron](https://supabase.com/docs/guides/cron).

For display, set `STUDIO_LOCALE` and `STUDIO_TIME_ZONE` in [programme.mjs](lib/programme.mjs). The defaults are `en-GB` and `Europe/London`. The schedule stays anchored in UTC, so London displays a class one hour later during British Summer Time.

## Check the last seat

Run `bash scripts/test-db.sh` with Docker and Bash. The pgTAP suite checks that a full session rejects a second reservation, cancellation restores the seat and rescheduling preserves historical tickets. CI runs it on migration changes. [Database test setup and recorded results](docs/booking-proof.md)

Run `npm test` for schedule and London time-label tests and `npm run build` for the production build.

## License

[MIT](LICENSE). Font licenses accompany [Schibsted Grotesk](public/fonts/OFL-Schibsted.txt) and [IBM Plex Mono](public/fonts/OFL-IBM-Plex-Mono.txt).
