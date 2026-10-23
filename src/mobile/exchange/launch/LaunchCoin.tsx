import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Check, ChevronDown, ImagePlus, MessageCircle, Rocket } from 'lucide-react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { useBackClose } from '../../backStack';
import { money, moneyWithSats, useBsvUsd } from '../../money/money';
import { checkSize, formatBytes, iconFile, notifyMinted } from '../../mint/mint';
import { inscribeIcon } from '../../tickets/mintTicket';
import { MAX_ICON_BYTES, suggestTicker } from '../../tickets/tickets';
import { showOnWallet } from '../../tokens/indexFund';
import { RETURNS_WARNING, hasReturnsWording } from '../../tokens/returnsWording';
import type { TokenForm } from '../../tokens/token';
import { ErrorActions } from '../../errors/ErrorActions';
import { tradeRoute } from '../exchangeData';
import { requestChatRoom } from '../../chat/nav';
import { useBottomMenu } from '../../../hooks/useBottomMenu';
import { asMenuItem } from '../../tabs/tabs';
import { CATEGORIES } from '../registry/catalog';
import {
  DEPOSIT_NOTE,
  LAUNCH_DISCLAIMER,
  LAUNCH_NOTICE,
  launchPrefill,
  approvalLines,
  defaultLaunchOptions,
  emptyLaunchForm,
  costSummary,
  depositValue,
  launchCost,
  mapBytes,
  validateLaunch,
  validateOptions,
  validateVest,
  withOptions,
  type Launch,
  type LaunchOptions,
} from './launch';
import { deployLaunch, payLaunchDeposit, retryVesting } from './launchNet';
import { defaultVestPlan, scheduleSummary, type VerifiedVesting, type VestPlan } from './vesting';
import { KeepForYourself } from './VestingSection';
import { CurvePicker } from '../../curves/CurvePicker';
import { ListAfterMint } from '../../sell/ListAfterMint';
import { STANDARD_SUPPLY, curveProblem } from '../../curves/curveChoice';
import { curveMapBytes } from '../../curves/curveMap';
import { standardCurve, type Curve } from '../../../lib/curves';

const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug);
type Done = {
  launch: Launch;
  supply: string;
  roomError: boolean;
  indexError: string | null;
  vesting: VerifiedVesting | null;
  vestError: string | null;
  depositSats: number;
};

/**
 * Exchange › Launchpad › Launch your own coin: name, ticker, supply (1B default), icon, then ONE
 * approval sheet inside the wallet (owner rule: one sheet, nothing to untick), then the result with
 * the coin's Exchange page. Signing is the active account's own wallet (apiContext); nothing is
 * broadcast before Allow.
 */
const GOLD = 'var(--bw-accent)';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

