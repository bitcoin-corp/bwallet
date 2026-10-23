/**
 * Commission card in the room stream, and the composer sheet behind /commission (chat/commissions.ts).
 *
 * Every button is one wallet approval and runs only on a tap. Locking the reward, signing the terms, accepting a
 * delivery and broadcasting a settlement all happen in this wallet (locks/tokenEscrowApi.ts); bit-sign only carries
 * the signatures. The room arbiter co-signs by rule from its own wallet.
 */
import { useCallback, useEffect, useState } from 'react';
import type { OneSatContext } from '@1sat/actions';
import type { BchatClient } from './api';
import {
  cardAction,
  deadlineText,
  parseRewardAmount,
  sha256Hex,
  sha256Text,
  statusLabel,
  type CommissionDetail,
} from './commissions';
import { acceptRelease, broadcastSettlement, escrowPubKey, fundEscrow, signTerms } from '../locks/tokenEscrowApi';
import { partnerAddress } from '../placement/partnership/actions';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#8a8f98';
const LINE = '#1f2127';
const INPUT_BG = '#0B0C0F';
const base = (ticker: string) => `/api/bitsign/rooms/${encodeURIComponent(ticker.replace(/^\$/, ''))}/commissions`;
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

const Btn = ({ children, onClick, busy }: { children: React.ReactNode; onClick: () => void; busy?: boolean }) => (
  <button
    type="button"
    disabled={busy}
    onClick={onClick}
    className="text-[13px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
    style={{ background: GOLD, color: '#000' }}
  >
    {busy ? 'Working…' : children}
  </button>
);

