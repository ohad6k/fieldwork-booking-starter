# How the last seat is claimed

The booking row and the seat count change in the same PostgreSQL transaction. A reservation can advance the count only while `reserved < capacity`. If the update affects no row, the trigger raises `Booking closed` and the reservation rolls back. Cancelling a ticket releases a seat on its own session date. [Booking migration](../supabase/migrations/20261122222124_workshop_capacity.sql)

## Run the database tests

From the repository root with Docker and Bash installed, run the same test as the migration workflow. The script starts a disposable PostgreSQL container, applies the migrations and seed, runs pgTAP, and removes the container on exit.

```sh
bash scripts/test-db.sh
```

If you already use the Supabase CLI, you can run the suite in a fresh local project instead.

```sh
supabase start
supabase test db
supabase stop
```

The pgTAP suite checks the last seat, a second request against a full session, cancellation, rescheduling and database access. The tests run sequentially in one transaction and roll back their rows. [Test cases](../supabase/tests/workshop.test.sql) · [Supabase testing guide](https://supabase.com/docs/guides/local-development/testing/overview)

## Replay two guests booking the last seat

The [last-seat rule](../supabase/tests/last-seat.rule.json) applies this starter’s migrations to a disposable local PostgreSQL instance using PGlite. It seeds a two-seat workshop with one of its seats already taken. Two guest inserts run in separate transactions. After both finish, the test checks that the reservation count matches the stored count and stays within capacity. The pgTAP suite separately checks that a single valid reservation succeeds.

With Node.js 24 from the repository root:

```sh
npx -y viberaven@1.13.0 race . --spec supabase/tests/last-seat.rule.json
```

This optional command uses the published release of VibeRaven, a CLI maintained by the template author. It tests bounded Read Committed schedules over synthetic rows. The exit status and reported order counts describe this rule. Browser behavior and hosted Supabase settings have separate checks.

## Opt into migration review

If you want the advisory review on migration pull requests, open your fork’s **Settings → Secrets and variables → Actions → Variables**. Set `FIELDWORK_MIGRATION_REVIEW` to `true`. The job runs a static VibeRaven review and the last-seat replay above. The pgTAP job verifies the SQL contract independently. [Commands and pinned version](../.github/workflows/migrations.yml)
