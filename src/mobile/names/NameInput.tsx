import { trustCurrentKey } from './binding';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Input } from '../../components/Input';
import type { Theme } from '../../theme.types';
import { loadPoisonData, poisonWarning } from '../airdrops/poison';
import { useServiceContext } from '../../hooks/useServiceContext';
import {
  destinationFor,
  externalLabel,
  isOurDomain,
  opnsBinding,
  parseRecipient,
  resolveRecipient,
  VIA_LABEL,
  type Resolved,
} from './names';
import { liveDomains, withDomain } from './paymailDomains';
import { BWALLET_PAYMAIL_DOMAIN } from './config';
import { payeeDetail, recipientHint } from './payeeText';
import { PLAIN_KEY_WARNING } from './pubkeyRecipient';

/**
 * Recipient box for the Send screens (build-time swap for upstream's address <Input>, see
 * vite.config.mobile.ts). Plain addresses pass straight through. A $handle, paymail or OpNS
 * name is resolved, shown as a card (name, avatar, destination type) and only handed to
 * upstream's send — as a paymail or address — after the user taps "Send to this name".
 */
type Props = {
  theme: Theme;
  value: string;
  onChange: (target: string) => void;
  asset: 'bsv' | 'token';
  placeholder?: string;
  style?: CSSProperties;
  /**
   * Send card: accept a resolved name without the extra "Send to this name" tap. The card stays
   * on screen (name, avatar, destination) and the Send button names the recipient instead.
   */
  autoConfirm?: boolean;
  /** What the box is doing, plus the resolved name when there is one. */
  /** Send card: a taller box with larger text (phone-first, big tap target). */
  big?: boolean;
  onStatus?: (status: 'empty' | 'typing' | 'loading' | 'error' | 'ready', resolved?: Resolved) => void;
};

/** The domain of a typed name@domain that is NOT ours (the picker shows it), else '' (= bWalletX). */
const pickedDomain = (typed: string) => {
  const m = typed.trim().match(/@([a-z0-9.-]+\.[a-z]{2,})$/i);
  return m && !isOurDomain(m[1]) ? m[1].toLowerCase() : '';
};

const short = (s: string) => (s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s);

