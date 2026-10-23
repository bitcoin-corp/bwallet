import { offerInvoiceLink } from '../wallet/purpose/invoiceLinks';
import { lazy, Suspense, useContext, useState } from 'react';
import { SEEDLESS_ENABLED } from '../passkey/prf';
import { createPortal } from 'react-dom';
import { MyFlipBavatar } from '../bavatar/FlipBavatar';
import { ArrowLeft, Copy, Mail, QrCode, ScanLine, Send } from 'lucide-react';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { asMenuItem } from '../tabs/tabs';
import { requestPay } from '../wallet/payNav';
import { openBMailTo } from '../bmail/store';
import { requestBackupThen } from '../backup/backupState';
import { useAccountNames } from '../names/accountNames';
import { Scanner } from './Scanner';
import { parseScan, type Scan } from './parseScan';
import { offerAppLink } from '../spaces/inviteLinks';
import { parseXInviteLink } from '../chat/xInvites';
import { APP_NAME, XINVITES_ENABLED } from '../storeBuild';

const PairSheet = lazy(() => import('../pair/PairSheet'));
const OpenHereSheet = SEEDLESS_ENABLED
  ? lazy(() => import('../passkey/OpenHereSheet').then((m) => ({ default: m.OpenHereSheet })))
  : null;

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const PANEL = '#17191E';
const SATS = 100_000_000;

type Stage = { k: 'scan' } | { k: 'mine' } | { k: 'result'; s: Scan };

/**
 * "Scan": one camera sheet for everything bWallet understands (scan/parseScan.ts). Payment codes and
 * person pages land on the prefilled Send card (never sends by itself: the usual confirm sheet and
 * look-alike check still run); pairing codes go to the pairing screen; anything else is shown as text.
 */
