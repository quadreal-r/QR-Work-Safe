-- Work Safe contacts + immutable per-worker check-in events.
--
-- Trust model: devices never talk to PostgREST. They call the work-safe-api Worker
-- with the shared field password, and the Worker uses the Supabase service key.
--
-- Applied to project wyiymdtlncperqpwriuk (QR-East_Industrial_Database).

create table if not exists public.work_safe_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  email text check (email is null or char_length(email) between 3 and 160),
  phone text check (phone is null or char_length(phone) between 8 and 20),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text check (updated_by is null or char_length(updated_by) <= 64),
  constraint work_safe_contacts_has_channel check (email is not null or phone is not null)
);

comment on table public.work_safe_contacts is
  'Shared supervisor/watcher list for QuadReal Work Safe. Written only by work-safe-api using the service key.';

create index if not exists work_safe_contacts_active_name_idx
  on public.work_safe_contacts (active, name);

alter table public.work_safe_contacts enable row level security;

drop policy if exists "Editors read work_safe_contacts" on public.work_safe_contacts;
create policy "Editors read work_safe_contacts" on public.work_safe_contacts
  for select to authenticated using (public.is_app_editor());

create table if not exists public.work_safe_events (
  id uuid primary key default gen_random_uuid(),
  worker_name text not null check (char_length(worker_name) between 1 and 80),
  event_type text not null check (event_type in ('on_site', 'safe_ground')),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  address text check (address is null or char_length(address) <= 500),
  occurred_at timestamptz not null,
  recipients jsonb not null default '[]'::jsonb,
  device_id text check (device_id is null or char_length(device_id) <= 64),
  session_id uuid not null,
  created_at timestamptz not null default now()
);

comment on table public.work_safe_events is
  'Immutable per-worker climb/site check-in log for QuadReal Work Safe. Written only by work-safe-api using the service key.';

create index if not exists work_safe_events_worker_occurred_idx
  on public.work_safe_events (worker_name, occurred_at desc);

create index if not exists work_safe_events_session_idx
  on public.work_safe_events (session_id);

create index if not exists work_safe_events_occurred_idx
  on public.work_safe_events (occurred_at desc);

alter table public.work_safe_events enable row level security;

drop policy if exists "Editors read work_safe_events" on public.work_safe_events;
create policy "Editors read work_safe_events" on public.work_safe_events
  for select to authenticated using (public.is_app_editor());
