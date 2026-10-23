import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { LockingScript } from '@bsv/sdk';
import { SendConfirmation } from '../../components/SendConfirmation';
import { showOnWallet } from './indexFund';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from '../chat/nav';
import { checkSize, formatBytes, iconFile, notifyMinted, wocTxUrl } from '../mint/mint';
import { inscribeIcon } from '../tickets/mintTicket';
import { MAX_ICON_BYTES, TICKET_BLOCKED, suggestTicker } from '../tickets/tickets';
import { deployToken, openTokenRoom, type MintedToken } from './mintToken';
import { TOKEN_COPY, emptyTokenForm, tokenCost, validateToken, type TokenForm } from './token';
import { money, moneyWithSats } from '../money/money';
import { RETURNS_BLOCK, RETURNS_WARNING, hasReturnsWording } from './returnsWording';
import { ErrorActions } from '../errors/ErrorActions';
import { CurvePicker } from '../curves/CurvePicker';
import { ListAfterMint } from '../sell/ListAfterMint';
import { STANDARD_SUPPLY, curveProblem } from '../curves/curveChoice';
import { DEFAULT_PRESET, maxPrice, standardCurve, usd, type Curve, type PresetId } from '../../lib/curves';

/**
 * MINT → "Mint a token": a plain BSV-21 token (name, ticker, supply, decimals, optional icon and
 * description) and its holders' room. No ticket MAP tag. Nothing is broadcast until the user
 * confirms SendConfirmation.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#17191E';
const BORDER = '#3a2f0c';

export const TokenMint = ({
  exchangeRate,
  onBack,
  onClose,
  initial,
  map,
  onMinted,
  curvePreset = DEFAULT_PRESET,
}: {
  exchangeRate: number;
  onBack: () => void;
  onClose: () => void;
  /** Pre-filled fields (Mint › A domain). A given ticker counts as chosen: renaming won't overwrite it. */
  initial?: Partial<TokenForm>;
  /** Extra MAP tag on the deploy tx. */
  map?: { script: LockingScript; description: string };
  /** When set, called with the minted token instead of showing this form's own "minted" screen. */
  onMinted?: (token: MintedToken) => void;
  /** Preselected climb (Standard unless a caller says otherwise). */
  curvePreset?: PresetId;
}) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const { handleSelect } = useBottomMenu();
  // Every launch is the standard 1,000,000,000 supply, all on the curve (owner, 23 Oct 2026).
  const [form, setForm] = useState<TokenForm>(() => ({ ...emptyTokenForm(), supply: STANDARD_SUPPLY, ...initial }));
  const [tickerTouched, setTickerTouched] = useState(!!initial?.ticker);
  const [icon, setIcon] = useState<{ file: File; url: string } | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState<{ token: MintedToken; room: string | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const supplyNum = Number((form.supply || '0').replace(/[,_\s]/g, '')) || 0;
  const [curve, setCurve] = useState<Curve>(() => standardCurve(curvePreset));
  const [curveOk, setCurveOk] = useState(false);

  useEffect(() => () => void (icon && URL.revokeObjectURL(icon.url)), [icon]);

  const set = (k: keyof TokenForm) => (v: string) =>
    setForm((f) => ({
      ...f,
      [k]: v,
      ...(k === 'name' && !tickerTouched ? { ticker: suggestTicker(v) } : {}),
    }));

  const cost = tokenCost(icon?.file.size ?? 0, chromeStorageService.getCustomFeeRate(), exchangeRate);

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
    // Hard block at sign time while returns wording is present (returnsWording.ts).
    const err =
      validateToken(form) ??
      (hasReturnsWording(`${form.name ?? ''} ${form.description ?? ''}`) ? RETURNS_BLOCK : null) ??
      curveProblem(curve, curveOk, supplyNum);
    setError(err ?? '');
    if (!err) setConfirming(true);
  };

  const mint = async () => {
    if (validateToken(form) === TICKET_BLOCKED) {
      setConfirming(false);
      return setError(TICKET_BLOCKED);
    }
    setBusy('Minting…');
    try {
      const iconOutpoint = icon ? await inscribeIcon(apiContext, icon.file, form.ticker.trim(), 'token') : null;
      const token = await deployToken(apiContext, form, {
        icon: iconOutpoint,
        feeSats: cost.feeSats,
        ...(map ? { map } : {}),
        curve,
      });
      void showOnWallet(chromeStorageService, token.tokenId);
      setConfirming(false);
      notifyMinted();
      if (onMinted) {
        void openTokenRoom(apiContext, token).catch(() => null);
        return onMinted(token);
      }
      setBusy('Opening the room…');
      // A just-deployed token may not be indexed yet; opening the room from Chat also creates it.
      const room = await openTokenRoom(apiContext, token).catch(() => null);
      setDone({ token, room });
    } catch (e) {
      setConfirming(false);
      setError(e instanceof Error ? e.message : 'Mint failed');
    } finally {
      setBusy('');
    }
  };

  const go = (tab: 'chat' | 'bsv', t?: MintedToken) => {
    if (t) requestChatRoom(`bsv21:${t.tokenId}`);
    handleSelect(asMenuItem(tab));
    onClose();
  };

  const input = 'w-full rounded-xl px-3 py-2 text-sm outline-none border bg-transparent';
  const inputStyle = { borderColor: BORDER, color: '#fff' };
  const primary = { background: `linear-gradient(135deg, #FFE27A, #E0A800)`, color: '#1a1400' };

  if (done) {
    const { token } = done;
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p>
          ${token.ticker} is minted: {Number(token.supply).toLocaleString()} in your wallet.{' '}
          {done.room
            ? `The room "${token.name}" is open.`
            : 'Set up its room (Settings › My tokens) to list it in other wallets and the Market and open its chat.'}
        </p>
        <p className="text-xs" style={{ color: '#999' }}>
          Token id
        </p>
        <a
          href={wocTxUrl(token.tokenId.split('_')[0])}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 break-all text-xs"
          style={{ color: GOLD }}
        >
          {token.tokenId} <ExternalLink size={12} />
        </a>
        <ListAfterMint tokenId={token.tokenId} symbol={token.ticker} dec={token.decimals} curve={curve} />
        <button
          type="button"
          onClick={() => go('chat', token)}
          className="h-11 rounded-xl font-bold border-0 cursor-pointer"
          style={primary}
        >
          Open its room
        </button>
        <button
          type="button"
          onClick={() => go('bsv')}
          className="h-11 rounded-xl font-bold border cursor-pointer bg-transparent"
          style={{ borderColor: BORDER, color: GOLD }}
        >
          View in wallet
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-xs" style={{ color: '#bbb' }}>
        {TOKEN_COPY}
      </p>
      <input
        className={input}
        style={inputStyle}
        placeholder="Token name (required)"
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
          placeholder="Supply"
          aria-label="Supply"
          inputMode="numeric"
          value={form.supply}
          onChange={(e) => set('supply')(e.target.value)}
        />
      </div>
      <label className="text-xs" style={{ color: '#999' }}>
        Decimals (0 = whole tokens only)
        <input
          className={`${input} mt-1`}
          style={inputStyle}
          inputMode="numeric"
          aria-label="Decimals"
          value={form.decimals}
          maxLength={2}
          onChange={(e) => set('decimals')(e.target.value)}
        />
      </label>
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
              {formatBytes(icon.file.size)} · inscribed with the token
            </span>
          )}
        </span>
      </button>
      <textarea
        className={input}
        style={inputStyle}
        placeholder="Description (optional, posted as the room's first message)"
        rows={3}
        value={form.description}
        maxLength={1000}
        onChange={(e) => set('description')(e.target.value)}
      />
      {hasReturnsWording(`${form.name ?? ''} ${form.description ?? ''}`) && (
        <p className="text-xs m-0" style={{ color: 'var(--bw-accent-hi)' }}>
          {RETURNS_WARNING}
        </p>
      )}

      <CurvePicker
        curve={curve}
        onChange={setCurve}
        accepted={curveOk}
        onAccept={setCurveOk}
        tokenSupply={supplyNum}
        onUseStandardSupply={() => set('supply')(STANDARD_SUPPLY)}
      />

      <p className="text-xs" style={{ color: '#bbb' }}>
        Estimated network fee: {money(cost.networkSats, exchangeRate)}
        {cost.txCount > 1 ? ' (2 transactions: icon + token)' : ''}
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
        style={primary}
      >
        Review token
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
          { address: `$${form.ticker.trim()}`.slice(0, 16), amount: `${form.supply.trim() || '0'} tokens` },
          { address: 'Curve (fixed)', amount: `${usd(curve.floorUsd)} → ${usd(maxPrice(curve))}` },
          ...(icon ? [{ address: 'Icon', amount: formatBytes(icon.file.size) }] : []),
          { address: 'Network fee', amount: `${money(cost.networkSats, exchangeRate)}` },
          ...(cost.feeSats > 0 ? [{ address: 'Mint fee (1%)', amount: `${money(cost.feeSats, exchangeRate)}` }] : []),
        ]}
        total={moneyWithSats(cost.totalSats, exchangeRate)}
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
