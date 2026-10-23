import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { P2PKH } from '@bsv/sdk';
import { type Bsv21Balance } from '@1sat/actions';
import { sendBsv } from '../../utils/guardedSendBsv';
import { ArrowLeft, Download, Gift, RotateCcw } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { normalize } from '../../utils/format';
import { getErrorMessage } from '../../utils/tools';
import { useBackClose } from '../backStack';
import { NoteField } from '../airdrops/NoteField';
import { bsvDropOutput, cleanNote, noteOutput, withExtraOutput } from '../airdrops/note';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { saveTextFile } from '../agents/saveText';
import { maxOverlayFee, withTokenSendGuard } from '../wallet/send/tokenFee';
import {
  DEFAULT_BATCH,
  MAX_BATCH,
  allocateFixed,
  allocateProRata,
  dropId,
  fetchHolders,
  filterHolders,
  formatUnits,
  interruptedBatch,
  isDone,
  makePlan,
  mergeLedger,
  nextBatch,
  normTokenId,
  parseAddressList,
  parsePlan,
  pendingBatches,
  planSummary,
  previewDrop,
  receiptCsv,
  recordBatch,
  sentCount,
  serializePlan,
  startBatch,
  type DropAsset,
  type DropPlan,
  type Holder,
  type SnapshotResult,
} from './holderDrop';
import { guardedSendBsv21 } from '../../services/tokenSpendGuard';

const STORE_KEY = 'bwx.holderdrop.';
const loadPlan = (account: string) => {
  try {
    return parsePlan(localStorage.getItem(STORE_KEY + account));
  } catch {
    return null;
  }
};
const savePlan = (account: string, plan: DropPlan | null) => {
  try {
    if (plan) localStorage.setItem(STORE_KEY + account, serializePlan(plan));
    else localStorage.removeItem(STORE_KEY + account);
  } catch {
    /* storage blocked: progress lives only in memory this session */
  }
};

// Per drop ID, every address already paid (holderDrop.ts mergeLedger): a rebuilt drop never pays anyone twice.
const LEDGER_KEY = 'bwx.holderdrop.paid.';
const loadLedger = (account: string): Record<string, string[]> => {
  try {
    const j = JSON.parse(localStorage.getItem(LEDGER_KEY + account) ?? '{}') as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, string[]>) : {};
  } catch {
    return {};
  }
};
const saveLedger = (account: string, plan: DropPlan) => {
  try {
    localStorage.setItem(LEDGER_KEY + account, JSON.stringify(mergeLedger(loadLedger(account), plan)));
  } catch {
    /* storage blocked: the plan itself still records which batches were sent */
  }
};

const toAtomic = (input: string, dec: number): bigint | null => {
  const t = input.trim();
  if (!t || !/^\d*\.?\d*$/.test(t) || t === '.') return null;
  try {
    const v = BigInt(normalize(t, dec));
    return v > 0n ? v : null;
  } catch {
    return null;
  }
};

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
const muted = '#98A2B3';
const card = { background: 'var(--bw-surface)', border: '1px solid #2b2f36' };
const input =
  'w-full min-w-0 rounded-lg bg-[#101114] border border-[#2b2f36] px-3 py-2 text-sm text-white outline-none';

/**
 * Airdrop to holders (issuer tools on the token page; bWalletX only, HOLDER_DROP_ENABLED). Snapshot a token's
 * holders, choose this token or another BSV-21 you hold, a fixed or pro-rata amount, preview, then ONE approval
 * sheet covers the whole drop; batches go out one transaction each after that tap. Progress and a per-drop ledger
 * of paid addresses are kept on the device, so an interrupted drop resumes without paying anyone twice.
 *
 * BSV drops (owner, 18 Oct 2026) always carry the airdrop marker (note.ts bsvDropOutput, naming the holders' token),
 * which is what makes a plain payment show in the recipient's Airdrops inbox (inbox.ts bsvDropItems); ordinary
 * payments carry none. They go to the holder's address as listed (often an ordinals address: there is no public
 * map from it to a pay address); bWalletX moves BSV found there into the balance with the Sweep (sweep/sweepKeys.ts).
 */
