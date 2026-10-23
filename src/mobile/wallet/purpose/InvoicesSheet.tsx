import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import * as qr from 'qrcode';
import { X } from 'lucide-react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { useBackClose } from '../../backStack';
import { copyLink } from '../../chat/shareLink';
import { getPaymail } from '../../names/accountName';
import { historyCacheKey, readHistoryCache } from '../historyCache';
import { parseAmount } from '../send/sendLogic';
import { applyChip, PURPOSE_CHIPS, PURPOSE_MAX } from './purpose';
import {
  createInvoice,
  invoiceAmountText,
  invoiceLink,
  listIssued,
  matchPayment,
  saveIssued,
  setIssuedStatus,
  type IssuedInvoice,
} from './invoice';

/**
 * Request / Invoice (owner, 23 Oct 2026: invoicing in the main wallet). Make an invoice signed with this account's
 * identity key, share its pay link or QR, and keep "My invoices" (open / paid / cancelled) on this device. A payment
 * that looks like it paid an invoice is offered as a suggestion; the owner confirms "Mark as paid".
 */
const BG = '#0d0e11';
const CARD = '#17191E';
const MUTED = '#98A2B3';
const GOLD = 'var(--bw-accent-hi)';
const chipStyle = {
  background: `color-mix(in srgb, ${GOLD} 10%, transparent)`,
  color: GOLD,
  border: `1px solid color-mix(in srgb, ${GOLD} 30%, transparent)`,
};
const field = 'w-full rounded-xl p-3 text-sm outline-none bg-transparent text-white';
const fieldStyle = { border: `1px solid ${MUTED}50` };

