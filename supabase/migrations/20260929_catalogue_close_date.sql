-- ============================================================================
-- SchemeSetu — application close date for catalogue schemes.
-- Filled by backend/scripts/syncApimitra.mjs from the apimitra.in mirror of the
-- myScheme index. close_date_raw keeps the text exactly as published; close_date
-- is set only when that text parses to a real date, so an unparseable value never
-- hides a scheme. Safe to run on an existing project. Idempotent. Non-destructive.
-- ============================================================================

alter table public.myscheme_catalogue add column if not exists close_date      date;
alter table public.myscheme_catalogue add column if not exists close_date_raw  text;
alter table public.myscheme_catalogue add column if not exists synced_at       timestamptz;

create index if not exists myscheme_catalogue_close_date_idx on public.myscheme_catalogue (close_date);
