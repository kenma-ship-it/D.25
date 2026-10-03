-- DE.25 orders table for Supabase Postgres.
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New
-- query -> paste -> Run) before setting SUPABASE_ORDERS_ENABLED=true.
--
-- This table holds customer PII (name, phone, email, address inside the
-- `customer`/`address` jsonb columns) — treat it with the same care as
-- data/orders.json already gets (never share a dump of it, never commit
-- one to a repo).
--
-- Row Level Security is enabled with NO policies defined. That is
-- deliberate, not incomplete: this app only ever talks to this table with
-- the service_role key (server/lib/supabaseRest.js), which bypasses RLS
-- entirely by design. Leaving RLS on with zero policies means the anon key
-- and any authenticated Supabase Auth user (including the admin-dashboard
-- login, if you're using Supabase Auth for that too — see
-- server/middleware/adminAuth.js) get ZERO direct access to this table
-- from the browser. All access goes through this app's own admin API,
-- which does its own authorization check first.

create table if not exists public.orders (
  order_id           uuid primary key,
  token              text not null,
  pin                text not null,
  customer           jsonb not null,
  address            jsonb not null,
  lines              jsonb not null,
  subtotal           numeric not null,
  delivery_fee       numeric not null default 0,
  tax                numeric not null default 0,
  total              numeric not null,
  delivery_quote     jsonb,
  payment_method     text not null,
  delivery_order_id  text,
  delivery           jsonb,
  is_sample          boolean not null default false,
  status             text not null,
  status_history     jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now()
);

-- The owner dashboard lists orders newest-first and looks up single orders
-- by id, and the customer-facing "My Orders" feature looks orders up by
-- phone number (server/orders/SupabaseOrdersStore.js's getOrdersByPhone)
-- — these are the access patterns worth indexing for.
-- Added with the Borzo integration. Safe to re-run on an existing table:
-- the courier booking record (Borzo order id, status, tracking link,
-- courier) and the flag marking dashboard-generated sample orders.
alter table public.orders add column if not exists delivery jsonb;
alter table public.orders add column if not exists is_sample boolean not null default false;
-- Added with online payments. Safe to re-run: the payment record (method,
-- status, amount in paise, Razorpay ids or UPI UTR, who verified it) and
-- whether the customer verified their WhatsApp number at checkout (the
-- receipt is only sent after payment, so this has to be remembered).
alter table public.orders add column if not exists payment jsonb;
alter table public.orders add column if not exists customer_phone_verified boolean not null default false;

create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_customer_phone_idx on public.orders ((customer ->> 'phone'));

alter table public.orders enable row level security;
-- No policies added on purpose — see the comment above. Every read/write
-- this app makes goes through the service_role key, which bypasses RLS.

comment on table public.orders is
  'DE.25 customer orders. Contains PII (customer/address jsonb). Server-only access via the service_role key — no RLS policies are defined on purpose.';
