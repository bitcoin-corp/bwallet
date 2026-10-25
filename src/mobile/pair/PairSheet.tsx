import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Link2, Loader2, ShieldCheck } from 'lucide-react';
import { useBackClose } from '../backStack';
import { beginPairing, type PendingPair } from './sessions';
import { CliPairConfirm } from './CliPairConfirm';
import { CLI_ORIGIN } from './agentPairing';
import { IS_EXTENSION } from '../extension';
import { Capacitor } from '@capacitor/core';
import { switchBackHint } from './doneHint';
import { Scanner } from '../scan/Scanner';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const AMBER = '#F5A524';
const PANEL = '#17191E';

type Stage =
  | { k: 'scan' }
  | { k: 'joining' }
  | { k: 'confirm'; p: PendingPair }
  | { k: 'done'; origin: string; proven?: boolean }
  | { k: 'error'; m: string };

/**
 * "Scan to connect": point the camera at a site's bWallet QR, check the site, compare the 4-digit
 * code, Connect. After that the site's requests appear as normal bWallet approval prompts.
 */
export default function PairSheet({ onClose, initial }: { onClose: () => void; initial?: string }) {
  const [stage, setStage] = useState<Stage>(initial ? { k: 'joining' } : { k: 'scan' });
  const [paste, setPaste] = useState('');
  // Extension: a desktop can't scan its own screen, so paste comes first; the webcam is opt-in.
  const [camera, setCamera] = useState(!IS_EXTENSION);

  const close = () => {
    if (stage.k === 'confirm') stage.p.cancel();
    onClose();
  };
  useBackClose(true, close);

  const start = (text: string) => {
    setStage({ k: 'joining' });
    beginPairing(text)
      .then((p) => setStage({ k: 'confirm', p }))
      .catch((e: unknown) => setStage({ k: 'error', m: e instanceof Error ? e.message : String(e) }));
  };
  useEffect(() => {
    if (initial) start(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[420] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button onClick={close} aria-label="Back" className="p-2">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">
          {IS_EXTENSION ? 'Connect the CLI / an AI assistant' : 'Connect to a website'}
        </span>
      </div>
      <div className="flex flex-1 flex-col overflow-y-auto px-5 pb-10">
        {stage.k === 'scan' && (
          <>
            {IS_EXTENSION && (
              <p className="mt-4 text-sm" style={{ color: MUTED }}>
                On this computer run <span className="font-mono text-white">bwalletx login</span> (or open a site&apos;s
                pairing link) and paste the link it prints below. Opening a pairing link in Chrome also lands here.
              </p>
            )}
            {camera ? (
              <Scanner onCode={start} />
            ) : (
              <button
                onClick={() => setCamera(true)}
                className="mt-4 rounded-xl py-2.5 text-sm font-semibold text-white"
                style={{ background: PANEL }}
              >
                Use webcam to scan a QR code
              </button>
            )}
            {!IS_EXTENSION && (
              <p className="mt-4 text-center text-sm" style={{ color: MUTED }}>
                On your computer, choose <b className="text-white">Use bWallet on your phone</b> and point the camera at
                the code.
              </p>
            )}
            <div className="mt-6 flex gap-2">
              <input
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder={
                  IS_EXTENSION ? 'Paste pairing link (https://www.bwallet.space/pair?…)' : 'Or paste a pairing link'
                }
                aria-label="Pairing link"
                className="flex-1 rounded-xl px-3 py-2.5 text-sm text-white outline-none"
                style={{ background: PANEL, border: '1px solid #2A2A2C' }}
              />
              <button
                disabled={!paste.trim()}
                onClick={() => start(paste)}
                aria-label="Use pasted link"
                className="rounded-xl px-3"
                style={{ background: GOLD, color: '#000', opacity: paste.trim() ? 1 : 0.4 }}
              >
                <Link2 size={16} />
              </button>
            </div>
          </>
        )}

        {stage.k === 'joining' && (
          <div className="mt-24 flex flex-col items-center gap-3" style={{ color: MUTED }}>
            <Loader2 className="animate-spin" size={28} color={GOLD} />
            Checking the website…
          </div>
        )}

        {stage.k === 'confirm' && stage.p.cli && (
          <CliPairConfirm
            code={stage.p.code}
            origin={stage.p.origin}
            onCancel={close}
            onConnect={(g) => {
              stage.p.confirm(g);
              setStage({ k: 'done', origin: stage.p.origin });
            }}
          />
        )}

        {stage.k === 'confirm' && !stage.p.cli && (
          <div className="mt-8 flex flex-col items-center text-center">
            <span
              className="grid h-14 w-14 place-items-center rounded-2xl"
              style={{ background: 'rgb(var(--bw-accent-rgb) / 0.12)' }}
            >
              <ShieldCheck size={28} color={GOLD} />
            </span>
            <p className="mt-5 text-sm" style={{ color: MUTED }}>
              Connect your wallet to
            </p>
            {stage.p.proven ? (
              <p className="mt-1 break-all text-xl font-bold text-white">{new URL(stage.p.origin).host}</p>
            ) : (
              // Not proven (docs/PAIRING-ORIGIN-PROOF.md): the relay's origin is only what the other side claims.
              <>
                <p
                  className="mt-1 break-all text-xl font-bold"
                  style={{ color: AMBER }}
                  data-testid="pair-claimed-host"
                >
                  a site that claims to be {new URL(stage.p.origin).host}
                </p>
                <p className="mt-2 text-xs" style={{ color: AMBER }}>
                  bWalletX can&apos;t confirm this. Only connect if you opened the QR code on that site yourself.
                </p>
              </>
            )}
            <p className="mt-6 text-sm" style={{ color: MUTED }}>
              Check the website shows the same code:
            </p>
            <p className="mt-2 font-mono text-4xl font-bold tracking-[0.3em]" style={{ color: GOLD }}>
              {stage.p.code}
            </p>
            <p className="mt-6 text-xs" style={{ color: MUTED }}>
              The site can ask for approvals, which you&apos;ll see here as usual. It can&apos;t move anything without
              your OK.
            </p>
            <div className="mt-8 flex w-full gap-3">
              <button
                onClick={close}
                className="flex-1 rounded-xl py-3 font-semibold text-white"
                style={{ background: PANEL }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  stage.p.confirm();
                  setStage({ k: 'done', origin: stage.p.origin, proven: stage.p.proven });
                }}
                className="flex-1 rounded-xl py-3 font-bold"
                style={{ background: GOLD, color: '#000' }}
              >
                Connect
              </button>
            </div>
          </div>
        )}

        {stage.k === 'done' && (
          <div className="mt-20 flex flex-col items-center text-center">
            <span
              className="grid h-14 w-14 place-items-center rounded-full"
              style={{ background: 'rgba(46,204,113,0.15)' }}
            >
              <Check size={28} color="#2ecc71" />
            </span>
            <p className="mt-4 text-lg font-bold text-white">
              {stage.origin === CLI_ORIGIN
                ? 'Paired with the bWalletX CLI'
                : stage.proven
                  ? `Connected to ${new URL(stage.origin).host}`
                  : `Connected to a site that claims to be ${new URL(stage.origin).host}`}
            </p>
            <p className="mt-2 text-sm" style={{ color: MUTED }}>
              {IS_EXTENSION
                ? 'Requests are answered while the bWalletX side panel (or tab) is open; with it closed, CLI requests fail until you open it again.'
                : switchBackHint(
                    new URL(stage.origin).host,
                    Capacitor.getPlatform() === 'ios' || /iPhone|iPad|iPod/i.test(navigator.userAgent),
                  )}{' '}
              Disconnect any time in Settings › Paired websites.
            </p>
            <button
              onClick={onClose}
              className="mt-8 w-full rounded-xl py-3 font-bold"
              style={{ background: GOLD, color: '#000' }}
            >
              Done
            </button>
          </div>
        )}

        {stage.k === 'error' && (
          <div className="mt-20 flex flex-col items-center text-center">
            <p className="text-base font-semibold text-white">Couldn&apos;t connect</p>
            <p className="mt-2 text-sm" style={{ color: MUTED }}>
              {stage.m}
            </p>
            <button
              onClick={() => setStage({ k: 'scan' })}
              className="mt-8 w-full rounded-xl py-3 font-bold"
              style={{ background: GOLD, color: '#000' }}
            >
              {IS_EXTENSION ? 'Try again' : 'Scan again'}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