export const LaunchCoin = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const navigate = useNavigate();
  const { search } = useLocation();
  const rate = useBsvUsd();
  // A bApp's Tokenise (Feed › bApps) opens this screen prefilled (?name=&description=&website=&category=).
  const [prefill] = useState(() => launchPrefill(search));
  const [form, setForm] = useState<TokenForm>(() => {
    const f = { ...emptyLaunchForm(), ...prefill.form };
    return f.name ? { ...f, ticker: suggestTicker(f.name) } : f;
  });
  const [tickerTouched, setTickerTouched] = useState(false);
  const [icon, setIcon] = useState<{ file: File; url: string } | null>(null);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const [opts, setOpts] = useState<LaunchOptions>(() => ({ ...defaultLaunchOptions(), ...prefill.options }));
  const [advanced, setAdvanced] = useState(false);
  const [vest, setVest] = useState<VestPlan>(defaultVestPlan);
  const [doneVest, setDoneVest] = useState<{ plan: VestPlan; form: TokenForm; opts: LaunchOptions } | null>(null);
  const [vestBusy, setVestBusy] = useState(false);
  const [curve, setCurve] = useState<Curve>(() => standardCurve(prefill.curve));
  const [curveOk, setCurveOk] = useState(false);
  const { handleSelect } = useBottomMenu();
  const setOpt = <K extends keyof LaunchOptions>(k: K, v: LaunchOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (icon && URL.revokeObjectURL(icon.url)), [icon]);

  const cost = launchCost(icon?.file.size ?? 0, chromeStorageService.getCustomFeeRate(), undefined, {
    mapBytes: mapBytes(form, opts) + curveMapBytes(curve),
    vest,
  });
  const check = () =>
    validateLaunch(withOptions(form, opts)) ??
    validateOptions(opts, CATEGORY_SLUGS) ??
    validateVest(withOptions(form, opts), vest) ??
    curveProblem(curve, curveOk, Number(wholeSupply));
  const wholeSupply = (() => {
    try {
      return BigInt((form.supply || '0').replace(/[,_\s]/g, '') || '0');
    } catch {
      return 0n;
    }
  })();
  const fmt = (sats: number) => money(sats, rate);

  const set = (k: keyof TokenForm) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v, ...(k === 'name' && !tickerTouched ? { ticker: suggestTicker(v) } : {}) }));

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
    const err = check();
    setError(err ?? '');
    if (err && validateOptions(opts, CATEGORY_SLUGS)) setAdvanced(true);
    if (!err) setSheet(true);
  };

  const launch = async () => {
    const err = check();
    if (err) {
      setSheet(false);
      return setError(err);
    }
    setBusy('Launching…');
    try {
      const iconOutpoint = icon ? await inscribeIcon(apiContext, icon.file, form.ticker.trim(), 'coin') : null;
      // The flat launch fee rides on the deploy tx as its own labelled output (no fee address = none).
      const res = await deployLaunch(apiContext, form, opts, {
        icon: iconOutpoint,
        launchFeeSats: cost.launchFeeSats,
        depositSats: cost.depositSats,
        vest,
        curve,
      });
      setDoneVest({ plan: vest, form, opts });
      void showOnWallet(chromeStorageService, res.launch.tokenId);
      notifyMinted();
      setSheet(false);
      setDone({ ...res, depositSats: cost.depositSats });
    } catch (e) {
      setSheet(false);
      setError(e instanceof Error ? e.message : 'Launch failed');
    } finally {
      setBusy('');
    }
  };

  // The deposit failed after the deploy: retry it alone (same approved amount, never twice).
  const retryDeposit = async () => {
    if (!done) return;
    setBusy('Paying indexing deposit…');
    try {
      await payLaunchDeposit(apiContext, done.launch.tokenId, done.launch.ticker, done.depositSats);
      setDone({ ...done, indexError: null });
    } catch (e) {
      setDone({ ...done, indexError: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  };

  const input = 'w-full rounded-xl px-3 py-2.5 text-sm outline-none border bg-transparent text-white';
  const inputStyle = { borderColor: LINE };

  const lockNow = async () => {
    if (!done || !doneVest) return;
    setVestBusy(true);
    try {
      const v = await retryVesting(
        apiContext,
        doneVest.form,
        doneVest.opts,
        done.launch.tokenId,
        done.launch.icon,
        doneVest.plan,
      );
      setDone({ ...done, vesting: v, vestError: null });
    } catch (e) {
      setDone({ ...done, vestError: e instanceof Error ? e.message : String(e) });
    } finally {
      setVestBusy(false);
    }
  };

  if (done) {
    const l = done.launch;
    return (
      <section className="flex flex-col gap-3 rounded-2xl border p-4" style={{ borderColor: LINE }}>
        <div className="flex items-center gap-2 text-white font-bold">
          <Check size={18} color="#A1FF8B" /> ${l.ticker} is launched
        </div>
        <p className="text-sm m-0" style={{ color: MUTED }}>
          {BigInt(done.supply).toLocaleString('en-US')} ${l.ticker} are yours
          {done.vesting ? ', with your kept share locked' : ''}. Its Exchange page is live; it shows trades once the
          token is indexed (usually a few minutes).
        </p>
        <p className="text-[11px] break-all m-0" style={{ color: MUTED }}>
          {l.tokenId}
        </p>
        <ListAfterMint tokenId={l.tokenId} symbol={l.ticker} dec={Number(opts.decimals) || 0} curve={curve} />
        {done.vesting && (
          <p className="text-xs m-0" style={{ color: MUTED }}>
            Your {done.vesting.receipt.keepBps / 100}% share is locked: {scheduleSummary(done.vesting.receipt)}. The
            public receipt is on chain and on the coin&apos;s Exchange page; claim each lock there once it opens.
          </p>
        )}
        {done.vestError && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs m-0" style={{ color: '#FF6B6B' }}>
              Your share is NOT locked yet ({done.vestError}). The coin has no vesting receipt until you lock it.
            </p>
            <button
              type="button"
              disabled={vestBusy}
              onClick={() => void lockNow()}
              className="bw-pill bw-pill-gold min-h-[44px] w-full text-sm font-bold disabled:opacity-60"
            >
              {vestBusy ? 'Locking…' : 'Lock my share now'}
            </button>
          </div>
        )}
        <p className="text-xs m-0" style={{ color: MUTED }}>
          {LAUNCH_DISCLAIMER}
        </p>
        <p className="text-xs m-0" style={{ color: MUTED }}>
          {done.roomError
            ? "Its holders' room opens once the token is indexed: open it from Chat or Settings › My tokens."
            : `The holders' room "${l.name}" is open.`}
        </p>
        {done.indexError ? (
          <div className="flex flex-col gap-2 rounded-xl border p-3" style={{ borderColor: '#5a2a2a' }}>
            <p className="text-xs m-0" style={{ color: '#FF6B6B' }}>
              The indexing deposit wasn't paid: {done.indexError}. Until it is, wallets and the Exchange can't verify $
              {l.ticker} transfers.
            </p>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void retryDeposit()}
              className="bw-pill bw-pill-gold min-h-[44px] w-full text-sm font-bold disabled:opacity-60"
            >
              {busy || `Pay indexing deposit · ${depositValue(done.depositSats, fmt)}`}
            </button>
          </div>
        ) : (
          <p className="text-xs m-0" style={{ color: MUTED }}>
            Indexing deposit paid to GorillaPool ({depositValue(done.depositSats, fmt)}). Top it up any time from the
            coin's Exchange page.
          </p>
        )}
        <button
          type="button"
          onClick={() => navigate(tradeRoute(l.tokenId))}
          className="bw-pill bw-pill-gold min-h-[44px] w-full text-sm font-bold"
        >
          Open ${l.ticker} on the Exchange
        </button>
        <button
          type="button"
          onClick={() => {
            requestChatRoom(`bsv21:${l.tokenId}`);
            handleSelect(asMenuItem('chat'));
          }}
          className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full border bg-transparent text-sm font-bold cursor-pointer"
          style={{ borderColor: LINE, color: GOLD }}
        >
          <MessageCircle size={16} /> Open its room
        </button>
        <button
          type="button"
          onClick={() => {
            setOpts(defaultLaunchOptions());
            setVest(defaultVestPlan());
            setDoneVest(null);
            setDone(null);
            setForm(emptyLaunchForm());
            setTickerTouched(false);
            setIcon(null);
          }}
          className="text-sm bg-transparent border-0 cursor-pointer"
          style={{ color: GOLD }}
        >
          Launch another
        </button>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border p-4" style={{ borderColor: LINE }}>
      <h2 className="flex items-center gap-2 text-lg font-extrabold text-white m-0">
        <Rocket size={18} color={GOLD} /> Launch your own coin
      </h2>
      <p className="text-xs m-0" style={{ color: MUTED }}>
        A BSV-21 token made from your wallet. The whole supply lands in your wallet and it gets its own Exchange page.
      </p>
      <input
        className={input}
        style={inputStyle}
        placeholder="Coin name"
        aria-label="Coin name"
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
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void pickIcon(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="flex items-center gap-3 rounded-xl border border-dashed px-3 py-2 cursor-pointer bg-transparent text-left text-sm"
        style={{ borderColor: GOLD, color: GOLD }}
      >
        {icon ? (
          <img src={icon.url} alt="" className="h-10 w-10 rounded-lg object-cover" />
        ) : (
          <span
            className="h-10 w-10 rounded-lg flex items-center justify-center"
            style={{ background: 'var(--bw-surface)' }}
          >
            <ImagePlus size={18} />
          </span>
        )}
        <span>
          {icon ? 'Change icon' : 'Add an icon'}
          {icon && (
            <span className="block text-[10px]" style={{ color: MUTED }}>
              {formatBytes(icon.file.size)} · inscribed with the coin
            </span>
          )}
        </span>
      </button>
      <textarea
        className={input}
        style={inputStyle}
        placeholder="Description (optional)"
        rows={2}
        value={form.description}
        maxLength={1000}
        onChange={(e) => set('description')(e.target.value)}
      />
      <KeepForYourself plan={vest} onChange={setVest} supply={wholeSupply} />
      {/* The Launchpad's default disclaimer: written into the coin's on-chain card and shown on its page. */}
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        {LAUNCH_DISCLAIMER}
      </p>
      <button
        type="button"
        onClick={() => setAdvanced((a) => !a)}
        aria-expanded={advanced}
        className="flex items-center justify-between bg-transparent border-0 p-0 text-sm font-bold cursor-pointer"
        style={{ color: GOLD }}
      >
        Advanced options
        <ChevronDown size={16} style={{ transform: advanced ? 'rotate(180deg)' : undefined }} />
      </button>
      {advanced && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <label className="flex-1 text-xs" style={{ color: MUTED }}>
              Decimals (0 = whole coins)
              <input
                className={`${input} mt-1`}
                style={inputStyle}
                inputMode="numeric"
                maxLength={2}
                value={opts.decimals}
                onChange={(e) => setOpt('decimals', e.target.value.replace(/\D/g, ''))}
              />
            </label>
            <label className="flex-1 text-xs" style={{ color: MUTED }}>
              Coins to enter the room
              <input
                className={`${input} mt-1`}
                style={inputStyle}
                inputMode="numeric"
                value={opts.roomMin}
                onChange={(e) => setOpt('roomMin', e.target.value)}
              />
            </label>
          </div>
          <label className="text-xs" style={{ color: MUTED }}>
            Category
            <select
              className={`${input} mt-1`}
              style={{ ...inputStyle, background: '#0d0e11' }}
              value={opts.category}
              onChange={(e) => setOpt('category', e.target.value)}
            >
              <option value="">None</option>
              {CATEGORIES.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <input
            className={input}
            style={inputStyle}
            placeholder="Website (https://…)"
            aria-label="Website"
            inputMode="url"
            value={opts.website}
            onChange={(e) => setOpt('website', e.target.value)}
          />
          <div className="flex gap-2">
            <input
              className={input}
              style={inputStyle}
              placeholder="X handle"
              aria-label="X handle"
              value={opts.x}
              onChange={(e) => setOpt('x', e.target.value)}
            />
            <input
              className={input}
              style={inputStyle}
              placeholder="Telegram"
              aria-label="Telegram"
              value={opts.telegram}
              onChange={(e) => setOpt('telegram', e.target.value)}
            />
          </div>
          <p className="text-[11px] m-0" style={{ color: MUTED }}>
            Links and category are written on-chain with the coin.
          </p>
        </div>
      )}
      <CurvePicker
        curve={curve}
        onChange={setCurve}
        accepted={curveOk}
        onAccept={setCurveOk}
        tokenSupply={Number(wholeSupply)}
        onUseStandardSupply={() => set('supply')(STANDARD_SUPPLY)}
      />
      {hasReturnsWording(`${form.name} ${form.description}`) && (
        <p className="text-xs m-0" style={{ color: GOLD }}>
          {RETURNS_WARNING}
        </p>
      )}
      <p className="text-xs m-0" style={{ color: MUTED }}>
        Launching costs ≈ {moneyWithSats(cost.totalSats, rate)}: {costSummary(cost, fmt)}. No share of your coin is
        taken.
      </p>
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        {DEPOSIT_NOTE}
      </p>
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm m-0" style={{ color: '#FF6B6B' }}>
            {error}
          </p>
          <ErrorActions message={error} />
        </div>
      )}
      <button type="button" onClick={review} className="bw-pill bw-pill-gold min-h-[44px] w-full text-sm font-bold">
        Review launch
      </button>
      {sheet && (
        <ApproveSheet
          lines={approvalLines(withOptions(form, opts), cost, fmt, !!icon, opts, vest, curve)}
          total={moneyWithSats(cost.totalSats, rate)}
          busy={busy}
          onAllow={() => void launch()}
          onCancel={() => !busy && setSheet(false)}
        />
      )}
    </section>
  );
};

