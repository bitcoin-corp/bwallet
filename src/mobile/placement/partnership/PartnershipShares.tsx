/**
 * Lock page › Vault › Partnership shares: each partnership the viewer is in, their locked holding, and any move
 * waiting for their signature. Every button is one wallet approval sheet. Never in a store build (lazy, via
 * VaultSection, PLACEMENT_ENABLED).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Transaction } from '@bsv/sdk';
import { Lock } from 'lucide-react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { ChatApiError, defaultHttp, loadSession } from '../../chat/api';
import { isNative } from '../../native';
import { BsharesApi } from '../api';
import { identityKey } from '../company';
import { PartnershipAgreement, PartnershipSetup } from './PartnershipAgreement';
import { broadcastProposal, lockUp, partnerKey, proposeMove, signProposal } from './actions';
import { PARTNER_SIGN_PROTOCOL, lockKeyKeyID, lockKeyMessage, type PartnerLockState } from './lockState';
import {
  RULE_WARNING,
  describeProposalMoves,
  proposalMoveProblem,
  isReady,
  parsePartnerLock,
  partnershipLabel,
  signedBy,
  type Holding,
} from './partnerLock';
import { ApprovalCard } from './ApprovalCard';
import { SharedAccount } from './SharedAccount';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const btn = 'self-start rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer disabled:opacity-50';
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
const newId = () => hex(Array.from(crypto.getRandomValues(new Uint8Array(12))));

// Share moves this partner declined: hidden on this device (with a majority rule the others can still go ahead).
const DECLINED = 'bwx.partnership.declined';
const declined = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(DECLINED) ?? '[]') as string[];
  } catch {
    return [];
  }
};
const decline = (id: string) => {
  try {
    localStorage.setItem(DECLINED, JSON.stringify([...declined(), id].slice(-200)));
  } catch {
    /* private mode */
  }
};