export function CommissionCard({
  no,
  ticker,
  me,
  client,
  ctx,
  onChanged,
}: {
  no: number;
  ticker: string;
  me: string;
  client: BchatClient;
  ctx: OneSatContext;
  onChanged: () => void;
}) {
  const [d, setD] = useState<CommissionDetail | null>(null);
  const [height, setHeight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showTerms, setShowTerms] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState('');

  const load = useCallback(() => {
    client
      .request('GET', `${base(ticker)}/${no}`)
      .then((x) => setD(x as CommissionDetail))
      .catch(() => setD(null));
    ctx.services?.chaintracks
      .currentHeight()
      .then(setHeight)
      .catch(() => undefined);
  }, [client, ticker, no, ctx]);
  useEffect(load, [load]);

  if (!d) return null;
  const c = d.commission;
  const now = new Date();
  const act = cardAction(d, me, height, now);
  const amount = BigInt(c.reward_token_raw || '0').toLocaleString('en-GB');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      load();
      onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const post = (body: Record<string, unknown>) => client.request('POST', `${base(ticker)}/${no}`, body);
  /** Refuse to sign terms the server changed: the text must hash to the commission's doc hash. */
  const terms = async (role: 'poster' | 'deliverer') => {
    if ((await sha256Text(d.terms)) !== c.contract_doc_hash)
      throw new Error('The terms do not match their hash. Nothing was signed.');
    return signTerms(ctx, { roomId: c.room_id, ticker, no, docHash: c.contract_doc_hash!, handle: me, role });
  };

  const fund = () =>
    run(async () => {
      const e = d.escrow!;
      const arbiter = e.pubkeys.find((k) => k.role === 'arbiter')!.pubkey;
      const deliverer = e.pubkeys.find((k) => k.role === 'deliverer')?.pubkey ?? null;
      const t = await terms('poster');
      const f = await fundEscrow(ctx, {
        escrowId: e.id,
        tokenId: c.reward_token_id!,
        amt: BigInt(c.reward_token_raw!),
        arbiterKey: arbiter,
        delivererKey: deliverer,
        deadline: new Date(c.deadline_at!),
        posterAddress: await partnerAddress(me),
      });
      await post({ ...f.body, ...t });
    });
  const delivererKey = () =>
    run(async () => {
      const t = await terms('deliverer');
      await post({ action: 'deliverer-key', pubkey: await escrowPubKey(ctx, d.escrow!.id), ...t });
    });
  const enter = () =>
    run(async () => {
      if (!file && !/^https:\/\//.test(link)) throw new Error('Attach your clip or paste an https link.');
      const t = await terms('deliverer');
      let contentSha256: string | undefined;
      if (file) {
        contentSha256 = await sha256Hex(file);
        await client.uploadMedia(ticker, file); // fallback clip submission: into the room's media
      }
      await post({
        action: 'enter',
        ...(contentSha256 ? { contentSha256 } : { externalUrl: link }),
        payoutAddress: await partnerAddress(me),
        ...t,
      });
      setFile(null);
      setLink('');
    });
  const accept = (entryId: string) =>
    run(async () => {
      const e = d.escrow!;
      const entry = d.entries.find((x) => x.id === entryId)!;
      await post(
        await acceptRelease(
          ctx,
          {
            id: e.id,
            token_id: e.token_id,
            amount: e.amount,
            pubkeys: e.pubkeys,
            fund_raw_tx: e.fund_raw_tx!,
            vout: e.vout!,
            reserve_vout: e.reserve_vout!,
          },
          entry,
        ),
      );
    });
  const broadcast = (proposalId: string) =>
    run(async () => {
      const p = d.proposals.find((x) => x.id === proposalId)!;
      const { txid } = await broadcastSettlement(p.body);
      await post({ action: 'broadcast', proposalId, txid });
    });

  return (
    <div className="flex justify-center my-2" data-testid="commission-card">
      <div
        className="w-full max-w-[92%] rounded-2xl p-3 text-[13px]"
        style={{ background: '#111', border: `1px solid ${LINE}` }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold" style={{ color: GOLD }}>
            #B{no} · Commission
          </span>
          <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: '#1a1a1a', color: MUTED }}>
            {statusLabel[c.status]}
            {c.status === 'open' ? ` · ${deadlineText(c.deadline_at, now)}` : ''}
          </span>
        </div>
        <div className="mt-1 text-[15px] text-white">{c.title}</div>
        <div className="mt-1" style={{ color: MUTED }}>
          {amount} ${c.reward_ticker} · {c.assignee ? `for $${c.assignee}` : 'first valid wins'} · by ${c.created_by}
          {c.content_rating === 'adult' ? ' · 18+' : ''}
          {d.escrow?.status === 'funded' ? ' · locked on chain' : ''}
        </div>
        {c.film_ref && (
          <div className="mt-1 truncate" style={{ color: MUTED }}>
            Film: {c.film_ref}
          </div>
        )}
        <button
          type="button"
          className="mt-1 underline text-[12px]"
          style={{ color: MUTED }}
          onClick={() => setShowTerms((v) => !v)}
        >
          {showTerms ? 'Hide terms' : 'Read the terms'}
        </button>
        {showTerms && <pre className="mt-1 whitespace-pre-wrap text-[12px] text-white/80">{d.terms}</pre>}

        {d.entries.length > 0 && (
          <ul className="mt-2 space-y-1">
            {d.entries.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-white/90">
                  ${x.handle} {x.status === 'accepted' ? '✅' : ''}
                  {x.external_url ? ` · ${x.external_url}` : x.media_id ? ' · clip in room media' : ''}
                </span>
                {act.kind === 'accept' && act.entryIds.includes(x.id) && (
                  <Btn busy={busy} onClick={() => accept(x.id)}>
                    Accept
                  </Btn>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {act.kind === 'fund' && (
            <Btn busy={busy} onClick={fund}>
              Sign terms &amp; lock {amount} ${c.reward_ticker}
            </Btn>
          )}
          {act.kind === 'deliverer-key' && (
            <Btn busy={busy} onClick={delivererKey}>
              Sign the terms
            </Btn>
          )}
          {act.kind === 'enter' && (
            <>
              <input
                type="file"
                accept="video/*,image/*,audio/*"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-[12px]"
              />
              {!file && (
                <input
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="or an https link"
                  className="px-2 py-1 rounded text-white text-[12px]"
                  style={{ border: `1px solid ${LINE}`, background: INPUT_BG }}
                />
              )}
              <Btn busy={busy} onClick={enter}>
                Sign terms &amp; deliver
              </Btn>
            </>
          )}
          {act.kind === 'broadcast' && (
            <Btn busy={busy} onClick={() => broadcast(act.proposalId)}>
              {act.label}
            </Btn>
          )}
          {act.kind === 'wait' && <span style={{ color: MUTED }}>{act.label}</span>}
          {d.escrow?.settled_txid && <span style={{ color: MUTED }}>txid {d.escrow.settled_txid.slice(0, 12)}…</span>}
        </div>
        {err && (
          <div className="mt-2 text-[12px]" style={{ color: '#ff8a8a' }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

/** The /commission composer: what, reward, deadline, optional film link and rating. Drafting locks nothing. */
export function CommissionComposer({
  ticker,
  client,
  initial,
  onClose,
  onPosted,
}: {
  ticker: string;
  client: BchatClient;
  initial: { assignee: string | null; draft: string };
  onClose: () => void;
  onPosted: () => void;
}) {
  const [info, setInfo] = useState<{
    token: { decimals: number } | null;
    rating: 'all_ages' | 'adult';
    arbiter: boolean;
  } | null>(null);
  const [title, setTitle] = useState(initial.draft);
  const [spec, setSpec] = useState('');
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState('7');
  const [film, setFilm] = useState('');
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    client
      .request('GET', base(ticker))
      .then((x) => setInfo(x as typeof info))
      .catch((e) => setErr(errText(e)));
  }, [client, ticker]);

  const submit = async () => {
    setErr(null);
    const raw = info?.token ? parseRewardAmount(amount, info.token.decimals) : null;
    if (!raw) return setErr('Give the reward as a number of tokens, e.g. 10M.');
    const d = Number(days);
    if (!(d > 0 && d <= 90)) return setErr('Deadline: 1 to 90 days.');
    setBusy(true);
    try {
      await client.request('POST', base(ticker), {
        title: title.trim(),
        deliverableSpec: spec.trim(),
        amount: raw.toString(),
        deadlineAt: new Date(Date.now() + d * 86_400_000).toISOString(),
        filmRef: film.trim() || undefined,
        rating: adult ? 'adult' : 'all_ages',
        ...(initial.assignee ? { assignee: initial.assignee } : {}),
      });
      onPosted();
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full px-3 py-2 rounded-lg text-white text-[14px]';
  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-t-2xl p-4 space-y-2"
        style={{ background: '#111', border: `1px solid ${LINE}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-semibold text-white">
          New commission{initial.assignee ? ` for $${initial.assignee}` : ''}
        </div>
        {info && !info.arbiter && <div style={{ color: MUTED }}>Commissions are not set up in this room yet.</div>}
        {info && !info.token && <div style={{ color: MUTED }}>This room has no token to pay with.</div>}
        <input
          className={field}
          style={{ border: `1px solid ${LINE}`, background: INPUT_BG }}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What should be made (e.g. scene 4, the rooftop chase)"
        />
        <textarea
          className={field}
          style={{ border: `1px solid ${LINE}`, background: INPUT_BG }}
          rows={3}
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          placeholder="What counts as delivered (length, format, must-haves)"
        />
        <div className="flex gap-2">
          <input
            className={field}
            style={{ border: `1px solid ${LINE}`, background: INPUT_BG }}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Reward, e.g. 10M"
          />
          <input
            className={field}
            style={{ border: `1px solid ${LINE}`, background: INPUT_BG }}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            placeholder="Days"
            inputMode="numeric"
          />
        </div>
        <input
          className={field}
          style={{ border: `1px solid ${LINE}`, background: INPUT_BG }}
          value={film}
          onChange={(e) => setFilm(e.target.value)}
          placeholder="Film / scene link (optional)"
        />
        {info?.rating === 'adult' && (
          <label className="flex items-center gap-2 text-[13px]" style={{ color: MUTED }}>
            <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /> Adult (18+ room)
          </label>
        )}
        <div style={{ color: MUTED }} className="text-[12px]">
          b drafts the terms from this. Nothing is locked until you sign them on the card and approve the lock in your
          wallet.
        </div>
        {err && (
          <div className="text-[12px]" style={{ color: '#ff8a8a' }}>
            {err}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-[13px]" style={{ color: MUTED }}>
            Cancel
          </button>
          <Btn busy={busy || !info?.arbiter || !info?.token} onClick={submit}>
            Draft commission
          </Btn>
        </div>
      </div>
    </div>
  );
}
