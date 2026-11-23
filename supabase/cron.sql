-- Enable Supabase Cron first, then run this in the SQL Editor after the migration.
-- Running it again updates the same job. One-off workshops keep their dates.
select cron.schedule(
  'fieldwork-reschedule-workshops',
  '*/5 * * * *',
  $job$
    update public.workshops w
    set starts_at = public.next_workshop_start(w.offset_hours, now())
    where w.offset_hours is not null and w.starts_at <= now();
  $job$
);
