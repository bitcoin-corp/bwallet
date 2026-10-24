-- b_feedback 67: the owner's signature tying their ordinal-receive address to their identity key.
-- NOT RUN YET: the owner runs it. Until then registrations still work; ord answers just carry no proof
-- (payers see "not verified" for token sends), exactly as before.
-- Shape: {"ordAddress": "1...", "timestamp": "<ms>", "signature": "<hex>"}; written only by the site server.
alter table public.bwallet_paymail_aliases add column if not exists ord_proof jsonb;
