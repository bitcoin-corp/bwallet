'use strict';
// One payment, one paid record. Theme orders, theme purchases and theme deposits all pay THEME_ORDER_PAY_ADDRESS,
// so each claim first records its txid here (public.theme_paid_txids, txid is the primary key). A txid already
// recorded for a different kind or row is refused, whichever of the three systems recorded it first.
// The same kind + row may record it again: that is a retry of a claim that went through (or failed to broadcast).

const KINDS = new Set(['order', 'buy', 'deposit']);

/** Supabase (PostgREST) ledger. `reserve` returns 'ok' when this kind + row holds the txid, else 'used'. */
function paidTxidStore(env = process.env, f = fetch) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const q = encodeURIComponent;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const holder = async (txid) => {
    const r = await f(`${url}/rest/v1/theme_paid_txids?txid=eq.${q(txid)}&select=kind,ref_id&limit=1`, { headers });
    if (!r.ok) throw new Error(`supabase ${r.status}`);
    return (await r.json())?.[0] ?? null;
  };
  return {
    reserve: async (txid, kind, refId) => {
      if (!KINDS.has(kind)) throw new Error('kind');
      const r = await f(`${url}/rest/v1/theme_paid_txids`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ txid, kind, ref_id: String(refId) }),
      });
      if (r.ok) return 'ok';
      if (r.status !== 409) throw new Error(`supabase ${r.status}`);
      const h = await holder(txid);
      return h && h.kind === kind && h.ref_id === String(refId) ? 'ok' : 'used';
    },
  };
}

/** In-memory ledger with the same contract (tests, and one ledger shared by all three handler sets). */
function memoryPaidTxids() {
  const m = new Map();
  return {
    rows: m,
    reserve: async (txid, kind, refId) => {
      if (!KINDS.has(kind)) throw new Error('kind');
      const h = m.get(txid);
      if (!h) {
        m.set(txid, { kind, ref_id: String(refId) });
        return 'ok';
      }
      return h.kind === kind && h.ref_id === String(refId) ? 'ok' : 'used';
    },
  };
}

module.exports = { paidTxidStore, memoryPaidTxids };
