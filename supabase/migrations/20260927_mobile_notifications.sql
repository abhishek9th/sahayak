-- ============================================================================
-- SchemeSahayak — Android app: push tokens, notification preferences, saved
-- schemes, catalogue change detection, per-user notification inbox.
-- Idempotent and non-destructive (safe to re-run). Apply in the Supabase SQL
-- editor. All tables are written ONLY by the backend (service role); RLS is
-- enabled with no policies so the public anon key can read/write nothing.
--
-- HONESTY NOTE ON "NEW SCHEME" EVENTS
-- myscheme_catalogue has no government publication date and no "source updated"
-- date. Its created_at is when OUR importer first inserted the row and its
-- updated_at is bumped by a trigger on every re-ingest, so neither can say
-- whether a scheme is new or changed. Change detection therefore fingerprints
-- the official-content columns (catalogue_fingerprints.content_hash):
--   * slug never seen after the baseline run  → 'added'   (= first seen by SchemeSahayak)
--   * content_hash changed                    → 'updated' (= official text changed in our import)
-- The FIRST run only records a baseline and notifies nobody.
-- ============================================================================

-- ---- push tokens (one row per device token) --------------------------------
create table if not exists public.device_push_tokens (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  expo_push_token text not null unique,
  platform       text not null default 'android',
  timezone       text,
  app_version    text,
  lang           text,
  failure_count  integer not null default 0,
  disabled_at    timestamptz,                      -- set when Expo reports DeviceNotRegistered
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create index if not exists device_push_tokens_user_idx on public.device_push_tokens (user_id) where disabled_at is null;

-- ---- preferences -------------------------------------------------------------
create table if not exists public.notification_preferences (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  enabled         boolean not null default false,   -- master switch; off until the user opts in
  new_schemes     boolean not null default true,
  state_schemes   boolean not null default true,
  profile_matches boolean not null default true,
  deadlines       boolean not null default false,   -- no verified deadline data exists yet; stored but never sent
  saved_updates   boolean not null default true,
  region_state    text,                             -- state for "schemes for my state" (chosen by the user)
  quiet_start     text check (quiet_start is null or quiet_start ~ '^[0-2][0-9]:[0-5][0-9]$'),
  quiet_end       text check (quiet_end   is null or quiet_end   ~ '^[0-2][0-9]:[0-5][0-9]$'),
  timezone        text,
  updated_at      timestamptz not null default now()
);
drop trigger if exists trg_notification_preferences_updated_at on public.notification_preferences;
create trigger trg_notification_preferences_updated_at before update on public.notification_preferences
  for each row execute function public.set_updated_at();

-- ---- saved schemes (mirror of the on-device list; lets the server watch them) -
create table if not exists public.user_saved_schemes (
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('curated','catalogue')),
  scheme_key text not null,                         -- curated scheme id, or catalogue slug
  title      text not null,
  subtitle   text,
  saved_at   timestamptz not null default now(),
  primary key (user_id, kind, scheme_key)
);

-- ---- change detection ---------------------------------------------------------
create table if not exists public.catalogue_fingerprints (
  slug            text primary key,
  content_hash    text not null,
  had_detail      boolean not null default false,   -- stage-2 detail scrape present when fingerprinted
  first_seen_at   timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

create table if not exists public.scheme_change_events (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null,
  event_type   text not null check (event_type in ('added','updated')),
  content_hash text not null,
  detected_at  timestamptz not null default now(),
  fanned_out_at timestamptz,                         -- set once user notifications were created
  unique (slug, event_type, content_hash)            -- the same change can never create two events
);
create index if not exists scheme_change_events_pending_idx on public.scheme_change_events (detected_at) where fanned_out_at is null;

create table if not exists public.notification_job_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---- per-user inbox + push delivery state -------------------------------------
create table if not exists public.user_notifications (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  event_id         uuid not null references public.scheme_change_events(id) on delete cascade,
  slug             text not null,
  kind             text not null check (kind in ('scheme_added','scheme_updated')),
  title            text not null,
  body             text not null,
  reason           text,
  created_at       timestamptz not null default now(),
  read_at          timestamptz,
  dismissed_at     timestamptz,
  push_status      text not null default 'pending'
                   check (push_status in ('pending','sending','sent','failed','skipped')),
  push_attempted_at timestamptz,
  push_ticket_id   text,
  unique (user_id, event_id)                         -- idempotent: one notification per user per event
);
create index if not exists user_notifications_inbox_idx on public.user_notifications (user_id, created_at desc) where dismissed_at is null;
create index if not exists user_notifications_push_idx on public.user_notifications (push_status, created_at) where push_status in ('pending','sending');

alter table public.device_push_tokens        enable row level security;
alter table public.notification_preferences  enable row level security;
alter table public.user_saved_schemes        enable row level security;
alter table public.catalogue_fingerprints    enable row level security;
alter table public.scheme_change_events      enable row level security;
alter table public.notification_job_state    enable row level security;
alter table public.user_notifications        enable row level security;
