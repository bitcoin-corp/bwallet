import { useCallback, useEffect, useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import type { Envelope } from '../services/envelopes';
import { dollarsFirst, priceFrom } from '../utils/dollarsFirst';
import { sendMessageAsync } from '../utils/chromeHelpers';

type ListData = { envelopes: Envelope[]; usdPerBsv?: number };

/**
 * Settings › Envelopes (services/envelopes.ts): every site's envelope, what is left, what it has spent, and Coin
 * return. The money in an envelope never left the wallet; Coin return just closes the earmark, at once.
 */
export const EnvelopesSettings = () => {
  const { theme } = useTheme();
  const [data, setData] = useState<ListData | null>(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const r = await sendMessageAsync<{ success: boolean; data?: ListData; error?: string }>({
      action: 'ENVELOPES_LIST',
    }).catch(() => null);
    setData(r?.success && r.data ? r.data : { envelopes: [] });
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;
  if (!data) return <p style={{ color: gray }}>Loading…</p>;
  const price = priceFrom(data.usdPerBsv, true);
  const money = (sats: number) => dollarsFirst(sats, price);

  const coinReturn = async (originator: string) => {
    setBusy(originator);
    setNote('');
    const r = await sendMessageAsync<{ success: boolean; data?: { returnedSats: number }; error?: string }>({
      action: 'ENVELOPE_COIN_RETURN',
      originator,
    }).catch(() => null);
    setNote(
      r?.success
        ? `${originator}'s envelope is closed. ${money(r.data?.returnedSats ?? 0).main} stays in your wallet.`
        : r?.error || 'Could not close the envelope',
    );
    setBusy('');
    await load();
  };

  return (
    <div className="flex flex-col gap-3 w-full" data-testid="envelopes-settings">
      <p className="m-0 text-xs leading-relaxed" style={{ color: gray }}>
        A site with an envelope can make small payments from it without asking, and nothing more. The money stays in
        your wallet until each payment is made. When an envelope is empty, the site asks you again. Coin return closes
        it at once.
      </p>
      {note && (
        <p className="m-0 text-xs" style={{ color: contrast }} role="status">
          {note}
        </p>
      )}
      {data.envelopes.length === 0 && (
        <p className="m-0 text-sm" style={{ color: gray }}>
          No envelopes yet. A site that makes many tiny payments (a game, a stream) will ask you to put a little in one.
        </p>
      )}
      {data.envelopes.map((e) => {
        const left = money(e.balanceSats);
        return (
          <div
            key={e.originator}
            className="flex flex-col gap-2 rounded-xl p-3"
            style={{ border: `1px solid ${gray}40` }}
            data-testid="envelope-row"
          >
            <div className="flex items-start gap-3">
              <div className="flex flex-col flex-1 min-w-0">
                <span className="text-sm font-semibold truncate" style={{ color: contrast }}>
                  {e.originator}
                </span>
                <span className="text-xs" style={{ color: gray }}>
                  Spent {money(e.spentSats).main} of {money(e.filledSats).main} put in
                </span>
              </div>
              <div className="flex flex-col items-end">
                <span style={{ fontSize: 22, fontWeight: 800, color: contrast, lineHeight: 1.1 }}>{left.main}</span>
                <span className="text-[11px]" style={{ color: gray }}>
                  {left.sub}
                </span>
              </div>
            </div>
            <button
              type="button"
              disabled={busy === e.originator}
              onClick={() => void coinReturn(e.originator)}
              className="w-full rounded-lg text-sm font-semibold border cursor-pointer bg-transparent disabled:opacity-40"
              style={{ minHeight: 44, color: contrast, borderColor: `${gray}60` }}
            >
              {busy === e.originator ? 'Returning…' : `Coin return · ${left.main}`}
            </button>
          </div>
        );
      })}
    </div>
  );
};