/** The one approval sheet: every step listed, one Allow, nothing to untick. */
const ApproveSheet = ({
  lines,
  total,
  busy,
  onAllow,
  onCancel,
}: {
  lines: { label: string; value: string }[];
  total: string;
  busy: string;
  onAllow: () => void;
  onCancel: () => void;
}) => {
  useBackClose(true, onCancel);
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/70" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="Approve launch"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] rounded-t-2xl p-5 flex flex-col gap-3"
        style={{
          background: '#0d0e11',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
        }}
      >
        <div className="flex items-center gap-2 text-white text-lg font-extrabold">
          <Rocket size={18} color={GOLD} /> Launch this coin?
        </div>
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {lines.map((l) => (
            <li key={l.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2" style={{ color: MUTED }}>
                <Check size={14} color="#A1FF8B" /> {l.label}
              </span>
              <span className="text-white font-semibold text-right">{l.value}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] m-0" style={{ color: MUTED }}>
          {DEPOSIT_NOTE} {LAUNCH_NOTICE} {LAUNCH_DISCLAIMER}
        </p>
        <div className="flex items-center justify-between border-t pt-3 text-sm" style={{ borderColor: LINE }}>
          <span style={{ color: MUTED }}>Total</span>
          <span className="text-white font-bold">{total}</span>
        </div>
        <button
          type="button"
          disabled={!!busy}
          onClick={onAllow}
          className="bw-pill bw-pill-gold min-h-[48px] w-full text-base font-bold disabled:opacity-60"
        >
          {busy || 'Allow'}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={onCancel}
          className="text-sm bg-transparent border-0 cursor-pointer disabled:opacity-40"
          style={{ color: MUTED }}
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
};