const InvoicesSheet = ({ account, onClose }: { account: string; onClose: () => void }) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const paymail = getPaymail(account);
  const [unit, setUnit] = useState<'usd' | 'bsv'>('usd');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [list, setList] = useState<IssuedInvoice[]>(() => listIssued(account));
  const [shown, setShown] = useState<IssuedInvoice | null>(null);
  const [img, setImg] = useState('');
  const [txidFor, setTxidFor] = useState<Record<string, string>>({});
  const reload = () => setList(listIssued(account));

  const link = shown ? invoiceLink(shown) : '';
  useEffect(() => {
    if (!link) return setImg('');
    void qr.toDataURL(link, { margin: 1, width: 240 }).then(setImg, () => setImg(''));
  }, [link]);

  // Suggested matches from the History cache (no extra network here).
  const suggestions = useMemo(() => {
    const a = chromeStorageService.getCurrentAccountObject().account?.addresses;
    const addrs = [...new Set([a?.bsvAddress, a?.ordAddress, a?.identityAddress].filter((x): x is string => !!x))];
    const rows = readHistoryCache(historyCacheKey(addrs))?.rows ?? [];
    const used = new Set(list.flatMap((x) => (x.txid ? [x.txid] : [])));
    const out: Record<string, string> = {};
    for (const x of list) {
      if (x.status !== 'open') continue;
      const t = matchPayment(x.inv, rows, used);
      if (t) {
        out[x.inv.id] = t;
        used.add(t);
      }
    }
    return out;
  }, [list, chromeStorageService]);

  const create = async () => {
    setMsg('');
    const n = parseAmount(amount);
    if (!paymail) return setMsg('Claim your $name first: invoices are paid to your paymail.');
    if (!n || n <= 0) return setMsg('Enter an amount.');
    if (!apiContext?.wallet) return setMsg('Wallet not ready.');
    setBusy(true);
    try {
      const s = await createInvoice(apiContext.wallet, {
        payee: paymail,
        ...(unit === 'usd' ? { usdCents: Math.round(n * 100) } : { sats: Math.round(n * 1e8) }),
        purpose,
        due: due || undefined,
      });
      saveIssued(account, s);
      reload();
      setShown({ ...s, status: 'open', updated: Date.now() });
      setAmount('');
      setPurpose('');
      setDue('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not make the invoice.');
    } finally {
      setBusy(false);
    }
  };

  const status = (id: string, st: IssuedInvoice['status'], txid?: string) => {
    if (!setIssuedStatus(account, id, st, txid)) {
      setMsg(st === 'paid' ? 'Paste the 64-character transaction ID that paid it.' : 'Could not update it.');
      return;
    }
    setMsg('');
    reload();
  };

  const page = (
    <div
      role="dialog"
      aria-label="Request / Invoice"
      className="fixed inset-0 z-[200] overflow-y-auto overflow-x-hidden text-white"
      style={{ background: BG }}
    >
      <div className="max-w-[560px] mx-auto px-4 pt-6 pb-24 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Request / Invoice</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="w-11 h-11 flex items-center justify-center rounded-full border-0 cursor-pointer"
            style={{ background: CARD, color: '#fff' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* New invoice */}
        <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: CARD }}>
          <span className="text-xs" style={{ color: MUTED }}>
            Paid to <span className="text-white font-semibold">{paymail || 'your paymail (claim a $name first)'}</span>.
            Signed with your identity key so nobody can forge one in your name.
          </span>
          <div className="flex gap-2">
            <input
              aria-label={unit === 'usd' ? 'Amount in US dollars' : 'Amount in BSV'}
              inputMode="decimal"
              placeholder={unit === 'usd' ? '0.00' : '0.000'}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={field}
              style={fieldStyle}
            />
            <div role="radiogroup" aria-label="Currency" className="flex rounded-xl p-0.5" style={fieldStyle}>
              {(['usd', 'bsv'] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  role="radio"
                  aria-checked={unit === u}
                  onClick={() => setUnit(u)}
                  className="min-w-[56px] px-3 rounded-lg text-xs font-bold border-0 cursor-pointer"
                  style={{ background: unit === u ? GOLD : 'transparent', color: unit === u ? '#000' : '#fff' }}
                >
                  {u === 'usd' ? 'USD' : 'BSV'}
                </button>
              ))}
            </div>
          </div>
          <textarea
            aria-label="What's it for?"
            placeholder="What's it for? (shown to the payer, kept with the payment)"
            maxLength={PURPOSE_MAX}
            rows={2}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            className={`${field} resize-none`}
            style={fieldStyle}
          />
          <div className="flex flex-wrap gap-2">
            {PURPOSE_CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setPurpose((p) => applyChip(p, c))}
                className="min-h-[36px] px-3 rounded-full text-xs font-semibold cursor-pointer"
                style={chipStyle}
              >
                {c}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
            Due (optional)
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className="rounded-lg p-2 text-sm bg-transparent text-white"
              style={fieldStyle}
            />
          </label>
          {msg && (
            <p role="alert" className="text-xs" style={{ color: '#F97066' }}>
              {msg}
            </p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void create()}
            className="yours-sheet-primary w-full cursor-pointer disabled:opacity-50"
            style={{ height: 52, fontSize: 15, fontWeight: 700, borderRadius: 14 }}
          >
            {busy ? 'Signing…' : 'Make invoice'}
          </button>
        </div>

        {/* The invoice just made (or tapped): pay link + QR */}
        {shown && (
          <div className="rounded-2xl p-4 flex flex-col items-center gap-3 text-center" style={{ background: CARD }}>
            <span className="text-sm font-bold">
              {shown.inv.id} · {invoiceAmountText(shown.inv)}
            </span>
            {shown.inv.purpose && <span className="text-xs break-words">{shown.inv.purpose}</span>}
            {img && <img src={img} alt={`QR code for invoice ${shown.inv.id}`} width={240} height={240} />}
            <span className="text-[11px]" style={{ color: MUTED }}>
              The payer scans this or opens the link in bWalletX: payee, amount and purpose fill in for them to confirm.
            </span>
            <div className="grid grid-cols-2 gap-2 w-full">
              <button
                type="button"
                onClick={() => void copyLink(link).then((r) => setMsg(r === 'copied' ? '' : 'Copy failed.'))}
                className="min-h-[44px] rounded-xl text-sm font-semibold cursor-pointer"
                style={chipStyle}
              >
                Copy link
              </button>
              <button
                type="button"
                onClick={() => {
                  if (navigator.share)
                    void navigator.share({ title: `Invoice ${shown.inv.id}`, url: link }).catch(() => undefined);
                  else void copyLink(link);
                }}
                className="min-h-[44px] rounded-xl text-sm font-semibold cursor-pointer"
                style={chipStyle}
              >
                Share
              </button>
            </div>
          </div>
        )}

        {/* My invoices */}
        <h3 className="text-sm font-bold uppercase tracking-widest" style={{ color: MUTED }}>
          My invoices
        </h3>
        {list.length === 0 && (
          <p className="text-xs" style={{ color: MUTED }}>
            None yet. Invoices you make are kept on this device.
          </p>
        )}
        {list.map((x) => (
          <div key={x.inv.id} className="rounded-2xl p-3 flex flex-col gap-2" style={{ background: CARD }}>
            <div className="flex justify-between gap-2 text-sm">
              <button
                type="button"
                onClick={() => setShown(x)}
                className="font-semibold bg-transparent border-0 p-0 text-white cursor-pointer text-left"
              >
                {x.inv.id}
              </button>
              <span className="font-semibold tabular-nums">{invoiceAmountText(x.inv)}</span>
            </div>
            {x.inv.purpose && <span className="text-xs break-words">{x.inv.purpose}</span>}
            <span className="text-[11px]" style={{ color: MUTED }}>
              {new Date(x.inv.created).toLocaleDateString()}
              {x.inv.due ? ` · due ${x.inv.due}` : ''} ·{' '}
              <span style={{ color: x.status === 'paid' ? '#32D583' : x.status === 'cancelled' ? MUTED : GOLD }}>
                {x.status}
              </span>
              {x.txid ? ` · ${x.txid.slice(0, 10)}…` : ''}
            </span>
            {x.status === 'open' && suggestions[x.inv.id] && (
              <button
                type="button"
                onClick={() => status(x.inv.id, 'paid', suggestions[x.inv.id])}
                className="min-h-[40px] rounded-xl text-xs font-semibold cursor-pointer"
                style={chipStyle}
              >
                Looks paid by {suggestions[x.inv.id].slice(0, 10)}… · Mark as paid
              </button>
            )}
            {x.status === 'open' && (
              <div className="flex flex-wrap gap-2">
                <input
                  aria-label={`Transaction ID that paid ${x.inv.id}`}
                  placeholder="Transaction ID"
                  value={txidFor[x.inv.id] ?? ''}
                  onChange={(e) => setTxidFor((m) => ({ ...m, [x.inv.id]: e.target.value }))}
                  className="flex-1 min-w-[10rem] rounded-lg p-2 text-xs bg-transparent text-white font-mono"
                  style={fieldStyle}
                />
                <button
                  type="button"
                  onClick={() => status(x.inv.id, 'paid', txidFor[x.inv.id])}
                  className="min-h-[36px] px-3 rounded-lg text-xs font-semibold cursor-pointer"
                  style={chipStyle}
                >
                  Mark as paid
                </button>
                <button
                  type="button"
                  onClick={() => status(x.inv.id, 'cancelled')}
                  className="min-h-[36px] px-3 rounded-lg text-xs font-semibold cursor-pointer bg-transparent text-white"
                  style={fieldStyle}
                >
                  Cancel
                </button>
              </div>
            )}
            {x.status !== 'open' && (
              <button
                type="button"
                onClick={() => status(x.inv.id, 'open')}
                className="self-start min-h-[36px] px-3 rounded-lg text-xs font-semibold cursor-pointer bg-transparent text-white"
                style={fieldStyle}
              >
                Reopen
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
  return createPortal(page, document.body);
};

export default InvoicesSheet;
