-- Sahayak Locker PIN: one salted hash per profile. No client policies: only the backend (service role) touches it.
create table if not exists public.locker_pins (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  pin_hash        text not null,
  salt            text not null,
  failed_attempts int  not null default 0,
  locked_until    timestamptz,
  updated_at      timestamptz not null default now()
);
alter table public.locker_pins enable row level security;
-- (intentionally no policies: anon/authenticated roles cannot read or write this table)
