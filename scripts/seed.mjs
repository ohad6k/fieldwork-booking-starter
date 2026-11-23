import { readFileSync, writeFileSync } from 'node:fs';
import { programme } from '../lib/programme.mjs';

const seed = new URL('../supabase/seed.sql', import.meta.url);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const rows = programme.map(({ slug, capacity, offsetHours, reserved }) => ({
  workshop: `(${quote(slug)}, ${capacity}, ${offsetHours})`,
  tickets: `(${quote(slug)}, ${reserved})`,
}));

const sql = `-- Generated from lib/programme.mjs by npm run seed. Run after the migration.
-- Re-running preserves existing sessions and bookings.
insert into public.workshops (slug, capacity, offset_hours, starts_at)
select s.slug, s.capacity, s.offset_hours, public.next_workshop_start(s.offset_hours, now())
from (values
  ${rows.map(({ workshop }) => workshop).join(',\n  ')}
) as s(slug, capacity, offset_hours)
on conflict (slug) do nothing;

-- Deterministic sample tickets.
insert into public.workshop_reservations (workshop_slug, booking_id)
select s.slug, 'studio-seed-' || n
from (values
  ${rows.map(({ tickets }) => tickets).join(',\n  ')}
) as s(slug, booked)
cross join lateral generate_series(1, s.booked) as n
where not exists (select 1 from public.workshop_reservations r
  where r.workshop_slug = s.slug and r.booking_id = 'studio-seed-' || n);
`;

if (process.argv.includes('--check')) {
  if (readFileSync(seed, 'utf8').replaceAll('\r\n', '\n') !== sql) {
    console.error('The workshop seed is out of date. Run npm run seed.');
    process.exitCode = 1;
  }
} else {
  writeFileSync(seed, sql, 'utf8');
}