export default function ScanSheet({
  onClose,
  receiveAddress,
  onPay,
}: {
  onClose: () => void;
  receiveAddress?: string;
  /** Already on the Send card: fill that row instead of opening Send (payNav). */
  onPay?: (to: string, amountSats?: number) => void;
}) {
  const [stage, setStage] = useState<Stage>({ k: 'scan' });
  const [paste, setPaste] = useState('');
  const [copied, setCopied] = useState(false);
  const selectTab = useContext(BottomMenuContext)?.handleSelect;
  const { chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const myAddress = receiveAddress || account?.addresses?.bsvAddress || '';
  const names = useAccountNames(account?.addresses?.identityAddress, account?.name ?? '', '', false);

  useBackClose(true, onClose);

  const pay = (to: string, amountSats?: number) => {
    if (onPay) onPay(to, amountSats);
    else {
      requestPay(to, amountSats);
      selectTab?.(asMenuItem('bsv'));
    }
    onClose();
  };

  const onCode = (text: string) => {
    // A room X invite link (key in its fragment): straight to the Chat claim screen, never shown or kept here.
    if (XINVITES_ENABLED && parseXInviteLink(text)) {
      offerAppLink(text.trim());
      onClose();
      return;
    }
    // An invoice QR (wallet/purpose/invoice.ts): the Wallet verifies it and pre-fills Send (still needs confirm).
    if (offerInvoiceLink(text)) {
      onClose();
      return;
    }
    const s = parseScan(text);
    // A plain payment code goes straight to the Send card (still needs the user's confirm there).
    if (s.kind === 'pay') pay(s.to, s.amountSats);
    // A Space / invite / room link opens its join flow (inviteLinks.ts: Space card, or the room's buy-to-enter screen).
    else if (s.kind === 'join') {
      offerAppLink(s.url);
      onClose();
    } else setStage({ k: 'result', s });
  };

  if (OpenHereSheet && stage.k === 'result' && stage.s.kind === 'open') {
    return (
      <Suspense fallback={null}>
        <OpenHereSheet scanned={stage.s.text} onClose={onClose} />
      </Suspense>
    );
  }

  if (stage.k === 'result' && stage.s.kind === 'pair') {
    return (
      <Suspense fallback={null}>
        <PairSheet initial={stage.s.text} onClose={onClose} />
      </Suspense>
    );
  }

  const copy = (t: string) => {
    navigator.clipboard
      ?.writeText(t)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  const big = 'flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl py-3 font-bold border-0';

  return createPortal(
    // Between the app's bars (owner, 17 Oct 2026: it ran under the tab bar).
    <div className="bw-between-bars z-[420] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div className="flex items-center gap-2 px-2 py-2">
        <button
          onClick={stage.k === 'scan' ? onClose : () => setStage({ k: 'scan' })}
          aria-label="Back"
          className="w-11 h-11 flex items-center justify-center bg-transparent border-0"
        >
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">{stage.k === 'mine' ? 'My code' : 'Scan'}</span>
      </div>
      <div className="flex flex-1 flex-col overflow-y-auto px-5 pb-10">
        {stage.k === 'scan' && (
          <>
            <Scanner onCode={onCode} />
            <p className="mt-4 text-center text-sm" style={{ color: MUTED }}>
              Scan a payment code, someone&apos;s bWallet code or a website&apos;s connect code.
            </p>
            <div className="mt-5 flex gap-2">
              <input
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder={`Or paste an address, $name (${APP_NAME}) or link`}
                aria-label="Paste a code"
                className="flex-1 min-w-0 rounded-xl px-3 py-2.5 text-sm text-white outline-none"
                style={{ background: PANEL, border: '1px solid #2A2A2C' }}
              />
              <button
                disabled={!paste.trim()}
                onClick={() => onCode(paste)}
                aria-label="Use pasted code"
                className="w-11 rounded-xl flex items-center justify-center border-0"
                style={{ background: GOLD, color: '#000', opacity: paste.trim() ? 1 : 0.4 }}
              >
                <ScanLine size={16} />
              </button>
            </div>
            {myAddress && (
              <button
                onClick={() => void requestBackupThen(chromeStorageService, () => setStage({ k: 'mine' }))}
                className={`${big} mt-6 text-white`}
                style={{ background: PANEL }}
              >
                <QrCode size={18} color={GOLD} /> Show my code
              </button>
            )}
          </>
        )}

        {stage.k === 'mine' && (
          <div className="mt-6 flex flex-col items-center text-center">
            {/* Owner, 17 Oct 2026: show the bAvatar; tap it to turn over to the pay code (FlipBavatar). */}
            <MyFlipBavatar address={myAddress} size={240} />
            {names.paymail && <p className="mt-4 text-base font-bold text-white">{names.paymail}</p>}
            <p className="mt-2 break-all font-mono text-xs" style={{ color: MUTED }}>
              {myAddress}
            </p>
            <p className="mt-4 text-sm" style={{ color: MUTED }}>
              Tap your bAvatar to show your code. Another bWallet can scan it to pay you.
            </p>
            <button onClick={() => copy(myAddress)} className={`${big} mt-6 text-white`} style={{ background: PANEL }}>
              <Copy size={16} /> {copied ? 'Copied' : 'Copy address'}
            </button>
          </div>
        )}

        {stage.k === 'result' && stage.s.kind === 'person' && (
          <div className="mt-10 flex flex-col items-center text-center">
            <p className="text-sm" style={{ color: MUTED }}>
              bWallet person
            </p>
            <p className="mt-1 break-all text-2xl font-bold text-white">{stage.s.to}</p>
            <button
              onClick={() => stage.s.kind === 'person' && pay(stage.s.to)}
              className={`${big} mt-8`}
              style={{ background: GOLD, color: '#000' }}
            >
              <Send size={16} /> Send money
            </button>
            <button
              onClick={() => {
                if (stage.s.kind !== 'person') return;
                openBMailTo(stage.s.to);
                onClose();
              }}
              className={`${big} mt-3 text-white`}
              style={{ background: PANEL }}
            >
              <Mail size={16} /> Send a bMail
            </button>
          </div>
        )}

        {stage.k === 'result' && stage.s.kind === 'pay' && (
          // Normally handled in onCode; kept so the type is exhaustive.
          <button
            onClick={() => stage.s.kind === 'pay' && pay(stage.s.to, stage.s.amountSats)}
            className={`${big} mt-10`}
            style={{ background: GOLD, color: '#000' }}
          >
            Pay {stage.s.to}
            {stage.s.amountSats ? ` ${stage.s.amountSats / SATS} BSV` : ''}
          </button>
        )}

        {stage.k === 'result' && stage.s.kind === 'restore' && (
          <div className="mt-10 flex flex-col">
            <p className="text-base font-semibold text-white">This puts a wallet on a device</p>
            <p className="mt-1 text-sm" style={{ color: MUTED }}>
              The computer is offering to move its wallet to a phone. It opens in your browser, where you restore with
              your passkey. It does not change the wallet you are signed into here.
            </p>
            <button
              onClick={() => stage.s.kind === 'restore' && window.open(stage.s.url, '_blank')}
              className={`${big} mt-5`}
              style={{ background: GOLD, color: '#000' }}
            >
              Open in browser
            </button>
            <button
              onClick={() => setStage({ k: 'scan' })}
              className={`${big} mt-3 text-white`}
              style={{ background: PANEL }}
            >
              Scan again
            </button>
          </div>
        )}

        {stage.k === 'result' && stage.s.kind === 'text' && (
          <div className="mt-10 flex flex-col">
            <p className="text-base font-semibold text-white">Not a bWallet code</p>
            <p className="mt-1 text-sm" style={{ color: MUTED }}>
              This QR code contains:
            </p>
            <p
              className="mt-3 max-h-60 overflow-y-auto break-all rounded-xl p-3 font-mono text-xs text-white select-text"
              style={{ background: PANEL }}
            >
              {stage.s.text || '(empty)'}
            </p>
            <button
              onClick={() => stage.s.kind === 'text' && copy(stage.s.text)}
              className={`${big} mt-5 text-white`}
              style={{ background: PANEL }}
            >
              <Copy size={16} /> {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={() => setStage({ k: 'scan' })}
              className={`${big} mt-3`}
              style={{ background: GOLD, color: '#000' }}
            >
              Scan again
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
