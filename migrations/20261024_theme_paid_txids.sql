-- One payment, one paid record. NOT RUN YET: the owner runs it, before the site deploy that ships site/lib/paidTxids.js
-- Without this table every theme claim fails with a 500 (fail closed).
-- Theme orders, theme purchases and theme deposits all pay THEME_ORDER_PAY_ADDRESS. Each claim records its txid here
-- first; txid is the primary key, so one tx can only ever be one paid record across all three tables.
-- Written only by the site server with the service role. RLS on with no policies: anon/authenticated can't read or write.
create table if not exists public.theme_paid_txids (
  txid text primary key check (txid ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('order', 'buy', 'deposit')),
  ref_id text not null,
  created_at timestamptz not null default now()
);
alter table public.theme_paid_txids enable row level security;

-- Backfill every txid already recorded as paid, so an old payment can't be claimed again in another system.
-- If one txid already sits in two tables, the first insert wins and the clash is listed by the select below.
insert into public.theme_paid_txids (txid, kind, ref_id)
  select txid, 'order', id::text from public.theme_orders where txid is not null
  on conflict (txid) do nothing;
insert into public.theme_paid_txids (txid, kind, ref_id)
  select txid, 'buy', id::text from public.theme_purchases where txid is not null
  on conflict (txid) do nothing;
insert into public.theme_paid_txids (txid, kind, ref_id)
  select txid, 'deposit', id::text from public.theme_deposits where txid is not null
  on conflict (txid) do nothing;

-- Any txid already used by more than one record (review these by hand):
select txid, count(*) from (
  select txid from public.theme_orders where txid is not null
  union all select txid from public.theme_purchases where txid is not null
  union all select txid from public.theme_deposits where txid is not null
) t group by txid having count(*) > 1;