export default function HolderDropSheet({
  token,
  heldRaw,
  onClose,
}: {
  token: { id: string; dec: number; symbol: string };
  heldRaw: bigint;
  onClose: () => void;
}) {
  const { apiContext, chromeStorageService } = useServiceContext();
  useBackClose(true, onClose);
  const addrs = chromeStorageService.getCurrentAccountObject().account?.addresses;
  const account = addrs?.identityAddress ?? 'default';

  const [snapshotId, setSnapshotId] = useState(token.id);
  const [held, setHeld] = useState<Bsv21Balance[]>([]);
  const [assetId, setAssetId] = useState(normTokenId(token.id) ?? token.id);
  const [mode, setMode] = useState<'fixed' | 'prorata'>('fixed');
  const [amountIn, setAmountIn] = useState('');
  const [minIn, setMinIn] = useState('');
  const [blockIn, setBlockIn] = useState('');
  const [batchSize, setBatchSize] = useState(String(DEFAULT_BATCH));
  const [note, setNote] = useState('');
  const [snap, setSnap] = useState<{ id: string; raw: Holder[]; dec: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [fee, setFee] = useState<{ id: string; address?: string; sats: number } | { id: string; error: string } | null>(
    null,
  );
  const [plan, setPlan] = useState<DropPlan | null>(() => loadPlan(account));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Your other BSV-21 tokens (Quarantine excluded), so a drop can pay in a different token.
  useEffect(() => {
    heldBsv21Balances(apiContext)
      .then((bs) => setHeld(bs.filter((b) => !!normTokenId(b.id))))
      .catch(() => undefined);
  }, [apiContext]);

  const pageId = normTokenId(token.id) ?? token.id;
  const other = held.find((b) => normTokenId(b.id) === assetId);
  const asset: DropAsset =
    assetId === 'bsv'
      ? { kind: 'bsv' }
      : assetId === pageId || !other
        ? { kind: 'token', tokenId: token.id, dec: token.dec, symbol: token.symbol }
        : { kind: 'token', tokenId: other.id, dec: other.dec, symbol: other.sym || other.id.slice(0, 8) };
  // BSV: the wallet refuses a send it can't fund, so no balance check here.
  const assetHeld: bigint | null =
    asset.kind === 'bsv' ? null : assetId === pageId || !other ? heldRaw : other.all.confirmed;
  const assetDec = asset.kind === 'bsv' ? 8 : asset.dec;
  const assetKey = asset.kind === 'bsv' ? 'bsv' : asset.tokenId;
  const unit = asset.kind === 'bsv' ? 'BSV' : asset.symbol;
  const satsPerKb = chromeStorageService.getCustomFeeRate();

  // The indexer's per-output fee for the token being sent (sendBsv21 pays it in every batch). Fail closed: a drop
  // can't be planned until the token's details are read.
  // A saved plan pays in its own token, whatever is picked in the form.
  const feeTokenId = plan ? (plan.asset.kind === 'token' ? plan.asset.tokenId : 'bsv') : assetKey;
  useEffect(() => {
    const bsv21 = apiContext.services?.bsv21;
    const id = feeTokenId;
    if (id === 'bsv') return setFee({ id, sats: 0 });
    if (!bsv21) return setFee({ id, error: 'Token details are unavailable.' });
    setFee(null);
    bsv21
      .getTokenDetails(id, { fresh: true })
      .then((d) => setFee({ id, address: d.status?.fee_address, sats: d.status?.fee_per_output ?? 0 }))
      .catch((e) => setFee({ id, error: getErrorMessage(e) }));
  }, [apiContext.services, feeTokenId]);
  const feeOk = fee && fee.id === feeTokenId && !('error' in fee) ? fee : null;

  const takeSnapshot = async () => {
    const id = normTokenId(snapshotId);
    if (!id) return setMsg('Enter a BSV-21 token ID (txid_vout), not a ticker.');
    setLoading(true);
    setMsg('');
    try {
      const raw = await fetchHolders((u) => fetch(u), id);
      let dec = token.dec;
      if (id !== pageId) {
        // Holdings are shown and filtered in that token's units: unknown decimals stop the drop.
        const r = await fetch(`https://ordinals.gorillapool.io/api/bsv20/id/${id}`);
        const j = r.ok ? ((await r.json()) as { dec?: unknown }) : {};
        if (typeof j.dec !== 'number' || !Number.isInteger(j.dec) || j.dec < 0 || j.dec > 18)
          throw new Error('That token could not be read as a BSV-21 token, so nothing will be sent.');
        dec = j.dec;
      }
      setSnap({ id, raw, dec });
    } catch (e) {
      setSnap(null);
      setMsg(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const pasted = useMemo(() => parseAddressList(blockIn), [blockIn]);
  const minHolding = snap && minIn.trim() ? (toAtomic(minIn, snap.dec) ?? undefined) : undefined;
  const filtered: SnapshotResult | null = useMemo(() => {
    if (!snap) return null;
    return filterHolders(snap.raw, {
      exclude: [addrs?.ordAddress, addrs?.bsvAddress, addrs?.identityAddress].filter((a): a is string => !!a),
      block: [...pasted.addresses, ...(feeOk?.address ? [feeOk.address] : [])],
      minHolding,
    });
  }, [snap, minHolding, pasted, feeOk?.address, addrs?.ordAddress, addrs?.bsvAddress, addrs?.identityAddress]);

  const amount = toAtomic(amountIn, assetDec);
  const size = Math.max(1, Math.min(MAX_BATCH, parseInt(batchSize, 10) || DEFAULT_BATCH));
  const draft = useMemo(() => {
    if (!filtered || !amount || !feeOk) return null;
    try {
      const recipients =
        mode === 'fixed' ? allocateFixed(filtered.holders, amount) : allocateProRata(filtered.holders, amount, 1n);
      const preview = previewDrop(recipients, asset, { batchSize: size, satsPerKb, feePerOutput: feeOk.sats });
      return { recipients, preview };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, amount, mode, assetKey, size, satsPerKb, feeOk]);

  const overBalance = !!draft && assetHeld !== null && draft.preview.total > assetHeld;
  const noteBad = !!note.trim() && !cleanNote(note);

  const startDrop = () => {
    if (!draft || !snap || !amount || !draft.recipients.length) return;
    const id = dropId({ snapshotTokenId: snap.id, asset, mode, amount, minHolding });
    const p = makePlan({
      id,
      createdAt: Date.now(),
      snapshotTokenId: snap.id,
      asset,
      mode,
      note: cleanNote(note) ?? undefined,
      recipients: draft.recipients,
      batchSize: size,
      alreadyPaid: loadLedger(account)[id],
    });
    if (!p.batches.length) return setMsg('Every holder in this list was already paid by this airdrop.');
    setPlan(p);
    savePlan(account, p);
    setConfirming(true);
  };

  const update = (p: DropPlan) => {
    setPlan(p);
    savePlan(account, p);
    saveLedger(account, p);
  };

  /** After the one approval: send every pending batch in order, stopping at the first failure. */
  const sendAll = async () => {
    if (!plan) return;
    setConfirming(false);
    setBusy(true);
    setMsg('');
    let p = plan;
    const a = plan.asset;
    for (const i of pendingBatches(plan)) {
      const b = p.batches[i];
      p = startBatch(p, i);
      update(p);
      try {
        let res: { txid?: string; error?: string };
        if (a.kind === 'bsv') {
          // Always marked, so it shows in the holders' Airdrops inbox and nowhere else looks like an airdrop.
          const wallet = withExtraOutput(apiContext.wallet, bsvDropOutput(p.note, p.snapshotTokenId));
          res = await sendBsv.execute(
            { ...apiContext, wallet },
            { requests: b.recipients.map((r) => ({ address: r.address, satoshis: Number(r.amount) })) },
          );
        } else {
          const f = feeOk ? maxOverlayFee(feeOk.address, feeOk.sats, b.recipients.length) : null;
          const guarded = withTokenSendGuard(
            apiContext.wallet,
            f ? { feeScript: new P2PKH().lock(f.address).toHex(), maxSats: f.sats } : null,
          );
          const wallet = p.note ? withExtraOutput(guarded, noteOutput(p.note, a.tokenId)) : guarded;
          res = await guardedSendBsv21.execute(
            { ...apiContext, wallet },
            {
              tokenId: a.tokenId,
              recipients: b.recipients.map((r) => ({ amount: r.amount, destination: { address: r.address } })),
            },
          );
        }
        p =
          res.txid && !res.error
            ? recordBatch(p, i, { txid: res.txid })
            : recordBatch(p, i, { error: getErrorMessage(res.error) });
        update(p);
        if (!res.txid || res.error) {
          setMsg(`Batch ${i + 1} was not sent: ${getErrorMessage(res.error)} The rest are waiting.`);
          break;
        }
      } catch (e) {
        // A throw can come after the broadcast: leave it marked as started so the issuer checks History first.
        setMsg(`Batch ${i + 1}: ${getErrorMessage(e)} It may have been sent; check History before sending it again.`);
        break;
      }
    }
    setBusy(false);
  };

  const exportCsv = () =>
    plan &&
    void saveTextFile(
      `bwalletx-airdrop-${plan.snapshotTokenId.slice(0, 8)}-${new Date(plan.createdAt).toISOString().slice(0, 10)}.csv`,
      receiptCsv(plan, snap?.id === plan.snapshotTokenId ? snap.dec : token.dec),
      'text/csv;charset=utf-8',
    );

  const stuck = plan ? interruptedBatch(plan) : -1;
  const planDec = plan?.asset.kind === 'token' ? plan.asset.dec : 8;
  const planUnit = plan?.asset.kind === 'token' ? plan.asset.symbol : 'BSV';
  const planTotal = plan ? plan.batches.reduce((s, b) => s + b.recipients.reduce((t, r) => t + r.amount, 0n), 0n) : 0n;
  const planCount = plan ? plan.batches.reduce((n, b) => n + b.recipients.length, 0) : 0;
  const summary = plan ? planSummary(plan) : null;
  const summaryFees =
    plan && summary
      ? previewDrop(summary.recipients, plan.asset, {
          // The plan's own batch size (the field may have changed since it was built).
          batchSize: Math.max(1, ...plan.batches.map((b) => b.recipients.length)),
          satsPerKb,
          feePerOutput: feeOk?.sats ?? 0,
        })
      : null;

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col overflow-y-auto" style={{ background: 'var(--bw-bg)' }}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button type="button" onClick={onClose} className="bg-transparent border-0 p-1 cursor-pointer text-white">
          <ArrowLeft size={20} />
        </button>
        <Gift size={18} style={{ color: 'var(--bw-accent)' }} />
        <h2 className="text-base font-bold m-0 text-white">Airdrop to holders</h2>
      </div>

      <div className="flex flex-col gap-3 px-4 pb-10">
        {plan ? (
          <div className="flex flex-col gap-3 rounded-2xl p-4" style={card}>
            <p className="text-sm text-white m-0">
              {formatUnits(planTotal, planDec)} {planUnit} to {planCount} holders of {short(plan.snapshotTokenId)} in{' '}
              {plan.batches.length} batch{plan.batches.length === 1 ? '' : 'es'}.
            </p>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: '#2b2f36' }}>
              <div
                className="h-full"
                style={{
                  width: `${(sentCount(plan) / Math.max(1, planCount)) * 100}%`,
                  background: 'var(--bw-accent)',
                }}
              />
            </div>
            <p className="text-xs m-0" style={{ color: muted }}>
              Sent to {sentCount(plan)} of {planCount}.
            </p>
            {plan.batches.map((b, i) => (
              <div key={i} className="flex items-center justify-between text-xs" style={{ color: muted }}>
                <span>
                  Batch {i + 1} · {b.recipients.length} holders
                </span>
                <span style={{ color: b.txid ? '#75E0A7' : b.error || b.started ? '#FDA29B' : muted }}>
                  {b.txid
                    ? short(b.txid)
                    : b.started
                      ? busy
                        ? 'sending…'
                        : 'interrupted'
                      : b.error
                        ? 'failed'
                        : 'waiting'}
                </span>
              </div>
            ))}
            {stuck >= 0 && !busy && (
              <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: '#2a1414' }}>
                <p className="text-xs m-0" style={{ color: '#FDA29B' }}>
                  Batch {stuck + 1} was interrupted and may have been sent. Check History before you send it again.
                </p>
                <button
                  type="button"
                  className="self-start rounded-lg px-3 py-1.5 text-xs font-bold border-0 cursor-pointer"
                  style={{ background: '#3a1f1f', color: '#FDA29B' }}
                  onClick={() => update(recordBatch(plan, stuck, { error: 'Interrupted' }))}
                >
                  It was not sent, let me retry
                </button>
              </div>
            )}
            {msg && (
              <p className="text-xs m-0" style={{ color: '#FDA29B' }}>
                {msg}
              </p>
            )}
            {!isDone(plan) && stuck < 0 && !busy && (
              <button
                type="button"
                disabled={!feeOk}
                onClick={() => setConfirming(true)}
                className="rounded-xl py-3 text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
                style={{ background: 'var(--bw-accent)', color: '#000' }}
              >
                {sentCount(plan) ? `Review and send the rest (from batch ${nextBatch(plan) + 1})` : 'Review airdrop'}
              </button>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={exportCsv}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold border-0 cursor-pointer"
                style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: 'var(--bw-accent)' }}
              >
                <Download size={14} /> Receipt (CSV)
              </button>
              {(isDone(plan) || !sentCount(plan)) && !busy && stuck < 0 && (
                <button
                  type="button"
                  onClick={() => {
                    savePlan(account, null);
                    setPlan(null);
                    setMsg('');
                  }}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold border-0 cursor-pointer"
                  style={{ background: '#1d2026', color: muted }}
                >
                  <RotateCcw size={14} /> {isDone(plan) ? 'New airdrop' : 'Discard'}
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2 rounded-2xl p-4" style={card}>
              <label className="text-xs" style={{ color: muted }}>
                Holders of (token ID)
              </label>
              <input
                className={input}
                value={snapshotId}
                onChange={(e) => {
                  setSnapshotId(e.target.value);
                  setSnap(null);
                }}
                spellCheck={false}
              />
              <button
                type="button"
                disabled={loading}
                onClick={() => void takeSnapshot()}
                className="rounded-lg py-2 text-sm font-bold border-0 cursor-pointer"
                style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: 'var(--bw-accent)' }}
              >
                {loading ? 'Loading holders…' : snap ? 'Refresh holders' : 'Load holders'}
              </button>
              {filtered && (
                <p className="text-xs m-0" style={{ color: muted }}>
                  {filtered.holders.length} holders. Left out: you ({filtered.skipped.sender}), burn addresses (
                  {filtered.skipped.burn}), indexer and listed addresses ({filtered.skipped.blocked}), below the minimum
                  ({filtered.skipped.belowMin}), unreadable ({filtered.skipped.invalid + filtered.skipped.empty}
                  ).
                </p>
              )}
              <label className="text-xs" style={{ color: muted }}>
                Minimum holding (optional)
              </label>
              <input className={input} inputMode="decimal" value={minIn} onChange={(e) => setMinIn(e.target.value)} />
              <label className="text-xs" style={{ color: muted }}>
                Also leave out (exchange or market addresses, optional)
              </label>
              <textarea
                className={input}
                rows={2}
                value={blockIn}
                onChange={(e) => setBlockIn(e.target.value)}
                spellCheck={false}
              />
              {!!pasted.bad.length && (
                <p className="text-xs m-0" style={{ color: '#FDA29B' }}>
                  Not addresses: {pasted.bad.slice(0, 3).join(', ')}
                  {pasted.bad.length > 3 ? '…' : ''}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2 rounded-2xl p-4" style={card}>
              <label className="text-xs" style={{ color: muted }}>
                Token to send
              </label>
              <select className={input} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value={pageId}>{token.symbol} (this token)</option>
                <option value="bsv">BSV</option>
                {held
                  .filter((b) => normTokenId(b.id) !== pageId)
                  .map((b) => (
                    <option key={b.id} value={normTokenId(b.id) ?? b.id}>
                      {b.sym || short(b.id)} · you hold {formatUnits(b.all.confirmed, b.dec)}
                    </option>
                  ))}
              </select>
              <div className="flex gap-2">
                {(
                  [
                    ['fixed', 'Same amount each'],
                    ['prorata', 'Split by holdings'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setMode(k)}
                    className="flex-1 rounded-lg py-2 text-xs font-bold border-0 cursor-pointer"
                    style={
                      mode === k
                        ? { background: 'var(--bw-accent)', color: '#000' }
                        : { background: '#1d2026', color: muted }
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="text-xs" style={{ color: muted }}>
                {mode === 'fixed' ? `${unit} each` : `Total ${unit} to split`}
              </label>
              <input
                className={input}
                inputMode="decimal"
                value={amountIn}
                onChange={(e) => setAmountIn(e.target.value)}
              />
              <label className="text-xs" style={{ color: muted }}>
                Holders per transaction (1–{MAX_BATCH})
              </label>
              <input
                className={input}
                inputMode="numeric"
                value={batchSize}
                onChange={(e) => setBatchSize(e.target.value)}
              />
              <NoteField value={note} onChange={setNote} />
              {fee && 'error' in fee && fee.id === assetKey && (
                <p className="text-xs m-0" style={{ color: '#FDA29B' }}>
                  This token&apos;s details could not be read ({fee.error}), so it can&apos;t be airdropped right now.
                </p>
              )}
            </div>

            {draft && (
              <div className="flex flex-col gap-1 rounded-2xl p-4" style={card}>
                <p className="text-sm text-white m-0">
                  {formatUnits(draft.preview.total, assetDec)} {unit} to {draft.preview.holders} holders
                </p>
                <p className="text-xs m-0" style={{ color: muted }}>
                  {draft.preview.batches} transaction{draft.preview.batches === 1 ? '' : 's'} · network fee about{' '}
                  {draft.preview.minerFee} sats
                  {draft.preview.indexerFee ? ` · indexer fee up to ${draft.preview.indexerFee} sats` : ''}
                </p>
                <p className="text-xs m-0" style={{ color: muted }}>
                  Total leaving your wallet:{' '}
                  {asset.kind === 'bsv' ? '' : `${formatUnits(draft.preview.total, assetDec)} ${unit} + `}
                  {formatUnits(draft.preview.satsOut, 8)} BSV
                </p>
                <div className="flex flex-col gap-0.5 mt-1 max-h-40 overflow-y-auto">
                  {draft.recipients.slice(0, 50).map((r) => (
                    <div key={r.address} className="flex justify-between text-[11px]" style={{ color: muted }}>
                      <span>{short(r.address)}</span>
                      <span>
                        {formatUnits(r.amount, assetDec)} {unit}
                      </span>
                    </div>
                  ))}
                  {draft.recipients.length > 50 && (
                    <span className="text-[11px]" style={{ color: muted }}>
                      and {draft.recipients.length - 50} more (all in the CSV receipt)
                    </span>
                  )}
                </div>
                {overBalance && (
                  <p className="text-xs m-0" style={{ color: '#FDA29B' }}>
                    You hold {formatUnits(assetHeld ?? 0n, assetDec)} {unit}, less than this airdrop.
                  </p>
                )}
                {mode === 'prorata' && filtered && draft.preview.holders < filtered.holders.length && (
                  <p className="text-xs m-0" style={{ color: muted }}>
                    {filtered.holders.length - draft.preview.holders} small holders would get less than 1 unit and are
                    left out.
                  </p>
                )}
              </div>
            )}
            {msg && (
              <p className="text-xs m-0" style={{ color: '#FDA29B' }}>
                {msg}
              </p>
            )}
            <button
              type="button"
              disabled={!draft || !draft.recipients.length || overBalance || noteBad || !!pasted.bad.length}
              onClick={startDrop}
              className="rounded-xl py-3 text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
              style={{ background: 'var(--bw-accent)', color: '#000' }}
            >
              Review airdrop
            </button>
          </>
        )}
      </div>

      {confirming && plan && summary && summaryFees && (
        <div className="fixed inset-0 z-[410] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div
            className="w-full max-w-md flex flex-col gap-3 rounded-t-3xl p-5"
            style={{ background: 'var(--bw-surface)', borderTop: '1px solid #2b2f36' }}
          >
            <div className="flex flex-col items-center gap-1 rounded-2xl py-5" style={{ background: '#101114' }}>
              <Gift size={28} style={{ color: 'var(--bw-accent)' }} />
              <p className="text-2xl font-bold text-white m-0">
                {formatUnits(summary.total, planDec)} {planUnit}
              </p>
              <p className="text-sm m-0" style={{ color: muted }}>
                to {summary.holders} holders of {short(plan.snapshotTokenId)}
              </p>
            </div>
            <div className="flex flex-col gap-1 text-xs" style={{ color: muted }}>
              <div className="flex justify-between">
                <span>Each holder gets</span>
                <span className="text-white">
                  {summary.min === summary.max
                    ? `${formatUnits(summary.min, planDec)} ${planUnit}`
                    : `${formatUnits(summary.min, planDec)}–${formatUnits(summary.max, planDec)} ${planUnit} (by holdings)`}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Transactions</span>
                <span className="text-white">{summary.batches}</span>
              </div>
              <div className="flex justify-between">
                <span>Network fee (about)</span>
                <span className="text-white">{summaryFees.minerFee} sats</span>
              </div>
              {!!summaryFees.indexerFee && (
                <div className="flex justify-between">
                  <span>Indexer fee (up to)</span>
                  <span className="text-white">{summaryFees.indexerFee} sats</span>
                </div>
              )}
              <div className="flex justify-between font-bold">
                <span>Total from your balance (up to)</span>
                <span className="text-white">{formatUnits(summaryFees.satsOut, 8)} BSV</span>
              </div>
              {plan.note && (
                <div className="flex justify-between gap-3">
                  <span>Note</span>
                  <span className="text-white text-right break-words min-w-0">{plan.note}</span>
                </div>
              )}
            </div>
            <p className="text-[11px] m-0" style={{ color: muted }}>
              Holders find it in their Airdrops inbox. Anyone already paid by this airdrop is skipped.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="flex-1 rounded-xl py-3 text-sm font-bold border-0 cursor-pointer"
                style={{ background: '#1d2026', color: muted }}
              >
                Not now
              </button>
              <button
                type="button"
                disabled={busy || !feeOk}
                onClick={() => void sendAll()}
                className="flex-1 rounded-xl py-3 text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
                style={{ background: 'var(--bw-accent)', color: '#000' }}
              >
                Send airdrop
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
