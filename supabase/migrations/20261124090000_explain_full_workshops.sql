-- Tell guests why a booking closed: a full room, or a session that already started.
create or replace function public.reserve_workshop_seat() returns trigger
language plpgsql set search_path = '' as $$
declare
  session record;
begin
  select reserved, capacity, starts_at into session
    from public.workshops
    where slug = new.workshop_slug
    for update;
  if not found or session.starts_at <= now()
      or (new.starts_at is not null and session.starts_at <> new.starts_at) then
    raise exception 'Booking closed' using hint = 'This session has started or moved.';
  end if;
  if session.reserved >= session.capacity then
    raise exception 'Booking closed' using hint = 'This workshop is full.';
  end if;
  update public.workshops
    set reserved = session.reserved + 1
    where slug = new.workshop_slug;
  new.starts_at := session.starts_at;
  return new;
end;
$$;