export const NameInput = ({ theme, value, onChange, asset, placeholder, style, autoConfirm, onStatus, big }: Props) => {
  const [text, setText] = useState(value);
  const [state, setState] = useState<
    { s: 'idle' } | { s: 'loading' } | { s: 'error'; msg: string } | { s: 'resolved'; r: Resolved; confirmed: boolean }
  >({ s: 'idle' });
  const seq = useRef(0);
  // "Other wallet ▾" (owner, 13 Oct 2026): null until the picker is first opened, then the live domains.
  const [domains, setDomains] = useState<string[] | null>(null);
  const loadDomains = () => {
    if (domains) return;
    setDomains([]);
    liveDomains((u, i) => fetch(u, i))
      .then(setDomains)
      .catch(() => setDomains([]));
  };
  const lastOut = useRef(value);
  // Address-poisoning defence (airdrops/poison.ts): data saved by the last History / Airdrops scan.
  const { chromeStorageService } = useServiceContext();
  const acct = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const poison = acct ? poisonWarning(text, loadPoisonData(acct)) : null;

  const emit = (v: string) => {
    lastOut.current = v;
    onChange(v);
  };

  const status = useRef(onStatus);
  status.current = onStatus;

  const confirm = (r: Resolved) => {
    const d = destinationFor(r, asset);
    if (!d.ok) return;
    setState({ s: 'resolved', r, confirmed: true });
    emit(d.to);
    status.current?.('ready', r);
    // Remember who this name was when you chose to pay it (BRC-169 4.4 key-change check next time).
    if (r.pubkey && r.nameBinding && r.nameBinding !== 'bad')
      trustCurrentKey(r.input.replace(/^\$/, '').split('@')[0], r.pubkey);
  };

  const onType = (raw: string) => {
    setText(raw);
    const p = parseRecipient(raw);
    const n = ++seq.current;
    if (p.kind === 'empty' || p.kind === 'address') {
      setState({ s: 'idle' });
      emit(p.kind === 'address' ? p.address : '');
      status.current?.(p.kind === 'empty' ? 'empty' : 'ready');
      return;
    }
    // Invalid input is never handed upstream as an address, and the message shown here is the same
    // 'error' status that disables the Send button (sendLogic.sendButton).
    if (p.kind === 'invalid') {
      setState({ s: 'error', msg: p.reason });
      emit('');
      status.current?.('error');
      return;
    }
    emit('');
    setState({ s: 'loading' });
    status.current?.('loading');
    setTimeout(async () => {
      if (n !== seq.current) return;
      try {
        const r = await resolveRecipient((u, i) => fetch(u, i), p);
        if (n !== seq.current) return;
        if (autoConfirm && destinationFor(r, asset).ok) confirm(r);
        else {
          setState({ s: 'resolved', r, confirmed: false });
          status.current?.(destinationFor(r, asset).ok ? 'typing' : 'error', r);
        }
      } catch (e) {
        if (n !== seq.current) return;
        setState({ s: 'error', msg: e instanceof Error ? e.message : 'Lookup failed' });
        status.current?.('error');
      }
    }, 450);
  };

  // Value set from outside: cleared after a send → clear ours; a pasted or picked $handle / paymail /
  // name / address → treat it as typed, so names resolve and show their card.
  useEffect(() => {
    if (value !== lastOut.current) {
      lastOut.current = value;
      if (value) onType(value);
      else {
        seq.current++;
        setText('');
        setState({ s: 'idle' });
        status.current?.('empty');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const gray = theme.color.global.gray;
  const fg = theme.color.global.contrast;

  return (
    <div style={{ width: style?.width ?? '85%', margin: style?.margin ?? '0 auto' }} className="flex flex-col gap-2">
      <Input
        theme={theme}
        placeholder={placeholder ?? recipientHint(BWALLET_PAYMAIL_DOMAIN)}
        aria-label="Recipient: $name, paymail or address"
        type="text"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onType(e.target.value)}
        value={text}
        style={big ? { width: '100%', margin: 0, height: 52, fontSize: 16 } : { width: '100%', margin: 0 }}
      />
      <div className="flex items-center justify-end gap-1 text-[11px]" style={{ color: gray }}>
        <select
          id="bw-paymail-domain"
          aria-label="Name from another wallet"
          value={pickedDomain(text)}
          onFocus={loadDomains}
          onMouseDown={loadDomains}
          onChange={(e) => {
            const d = e.target.value;
            const next = d ? withDomain(text, d) : text.trim() ? `$${withDomain(text, 'x').split('@')[0]}` : '';
            onType(next);
          }}
          className="bg-transparent border-0 text-[11px] cursor-pointer"
          style={{ color: fg }}
        >
          {/* Never a bare "bWalletX" here: it read like a payment to us (owner, 16 Oct 2026). */}
          <option value="">From another wallet?</option>
          {[...new Set([...(domains ?? []), pickedDomain(text)].filter(Boolean))].map((d) => (
            <option key={d} value={d}>
              {d} (other wallet)
            </option>
          ))}
          {domains === null && <option disabled>Other wallet ▾</option>}
          {domains?.length === 0 && <option disabled>Checking other wallets…</option>}
        </select>
      </div>
      {state.s === 'loading' && (
        <div className="flex items-center gap-2 text-xs" style={{ color: gray }}>
          <Loader2 size={12} className="animate-spin" /> Looking up {text.trim()}…
        </div>
      )}
      {state.s === 'error' && (
        <p className="text-xs" style={{ color: '#ff4444' }}>
          {state.msg}
        </p>
      )}
      {state.s === 'resolved' &&
        (() => {
          const { r, confirmed } = state;
          const d = destinationFor(r, asset);
          return (
            <div
              className="rounded-xl p-3 flex flex-col gap-2"
              style={{ background: theme.color.global.row, border: `1px solid ${confirmed ? '#2ecc71' : gray + '40'}` }}
            >
              <div className="flex items-center gap-3">
                {r.avatar ? (
                  <img src={r.avatar} alt="" className="w-9 h-9 rounded-full object-cover" />
                ) : (
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold"
                    style={{ background: gray + '30', color: fg }}
                  >
                    {(r.displayName ?? r.input).replace(/^\$/, '').slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold truncate" style={{ color: fg }}>
                    {r.displayName ?? r.input}
                  </div>
                  <div className="text-[11px] truncate" style={{ color: gray }}>
                    {payeeDetail(r.input, d.ok ? d.to : r.target, short)}
                  </div>
                  <div className="text-[10px]" style={{ color: gray }}>
                    {asset === 'token' && d.ok && r.via !== 'opns-owner' && r.via !== 'pubkey'
                      ? 'Paymail ordinal address'
                      : VIA_LABEL[r.via]}
                  </div>
                  {r.external && (
                    <div
                      data-testid="external-paymail"
                      className="text-[11px] font-semibold break-all"
                      style={{ color: '#FEC84B' }}
                    >
                      {externalLabel(r)}
                    </div>
                  )}
                  {r.via === 'pubkey' && (
                    <div data-testid="pubkey-warning" className="text-[11px] mt-1" style={{ color: '#FEC84B' }}>
                      {PLAIN_KEY_WARNING}
                    </div>
                  )}
                  {r.didYouMean && (
                    <button
                      type="button"
                      onClick={() => onType(r.didYouMean!)}
                      className="mt-1 text-xs font-semibold border-0 bg-transparent p-0 cursor-pointer"
                      style={{ color: 'var(--bw-accent-hi)' }}
                    >
                      Did you mean {r.didYouMean}? (a bWalletX name)
                    </button>
                  )}
                  {r.nameBinding === 'signed' && (
                    <div className="text-[11px] flex items-center gap-1" style={{ color: '#2ecc71' }}>
                      <Check size={11} /> Signed by its owner · bound to {short(r.pubkey ?? '')}
                    </div>
                  )}
                  {r.nameBinding === 'unsigned' && (
                    <div className="text-[11px]" style={{ color: gray }}>
                      Not signed by its owner yet
                    </div>
                  )}
                  {opnsBinding(r) === 'bound' && (
                    <div className="text-[11px] flex items-center gap-1" style={{ color: '#2ecc71' }}>
                      <Check size={11} /> Verified on chain · bound to {short(r.pubkey ?? '')}
                    </div>
                  )}
                </div>
              </div>
              {!d.ok ? (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1 text-xs" style={{ color: '#ff4444' }}>
                    <X size={12} /> {d.error}
                  </div>
                  {r.nameBinding === 'changed' && r.pubkey && (
                    // A deliberate override (BRC-169 4.4): only after the payer has checked with the person.
                    <button
                      type="button"
                      className="self-start bg-transparent border-0 p-0 text-xs font-semibold underline cursor-pointer"
                      style={{ color: fg }}
                      onClick={() => {
                        trustCurrentKey(r.input.replace(/^\$/, '').split('@')[0], r.pubkey!);
                        onType(text);
                      }}
                    >
                      I've checked with them: trust the new wallet
                    </button>
                  )}
                </div>
              ) : confirmed ? (
                <div className="flex items-center gap-1 text-xs" style={{ color: '#2ecc71' }}>
                  <Check size={12} /> Recipient confirmed
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => confirm(r)}
                  className="w-full py-2 rounded-lg text-sm font-semibold border-0 cursor-pointer"
                  style={{ background: 'var(--bw-accent-hi)', color: '#000' }}
                >
                  {r.via === 'pubkey' ? 'Send to this key' : 'Send to this name'}
                </button>
              )}
            </div>
          );
        })()}
      {poison && (
        <div role="alert" className="text-xs mt-2 p-2 rounded-lg" style={{ background: '#2a1408', color: '#FEC84B' }}>
          {poison}
        </div>
      )}
    </div>
  );
};
