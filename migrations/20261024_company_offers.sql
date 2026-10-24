-- Company share offers paid by signature (site/lib/offerReceipts.js, phase 1).
--   company_offers         one row per sealed offer, registered by the company paymail's own key
--   subscription_receipts  one row per offer payment received; INSERT ONLY (allotment stays null in the record)
-- No private keys, no document bodies: references, hashes, txids, public keys, amounts.
--
-- Apply (owner, not automated). Review first, then:
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < migrations/20261024_company_offers.sql
--
-- The company alias itself is a reserved paymail name, so it is provisioned by hand, AFTER this file, with the
-- company identity PUBLIC key passed in at run time (never written into git):
--   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v alias=bcorp -v key=<company identity public key>" <<'SQL'
--   insert into public.bwallet_paymail_aliases (alias, identity_key, display_name)
--     values (:'alias', :'key', null)
--     on conflict (alias) do update set identity_key = excluded.identity_key, updated_at = now();
--   SQL
-- and the site env PAYMAIL_COMPANIES set in Vercel (name, number, director identity public keys).
begin;

create table if not exists public.company_offers (
  ref text primary key check (ref ~ '^[A-Z0-9][A-Z0-9-]{3,63}$'),
  alias citext not null references public.bwallet_paymail_aliases(alias) on delete restrict on update cascade,
  company_key text not null check (company_key ~ '^0[23][0-9a-f]{64}$'),
  amount_usd numeric(12, 2) not null check (amount_usd > 0),
  expires timestamptz not null,
  seal_hash text not null check (seal_hash ~ '^[0-9a-f]{64}$'),
  seal_txid text not null check (seal_txid ~ '^[0-9a-f]{64}$'),
  offeree_key text not null check (offeree_key ~ '^0[23][0-9a-f]{64}$'),
  offeree_handle text check (offeree_handle is null or char_length(offeree_handle) <= 64),
  director_key text not null check (director_key ~ '^0[23][0-9a-f]{64}$'),
  director_handle text check (director_handle is null or char_length(director_handle) <= 64),
  created_at timestamptz not null default now()
);

create table if not exists public.subscription_receipts (
  txid text primary key check (txid ~ '^[0-9a-f]{64}$'),
  ref text not null references public.company_offers(ref) on delete restrict,
  alias citext not null,
  status text not null check (status in ('received_pending_allotment', 'received_shortfall', 'received_after_lapse')),
  -- The full template §B record. The wallet/server never set record->'allotment'; the records session does,
  -- after a board minute, by hand.
  record jsonb not null check (record ? 'allotment'),
  created_at timestamptz not null default now()
);
create index if not exists subscription_receipts_alias_created on public.subscription_receipts (alias, created_at desc);
create index if not exists subscription_receipts_ref on public.subscription_receipts (ref);

alter table public.company_offers enable row level security;
alter table public.subscription_receipts enable row level security;
revoke all on public.company_offers from anon, authenticated;
revoke all on public.subscription_receipts from anon, authenticated;
grant select, insert, update on public.company_offers to service_role;
-- Insert + read only for the server: a receipt is never edited or deleted by code.
grant select, insert on public.subscription_receipts to service_role;
commit;
notify pgrst, 'reload schema';
