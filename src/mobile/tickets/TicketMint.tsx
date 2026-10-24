import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { SendConfirmation } from '../../components/SendConfirmation';
import { showOnWallet } from '../tokens/indexFund';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from '../chat/nav';
import { checkSize, formatBytes, iconFile, notifyMinted, wocTxUrl } from '../mint/mint';
import { deployTicket, inscribeIcon, openTicketRoom } from './mintTicket';
import {
  ENTRY_LABEL,
  ENTRY_RULES,
  MAX_ICON_BYTES,
  SPEND_NOT_ENFORCED,
  SPEND_PERS,
  SPEND_TOS,
  SPEND_TO_LABEL,
  TICKET_BLOCKED,
  TICKET_COPY,
  emptyTicketForm,
  suggestTicker,
  ticketCost,
  validateTicket,
  type Ticket,
  type TicketForm,
} from './tickets';
import { hasRate, money, moneyWithSats, satsNote, usdToSats } from '../money/money';
import { ErrorActions } from '../errors/ErrorActions';

/**
 * MINT → "Start a room": mint a ticket (BSV-21, fixed supply, 0 decimals) and open its holders'
 * room. The room is the point: it is always created. Event date and price sit under
 * "More options". Nothing is broadcast until the user confirms SendConfirmation.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#17191E';
const BORDER = '#3a2f0c';

export const TicketMint = ({
  exchangeRate,
  onBack,
  onClose,
}: {
  exchangeRate: number;
  onBack: () => void;
  onClose: () => void;
}) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const { handleSelect } = useBottomMenu();
  const [form, setForm] = useState<TicketForm>(emptyTicketForm);
  const [tickerTouched, setTickerTouched] = useState(false);
  const [icon, setIcon] = useState<{ file: File; url: string } | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState<{ ticket: Ticket; room: string | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (icon && URL.revokeObjectURL(icon.url)), [icon]);

  const set = (k: Exclude<keyof TicketForm, 'entry' | 'spendPer' | 'spendTo'>) => (v: string) =>
    setForm((f) => ({
      ...f,
      [k]: v,
      ...(k === 'name' && !tickerTouched ? { ticker: suggestTicker(v) } : {}),
    }));

  const [priceUsd, setPriceUsd] = useState('');
  const cost = ticketCost(icon?.file.size ?? 0, chromeStorageService.getCustomFeeRate(), exchangeRate);

  const pickIcon = async (file: File | undefined) => {
    setError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError('Pick an image for the icon.');
    try {
      const small = await iconFile(file);
      const size = checkSize(small.size, MAX_ICON_BYTES);
      if (!size.ok) return setError(size.message);
      setIcon({ file: small, url: URL.createObjectURL(small) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read this image');
    }
  };

  const review = () => {
    const err = validateTicket(form);
    setError(err ?? '');
    if (!err) setConfirming(true);
  };

  const mint = async () => {
    if (validateTicket(form) === TICKET_BLOCKED) {
      setConfirming(false);
      return setError(TICKET_BLOCKED);
    }
    setBusy('Minting…');
    try {
      const iconOutpoint = icon ? await inscribeIcon(apiContext, icon.file, form.ticker.trim()) : null;
      const ticket = await deployTicket(apiContext, form, { icon: iconOutpoint, feeSats: cost.feeSats });
      void showOnWallet(chromeStorageService, ticket.tokenId);
      setConfirming(false);
      notifyMinted();
      setBusy('Opening the room…');
      // A just-deployed token may not be indexed yet; the Market retries (finishTicketRooms).
      const room = await openTicketRoom(apiContext, ticket).catch(() => null);
      setDone({ ticket, room });
    } catch (e) {
      setConfirming(false);
      setError(e instanceof Error ? e.message : 'Mint failed');
    } finally {
      setBusy('');
    }
  };

  const goToRoom = (t: Ticket) => {
    requestChatRoom(`bsv21:${t.tokenId}`);
    handleSelect(asMenuItem('chat'));
    onClose();
  };

  const input = 'w-full rounded-xl px-3 py-2 text-sm outline-none border bg-transparent';
  const inputStyle = { borderColor: BORDER, color: '#fff' };

  if (done) {
    const txid = done.ticket.tokenId.split('_')[0];
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p>
          ${done.ticket.ticker} is minted: {Number(done.ticket.supply ?? 0).toLocaleString()} tickets in your wallet.{' '}
          {done.room
            ? `The room "${done.ticket.name}" is open.`
            : 'Set up its room (Settings › My tokens) to list it in other wallets and the Market and open its chat.'}
        </p>
        <p className="text-xs" style={{ color: '#999' }}>
          {TICKET_COPY}
        </p>
        <a
          href={wocTxUrl(txid)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 break-all text-xs"
          style={{ color: GOLD }}
        >
          {txid} <ExternalLink size={12} />
        </a>
        <button
          type="button"
          onClick={() => goToRoom(done.ticket)}
          className="h-11 rounded-xl font-bold border-0 cursor-pointer"
          style={{ background: `linear-gradient(135deg, #FFE27A, #E0A800)`, color: '#1a1400' }}
        >
          Open room
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-xl font-bold border cursor-pointer bg-transparent"
          style={{ borderColor: BORDER, color: GOLD }}
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-xs" style={{ color: '#bbb' }}>
        {TICKET_COPY}
      </p>
      <input
        className={input}
        style={inputStyle}
        placeholder="Room name (required)"
        value={form.name}
        maxLength={64}
        onChange={(e) => set('name')(e.target.value)}
      />
      <div className="flex gap-2">
        <input
          className={input}
          style={inputStyle}
          placeholder="Ticker"
          aria-label="Ticker"
          value={form.ticker}
          maxLength={32}
          onChange={(e) => {
            setTickerTouched(true);
            set('ticker')(e.target.value.toUpperCase().replace(/^\$/, ''));
          }}
        />
        <input
          className={input}
          style={inputStyle}
          placeholder="How many tickets"
          aria-label="Supply"
          inputMode="numeric"
          value={form.supply}
          onChange={(e) => set('supply')(e.target.value)}
        />
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void pickIcon(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex items-center gap-3 rounded-xl border border-dashed px-3 py-2 cursor-pointer bg-transparent text-left"
        style={{ borderColor: GOLD, color: GOLD }}
      >
        {icon ? (
          <img src={icon.url} alt="" className="h-10 w-10 rounded-lg object-cover" />
        ) : (
          <span className="h-10 w-10 rounded-lg border" style={{ borderColor: BORDER }} />
        )}
        <span>
          {icon ? 'Change icon' : 'Add an icon (optional)'}
          {icon && (
            <span className="block text-[10px]" style={{ color: '#999' }}>
              {formatBytes(icon.file.size)} · inscribed with the ticket
            </span>
          )}
        </span>
      </button>
      <textarea
        className={input}
        style={inputStyle}
        placeholder="What's the room for? (founding note, posted as the first message)"
        rows={3}
        value={form.description}
        maxLength={1000}
        onChange={(e) => set('description')(e.target.value)}
      />

      <label className="text-xs" style={{ color: '#999' }}>
        Tokens needed to enter
        <input
          className={`${input} mt-1`}
          style={inputStyle}
          inputMode="numeric"
          aria-label="Tokens needed to enter"
          value={form.minTokens}
          onChange={(e) => set('minTokens')(e.target.value)}
        />
      </label>

      <button
        type="button"
        onClick={() => setMore((m) => !m)}
        className="flex items-center gap-1 self-start bg-transparent border-0 cursor-pointer text-xs"
        style={{ color: '#bbb' }}
        aria-expanded={more}
      >
        {more ? <ChevronDown size={14} /> : <ChevronRight size={14} />} More options
      </button>
      {more && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 text-xs" style={{ color: '#999' }} role="radiogroup">
            Entry
            {ENTRY_RULES.map((rule) => (
              <label key={rule} className="flex items-center gap-1 text-sm cursor-pointer" style={{ color: '#fff' }}>
                <input
                  type="radio"
                  name="ticket-entry"
                  value={rule}
                  checked={form.entry === rule}
                  onChange={() => setForm((f) => ({ ...f, entry: rule }))}
                  style={{ accentColor: GOLD }}
                />
                {ENTRY_LABEL[rule]}
              </label>
            ))}
          </div>
          {form.entry === 'spend' && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  className={input}
                  style={inputStyle}
                  inputMode="numeric"
                  aria-label="Spend amount"
                  placeholder="Amount"
                  value={form.spendAmount}
                  onChange={(e) => set('spendAmount')(e.target.value)}
                />
                <select
                  className={input}
                  style={{ ...inputStyle, background: PANEL }}
                  aria-label="Per"
                  value={form.spendPer}
                  onChange={(e) => setForm((f) => ({ ...f, spendPer: e.target.value as TicketForm['spendPer'] }))}
                >
                  {SPEND_PERS.map((p) => (
                    <option key={p} value={p}>
                      per {p}
                    </option>
                  ))}
                </select>
              </div>
              <select
                className={input}
                style={{ ...inputStyle, background: PANEL }}
                aria-label="Spent tokens go to"
                value={form.spendTo}
                onChange={(e) => setForm((f) => ({ ...f, spendTo: e.target.value as TicketForm['spendTo'] }))}
              >
                {SPEND_TOS.map((t) => (
                  <option key={t} value={t}>
                    to {SPEND_TO_LABEL[t]}
                  </option>
                ))}
              </select>
              {form.spendTo === 'address' && (
                <input
                  className={input}
                  style={inputStyle}
                  aria-label="Spend address"
                  placeholder="BSV address"
                  value={form.spendAddress}
                  onChange={(e) => set('spendAddress')(e.target.value)}
                />
              )}
              <p className="text-[10px]" style={{ color: '#999' }}>
                {SPEND_NOT_ENFORCED}
              </p>
            </div>
          )}
          <label className="text-xs" style={{ color: '#999' }}>
            Event date (optional, for a ticket that is also for an event)
            <input
              type="date"
              className={`${input} mt-1`}
              style={{ ...inputStyle, colorScheme: 'dark' }}
              value={form.eventDate}
              onChange={(e) => set('eventDate')(e.target.value)}
            />
          </label>
          {hasRate(exchangeRate) ? (
            <label className="text-xs" style={{ color: '#999' }}>
              Price per ticket in US$ (optional, shown in the Market)
              <input
                className={`${input} mt-1`}
                style={inputStyle}
                inputMode="decimal"
                placeholder="e.g. 5.00"
                value={priceUsd}
                onChange={(e) => {
                  const v = e.target.value.replace(/^\$/, '');
                  if (!/^\d*(\.\d{0,2})?$/.test(v)) return;
                  setPriceUsd(v);
                  // Stored on the ticket in sats, converted at today's rate.
                  set('priceSats')(String(usdToSats(Number(v), exchangeRate) ?? ''));
                }}
              />
              {Number(form.priceSats) > 0 && (
                <span className="block mt-0.5 text-[11px]" style={{ color: '#666' }}>
                  {satsNote(Number(form.priceSats), exchangeRate)}
                </span>
              )}
            </label>
          ) : (
            <label className="text-xs" style={{ color: '#999' }}>
              Price per ticket in sats (optional; USD price unavailable right now)
              <input
                className={`${input} mt-1`}
                style={inputStyle}
                inputMode="numeric"
                placeholder="e.g. 1000"
                value={form.priceSats}
                onChange={(e) => set('priceSats')(e.target.value)}
              />
            </label>
          )}
        </div>
      )}

      <p className="text-xs" style={{ color: '#bbb' }}>
        Estimated network fee: {money(cost.networkSats, exchangeRate)}
        {cost.txCount > 1 ? ' (2 transactions: icon + ticket)' : ''}
        {cost.feeSats > 0 && <> · bWallet mint fee (1%): {money(cost.feeSats, exchangeRate)}</>} · Total ≈{' '}
        {moneyWithSats(cost.totalSats, exchangeRate)}. Its room and Market listing can be set up later (Settings › My
        tokens).
      </p>
      {error && (
        <div className="flex flex-col gap-1.5">
          <p style={{ color: '#ff6b6b' }}>{error}</p>
          <ErrorActions message={String(error)} />
        </div>
      )}
      <button
        type="button"
        onClick={review}
        className="h-11 rounded-xl font-bold border-0 cursor-pointer"
        style={{ background: `linear-gradient(135deg, #FFE27A, #E0A800)`, color: '#1a1400' }}
      >
        Review ticket
      </button>
      <button
        type="button"
        onClick={onBack}
        className="text-sm bg-transparent border-0 cursor-pointer"
        style={{ color: GOLD }}
      >
        Back
      </button>

      <SendConfirmation
        show={confirming}
        theme={theme}
        lineItems={[
          // SendConfirmation truncates labels over 16 characters: keep them short.
          { address: `$${form.ticker.trim()}`.slice(0, 16), amount: `${form.supply.trim() || '0'} tickets` },
          ...(icon ? [{ address: 'Icon', amount: formatBytes(icon.file.size) }] : []),
          { address: 'Network fee', amount: `${money(cost.networkSats, exchangeRate)}`, sats: cost.networkSats },
          ...(cost.feeSats > 0
            ? [{ address: 'Mint fee (1%)', amount: `${money(cost.feeSats, exchangeRate)}`, sats: cost.feeSats }]
            : []),
        ]}
        total={moneyWithSats(cost.totalSats, exchangeRate)}
        totalSats={cost.totalSats}
        usdPerBsv={exchangeRate}
        isProcessing={!!busy}
        onConfirm={() => void mint()}
        onCancel={() => !busy && setConfirming(false)}
      />
      {busy && !confirming && (
        <p className="text-xs text-center" style={{ color: GOLD, background: PANEL }}>
          {busy}
        </p>
      )}
    </div>
  );
};
