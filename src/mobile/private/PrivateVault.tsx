import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WalletInterface } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { listPrivateMedia, revealMedia, REVEAL_LABEL, type PrivateItem } from './privateMint';
import { revealsInline } from './records';
import { onMinted } from '../mint/mint';

/** One private item, decrypted in memory, with an object URL for its preview (revoked on unmount). */
export type PrivatePiece = PrivateItem & { url: string; revealed: boolean };

/**
 * Your private media (spec §9.5), decrypted on this device only, plus which of them already have a reveal post
 * (the wallet's own `bchat reveal` actions). Nothing decrypted is written to storage.
 */
// eslint-disable-next-line react-refresh/only-export-components -- the hook and its vault ship together
export function usePrivateMedia(ctx: OneSatContext): { items: PrivatePiece[]; loading: boolean; reload: () => void } {
  const [items, setItems] = useState<PrivatePiece[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => onMinted(reload), [reload]);
  useEffect(() => {
    let live = true;
    const wallet = ctx.wallet as WalletInterface;
    setLoading(true);
    (async () => {
      const list = await listPrivateMedia(wallet).catch(() => [] as PrivateItem[]);
      const revealed = new Set<string>();
      try {
        const { actions } = await wallet.listActions({ labels: [REVEAL_LABEL], includeOutputs: true, limit: 500 });
        for (const a of actions)
          for (const o of a.outputs ?? [])
            for (const t of o.tags ?? []) if (t.startsWith('reveal:')) revealed.add(t.slice(7));
      } catch {
        // unknown: shown as private
      }
      if (!live) return;
      setItems((old) => {
        old.forEach((o) => URL.revokeObjectURL(o.url));
        return list.map((i) => ({
          ...i,
          url: URL.createObjectURL(new Blob([i.file], { type: i.header.mime })),
          revealed: revealed.has(i.outpoint),
        }));
      });
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [ctx, tick]);
  useEffect(() => () => items.forEach((o) => URL.revokeObjectURL(o.url)), [items]);
  return { items, loading, reload };
}

const howRevealed = (i: PrivateItem) =>
  revealsInline(i.header.mime, i.header.bytes)
    ? 'It goes out as one public bChat post with the file in it.'
    : 'The file is inscribed in clear as a normal public ordinal, then a public bChat post points to it.';

/**
 * Reveal one item, or all of a list (one after another). One-way, with a plain warning. Posts are signed with your
 * bChatX posting identity, like any bChatX post.
 */
export const RevealSheet = ({
  ctx,
  items,
  onClose,
  onDone,
}: {
  ctx: OneSatContext;
  items: PrivatePiece[];
  onClose: () => void;
  onDone: () => void;
}) => {
  const todo = items.filter((i) => !i.revealed);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    let n = 0;
    try {
      for (const i of todo) {
        await revealMedia(ctx, i);
        setDone(++n);
      }
      onDone();
      onClose();
    } catch (e) {
      setError(
        `${n} of ${todo.length} revealed. Stopped: ${e instanceof Error ? e.message : 'reveal failed'}. The rest stay private.`,
      );
      onDone();
    } finally {
      setBusy(false);
    }
  };
  const one = todo.length === 1 ? todo[0] : null;
  return createPortal(
    <div className="fixed inset-0 z-[450] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div
        className="w-full max-w-md rounded-t-2xl p-4 flex flex-col gap-3 text-sm"
        style={{ background: '#17191E', color: '#fff', paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}
        role="dialog"
        aria-label="Reveal"
      >
        <b className="text-lg" style={{ color: 'var(--bw-accent-hi)' }}>
          {one ? `Make "${one.header.name}" public?` : `Make ${todo.length} items public?`}
        </b>
        {one && /^image\//.test(one.header.mime) && (
          <img src={one.url} alt="" className="w-full max-h-48 object-contain rounded-xl" />
        )}
        <p className="m-0" style={{ color: '#FFB020' }}>
          This can't be undone. Once revealed, anyone can see it on chain, for good. Your private copy stays locked.
        </p>
        <p className="m-0 text-xs" style={{ color: '#bbb' }}>
          {one ? howRevealed(one) : 'Each one goes out as its own public bChat post.'} Network fees apply, as for any
          post or mint. Your wallet shows the fee before each one is sent.
        </p>
        {busy && (
          <p className="m-0 text-xs" style={{ color: '#bbb' }} aria-live="polite">
            Revealing {done + 1} of {todo.length}…
          </p>
        )}
        {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
        <button
          type="button"
          disabled={busy || !todo.length}
          onClick={() => void go()}
          className="h-11 rounded-xl font-bold border-0 cursor-pointer"
          style={{ background: 'linear-gradient(135deg, #FFE27A, #E0A800)', color: '#1a1400' }}
        >
          {one ? 'Reveal: make it public' : `Reveal all ${todo.length}: make them public`}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="h-11 rounded-xl font-bold border bg-transparent cursor-pointer"
          style={{ borderColor: '#3a2f0c', color: '#ccc' }}
        >
          Keep private
        </button>
      </div>
    </div>,
    document.body,
  );
};
