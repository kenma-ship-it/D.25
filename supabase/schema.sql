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
  payment            jsonb,
  status             text not null,
  status_history     jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now()
);

-- The owner dashboard lists orders newest-first and looks up single orders
-- by id, and the customer-facing "My Orders" feature looks orders up by
-- phone number (server/orders/SupabaseOrdersStore.js's getOrdersByPhone)
-- — these are the access patterns worth indexing for.
create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_customer_phone_idx on public.orders ((customer ->> 'phone'));

alter table public.orders enable row level security;
-- No policies added on purpose — see the comment above. Every read/write
-- this app makes goes through the service_role key, which bypasses RLS.

comment on table public.orders is
  'DE.25 customer orders. Contains PII (customer/address jsonb). Server-only access via the service_role key — no RLS policies are defined on purpose.';

-- ---------------------------------------------------------------------------
-- Online payments (added with the payment gateway). Safe to run again on a
-- project created before this section existed.
-- ---------------------------------------------------------------------------
-- order.payment holds the gateway order id, every payment attempt (with
-- failure reasons), refunds and any issues the owner must act on — see
-- server/payments/service.js. Orders start as AWAITING_PAYMENT.
alter table public.orders add column if not exists payment jsonb;
create index if not exists orders_gateway_order_idx on public.orders ((payment ->> 'gatewayOrderId'));
create index if not exists orders_status_idx on public.orders (status);

-- Payments the gateway reported that match no order (money taken, nothing
-- to fulfil — usually refunded). Same server-only access as orders.
create table if not exists public.payment_issues (
  payment_id        text primary key,
  gateway_order_id  text,
  status            text not null,
  amount_paise      bigint not null,
  method            text,
  source            text,
  seen_at           timestamptz not null default now(),
  resolved          boolean not null default false
);
alter table public.payment_issues enable row level security;
-- No policies on purpose, same as public.orders.