function Partnership({ api, ticker, name }: { api: BsharesApi; ticker: string; name: string }) {
  const { apiContext: ctx } = useServiceContext();
  const [s, setS] = useState<PartnerLockState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [amt, setAmt] = useState('');
  const [hidden, setHidden] = useState<string[]>(declined);
  const reload = useCallback(async () => setS(await api.partnerLock(ticker).catch(() => null)), [api, ticker]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const run = (f: () => Promise<string | void>) => async () => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg((await f()) || null);
      await reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };
  const ks = s?.keyset ?? null;
  // Canonical (sorted) keys: every partner must build the identical shared account script.
  const accountKeyset = useMemo(
    () => (ks?.complete ? { m: ks.m, pubKeys: [...ks.pubKeys].map((k) => k.toLowerCase()).sort() } : null),
    [ks?.complete, ks?.m, ks?.pubKeys],
  );
  if (!s) return null;
  const handleOf = (k: string) => {
    const h = s.keys.find((x) => x.partnerKey.toLowerCase() === k.toLowerCase())?.handle;
    return h ? `$${h}` : `${k.slice(0, 8)}…`;
  };
  const mine = s.holdings.filter((h) => h.holder === s.myKey);
  const myTotal = mine.reduce((t, h) => t + BigInt(h.amt), 0n);
  const keysetOf = () => ({ m: ks!.m, pubKeys: ks!.pubKeys });

  const addKey = run(async () => {
    const [pk, idKey] = await Promise.all([partnerKey(ctx, s.partnershipId), identityKey(ctx)]);
    const at = new Date().toISOString();
    const handle = loadSession()?.handle ?? '';
    const { signature } = await ctx.wallet.createSignature({
      protocolID: PARTNER_SIGN_PROTOCOL,
      keyID: lockKeyKeyID(s.partnershipId),
      counterparty: 'anyone',
      data: Array.from(
        new TextEncoder().encode(lockKeyMessage({ roomId: s.partnershipId, handle, partnerKey: pk, at })),
      ),
    });
    await api.partnerLockAction(ticker, {
      action: 'key',
      partnerKey: pk,
      identityKey: idKey,
      at,
      signature: hex(signature),
    });
    return 'Your lock key is recorded.';
  });

  const lockMine = run(async () => {
    if (!s.tokenId || !s.supply || !s.myShareBps || !s.myKey) throw new Error('This room has no token to lock yet');
    const amount = (BigInt(s.supply) * BigInt(s.myShareBps)) / 10_000n;
    const r = await lockUp(ctx, { tokenId: s.tokenId, amt: amount, keyset: keysetOf(), myKey: s.myKey });
    await api.partnerLockAction(ticker, {
      action: 'holding',
      outpoint: r.outpoint,
      rawTx: r.rawTx,
      holder: s.myKey,
      amt: amount.toString(),
    });
    return `${partnershipLabel(amount)}.`;
  });

  const proposeSend = run(async () => {
    const dest = s.keys.find((k) => k.handle === to.replace(/^\$/, ''));
    if (!dest) throw new Error('Choose one of your partners');
    if (!/^\d+$/.test(amt) || BigInt(amt) <= 0n || BigInt(amt) > myTotal) throw new Error(`Up to ${myTotal} shares`);
    // M comes from the signed agreement (server keyset), never from us: every locked input must already sit
    // under exactly the agreement's keyset, or the mailbox refuses the proposal (409).
    const want = [...ks!.pubKeys].sort().join();
    for (const h of mine) {
      const vout = Number(h.outpoint.split('.')[1]);
      const lock = parsePartnerLock(Transaction.fromHex(h.rawTx).outputs[vout].lockingScript);
      if (!lock || lock.m !== ks!.m || [...lock.pubKeys].sort().join() !== want)
        throw new Error(
          'Your locked shares are under an older partner key set. They need re-locking under the current agreement first.',
        );
    }
    const n = BigInt(amt);
    const outputs: Holding[] = [{ tokenId: s.tokenId!, amt: n, holder: dest.partnerKey }];
    if (myTotal - n > 0n) outputs.push({ tokenId: s.tokenId!, amt: myTotal - n, holder: s.myKey! });
    const p = await proposeMove(ctx, {
      partnershipId: s.partnershipId,
      agreementVersion: s.agreementVersion!,
      proposalId: newId(),
      kind: 'transfer',
      summary: `Send ${n.toLocaleString('en-GB')} shares to $${dest.handle}`,
      inputs: mine.map((h) => ({ sourceTx: Transaction.fromHex(h.rawTx), vout: Number(h.outpoint.split('.')[1]) })),
      outputs,
      keyset: keysetOf(),
    });
    await api.partnerLockAction(ticker, { action: 'propose', proposal: p });
    setAmt('');
    return 'Proposed. Your partners will see “Signature needed”. Sign it too.';
  });

  return (
    <div className="flex flex-col gap-2 border-t border-[#2b2f36] pt-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-white font-bold">{name}</span>
        <span
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
          style={{ background: '#2a2100', color: GOLD }}
        >
          <Lock size={10} aria-hidden="true" /> Restricted · not for sale
        </span>
      </div>
      <PartnershipAgreement api={api} ticker={ticker} />
      {myTotal > 0n && <div className="text-sm text-white">{partnershipLabel(myTotal)}</div>}
      {ks && (
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          Moves only with {ks.m} of {ks.pubKeys.length || s.keys.length} partners’ signatures. Profits still pay
          straight to your wallet.
        </p>
      )}
      {s.rule && (
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          {RULE_WARNING[s.rule.kind]}
        </p>
      )}
      {!s.myKey && (
        <button
          type="button"
          disabled={busy}
          onClick={addKey}
          className={btn}
          style={{ background: GOLD, color: '#1a1300' }}
        >
          Add my lock key
        </button>
      )}
      {s.myKey && ks && !ks.complete && (
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          Waiting for every partner to add their lock key.
        </p>
      )}
      {s.myKey && ks?.complete && myTotal === 0n && (
        <button
          type="button"
          disabled={busy}
          onClick={lockMine}
          className={btn}
          style={{ background: GOLD, color: '#1a1300' }}
        >
          Lock my shares
        </button>
      )}
      {s.proposals
        .filter((p) => !hidden.includes(p.id))
        .map((p) => {
          const ready = isReady(p.proposal);
          const signed = signedBy(p.proposal);
          const allKeys = [...new Set(p.proposal.locked.flatMap((l) => l.pubKeys))];
          const need = p.proposal.locked[0]?.m ?? 0;
          const mine = p.proposedBy === (loadSession()?.handle ?? '');
          // What the transaction really does, decoded from its outputs; the summary is only the proposer's note.
          let problem: string | null;
          let movesText = '';
          try {
            const d = describeProposalMoves(p.proposal);
            problem = proposalMoveProblem(d);
            movesText = d.moves.map((m) => `${partnershipLabel(m.amt)} → ${handleOf(m.holder)}`).join(', ');
          } catch {
            problem = 'This move could not be read. Not signed.';
          }
          return (
            <ApprovalCard
              key={p.id}
              what={
                problem
                  ? `${problem} · proposed by $${p.proposedBy}`
                  : `${movesText} · proposed by $${p.proposedBy} (their note: “${p.summary}”)`
              }
              rule={`Needs ${need} of ${allKeys.length} partners`}
              signed={signed.map(handleOf)}
              waiting={allKeys.filter((k) => !signed.includes(k)).map(handleOf)}
              status={p.signatureNeeded ? 'needs-you' : ready ? 'ready' : 'waiting'}
              busy={busy}
              onApprove={
                p.signatureNeeded && !problem
                  ? run(async () => {
                      const signedP = await signProposal(ctx, p.proposal);
                      try {
                        await api.partnerLockAction(ticker, { action: 'sign', id: p.id, sigs: signedP.sigs });
                      } catch (e) {
                        if (e instanceof ChatApiError && e.status === 409)
                          throw new Error('A partner signed at the same moment. Reloaded: tap Approve again.');
                        throw e;
                      }
                      return 'Approved.';
                    })
                  : undefined
              }
              onSend={
                ready
                  ? run(async () => {
                      // Broadcast FIRST (the wallet, not the server), then report the txid; the server checks it on chain.
                      const { txid, rawTx } = await broadcastProposal(p.proposal);
                      try {
                        await api.reportBroadcast(ticker, p.id, txid);
                      } catch (e) {
                        const why = e instanceof Error ? e.message : 'not recorded';
                        return `Sent to the network (${txid.slice(0, 12)}…), but the record did not update: ${why}`;
                      }
                      const tx = Transaction.fromHex(rawTx);
                      for (const [vout, o] of tx.outputs.entries()) {
                        const h = parsePartnerLock(o.lockingScript);
                        if (h)
                          await api.partnerLockAction(ticker, {
                            action: 'holding',
                            outpoint: `${txid}.${vout}`,
                            rawTx,
                            holder: h.holder,
                            amt: h.amt.toString(),
                          });
                      }
                      return 'Sent.';
                    })
                  : undefined
              }
              onDecline={
                mine
                  ? run(async () => {
                      await api.partnerLockAction(ticker, { action: 'withdraw', id: p.id });
                      return 'Withdrawn.';
                    })
                  : () => {
                      decline(p.id);
                      setHidden(declined());
                      setMsg('Declined on this device. With a majority rule, the others can still go ahead.');
                    }
              }
            />
          );
        })}
      {s.myKey && accountKeyset && (
        <SharedAccount
          api={api}
          ticker={ticker}
          partnershipId={s.partnershipId}
          keyset={accountKeyset}
          keys={s.keys.map((k) => ({ handle: k.handle, partnerKey: k.partnerKey.toLowerCase() }))}
          myKey={s.myKey.toLowerCase()}
        />
      )}
      {myTotal > 0n && ks?.complete && (
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-lg bg-[#101216] text-white text-sm px-2 py-1 border border-[#2b2f36]"
            aria-label="Partner"
          >
            <option value="">Send to partner…</option>
            {s.keys
              .filter((k) => k.partnerKey !== s.myKey)
              .map((k) => (
                <option key={k.handle} value={k.handle}>
                  ${k.handle}
                </option>
              ))}
          </select>
          <input
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
            inputMode="numeric"
            placeholder="Shares"
            aria-label="Shares"
            className="w-24 rounded-lg bg-[#101216] text-white text-sm px-2 py-1 border border-[#2b2f36]"
          />
          <button
            type="button"
            disabled={busy || !to || !amt}
            onClick={proposeSend}
            className={btn}
            style={{ background: '#2b2f36', color: '#fff' }}
          >
            Propose
          </button>
        </div>
      )}
      {msg && (
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          {msg}
        </p>
      )}
    </div>
  );
}

export const PartnershipShares = () => {
  const api = useMemo(() => new BsharesApi(defaultHttp(isNative), loadSession()), []);
  const [list, setList] = useState<{ ticker: string; name: string }[]>([]);
  const load = useCallback(
    () =>
      api
        .myPartnerships()
        .then((r) => setList(r.partnerships))
        .catch(() => setList([])),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // A just-proposed draft may not be listed until it is signed: show it straight away.
  const onProposed = (ticker: string) =>
    setList((l) => (l.some((p) => p.ticker === ticker) ? l : [...l, { ticker, name: `$${ticker}` }]));
  return (
    <section
      className="mx-4 rounded-2xl bg-[#17191E] border border-[#2b2f36] p-4 flex flex-col gap-2"
      aria-label="Partnership shares"
    >
      <div className="flex items-center gap-2 text-white font-bold">
        <Lock size={16} color={GOLD} aria-hidden="true" /> Partnership shares
      </div>
      {list.map((p) => (
        <Partnership key={p.ticker} api={api} ticker={p.ticker} name={p.name} />
      ))}
      <PartnershipSetup api={api} onProposed={onProposed} />
    </section>
  );
};

export default PartnershipShares;
