import { sendMnee, type OneSatContext } from '@1sat/actions';
import { sendBsv } from '../../utils/guardedSendBsv';
import { isNative } from '../native';
import { isPermissionDenied, type MediaKind } from '../permissions/mediaPermission';
import { defaultHttp } from '../chat/api';
import { mneeKeyDerivations } from '../../utils/mneeDerivations';
import { cachedExchangeRate, fetchExchangeRate } from '../../utils/wallet';
import { usdToSats } from '../money/money';
import { PAID_CALLS_ENABLED } from '../storeBuild';
import { CallsClient, walletCallSigner, type BlockEntry } from './api';
import { fetchPeerBPhone, myRateCard } from './bphone';
import { CallMedia } from './media';
import { verifyCaller } from './peer';
import { isShareCancelled } from './screenShare';
import {
  calleeShouldHangUp,
  decideMeterPayment,
  parsePayNotice,
  payNotice,
  payToFor,
  recordPayment,
  type Meter,
  type PayTo,
  type RateCard,
} from './rateCard';
import { busy, IDLE, reduce, type CallEvent, type CallState, type Peer, type ServerCall } from './machine';
import { guardedSendBsv21 } from '../../services/tokenSpendGuard';

/**
 * App-wide call controller (module singleton, like media/player.ts). The CallScreen overlay
 * mounted in App (vite.config.mobile.ts) starts it with the wallet context; CallsList and
 * TopNav read it.
 *
 * Ringing is POLLING while the app is open and visible: GET /wallet-calls every few seconds.
 * There is no push yet — a closed or backgrounded app does not ring (see calls/README note in
 * CallScreen.tsx: APNs/PushKit + CallKit on iOS, FCM + ConnectionService on Android).
 */

const POLL_IDLE_MS = 4000;
const POLL_CALL_MS = 1500;
const f = (u: string, i?: RequestInit) => fetch(u, i);
/** Smallest BSV payment the meter sends (above common dust limits); a tiny rate rounds up to it. */
const MIN_PAY_SATS = 546;
/** Give up (and let the callee's phone cut the call) after this many payment failures in a row. */
const MAX_PAY_FAILURES = 3;

type Listener = (s: Snapshot) => void;
export interface Snapshot {
  call: CallState;
  recent: ServerCall[];
  ready: boolean;
  error: string | null;
  /** Mic/camera refused by the OS or browser: the call screen offers Settings and retries on resume. */
  denied: MediaKind | null;
  /** We are sharing our screen. */
  sharing: boolean;
  /** The peer is sharing their screen to us. */
  remoteShare: boolean;
}

let snap: Snapshot = {
  call: IDLE,
  recent: [],
  ready: false,
  error: null,
  denied: null,
  sharing: false,
  remoteShare: false,
};
const listeners = new Set<Listener>();
let client: CallsClient | null = null;
let ctxRef: OneSatContext | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let media: CallMedia | null = null;
let myLabel: string | undefined;
/** How many MNEE deposit keys to scan when paying in MNEE (the account's maxKeyIndex + 1). */
let mneeKeyCount = 5;
let payFailures = 0;
const seenIncoming = new Set<string>();

const set = (patch: Partial<Snapshot>) => {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l(snap));
};
const dispatch = (e: CallEvent) => {
  const before = snap.call;
  const after = reduce(before, e);
  if (after !== before) {
    set({ call: after });
    if (busy(before) && !busy(after)) {
      void teardown();
      // ⚠ A LOCAL FAILURE MUST END THE CALL ON THE SERVER TOO. Without this the caller's screen
      // said "failed" while the server kept the call ringing: the callee answered into an empty
      // room, the caller's log showed "Outgoing · In progress", and the next dial was refused with
      // "already on a call" (8 Oct 2026).
      if (e.type === 'FAIL') endOnServer(callIdOfState(before));
    }
  }
};

const callIdOfState = (s: CallState): string | null => ('callId' in s ? s.callId : null);

function endOnServer(id: string | null) {
  if (client && id) void client.act(id, 'end').catch(() => undefined);
}

export const getSnapshot = () => snap;
export const subscribe = (l: Listener) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Start (or re-point) the controller at the unlocked wallet. Idempotent. */
export function startCalls(ctx: OneSatContext) {
  if (ctxRef === ctx && client) return;
  if (busy(snap.call)) void hangUp();
  ctxRef = ctx;
  client = new CallsClient(defaultHttp(isNative), walletCallSigner(ctx));
  schedule(0);
}

/** The name this wallet announces when it calls (shown to the callee, who re-verifies it). */
export const setCallLabel = (label: string | undefined) => {
  myLabel = label || undefined;
};

/** MNEE sends scan this many deposit keys (BsvWallet uses settings.maxKeyIndex + 1). */
export const setMneeKeyCount = (n: number) => {
  if (Number.isInteger(n) && n > 0) mneeKeyCount = n;
};

export function stopCalls() {
  if (busy(snap.call)) void hangUp();
  if (timer) clearTimeout(timer);
  timer = null;
  client = null;
  ctxRef = null;
  set({ ready: false });
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), ms);
}

async function tick() {
  const c = client;
  if (!c) return;
  const s = snap.call;
  try {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && !busy(s)) {
      return; // resumes on visibilitychange
    }
    if (s.phase === 'ringing-out' || s.phase === 'active' || s.phase === 'connecting' || s.phase === 'incoming') {
      if (s.phase === 'active' && PAID_CALLS_ENABLED) await meterTick(s);
      const call = await c.get(s.callId);
      dispatch({ type: 'REMOTE', callId: call.id, status: call.status, at: Date.now() });
    } else if (s.phase === 'quote') {
      // Nothing to poll while the caller reads the price.
    } else if (!busy(s)) {
      const { incoming, recent } = await c.list();
      set({ recent, ready: true, error: null });
      const ring = incoming.find((x) => !seenIncoming.has(x.id));
      if (ring) {
        seenIncoming.add(ring.id);
        const peer = await verifyCaller(f, ring.peer_key, ring.peer_label);
        dispatch({ type: 'RING_IN', call: ring, peer });
      }
    }
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (client === c) schedule(busy(snap.call) ? POLL_CALL_MS : POLL_IDLE_MS);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && client) schedule(0);
  });
}

async function joinMedia(callId: string) {
  if (!client) throw new Error('Calls are not ready');
  const t = await client.token(callId);
  const s = snap.call;
  const camera = 'camera' in s ? s.camera : false;
  const facing = 'facing' in s ? s.facing : 'user';
  media = new CallMedia();
  if (videoEls) media.bindVideo(videoEls.local, videoEls.remote, videoEls.screen);
  const { cameraFailed, micDenied, cameraDenied, micError } = await media.connect(
    t.url,
    t.token,
    {
      onDisconnected: () => {
        if (busy(snap.call)) dispatch({ type: 'FAIL', message: 'Connection lost' });
      },
      onRemoteVideo: (on) => dispatch({ type: 'REMOTE_VIDEO', on }),
      onRemoteShare: (on) => set({ remoteShare: on }),
      onLocalShareEnded: () => set({ sharing: false }),
      onData: (msg) => {
        const n = parsePayNotice(msg);
        if (n) dispatch({ type: 'RECEIPT', notice: n });
      },
    },
    { camera, facing },
  );
  if (cameraFailed) {
    dispatch({ type: 'TOGGLE_CAMERA' });
    if (!cameraDenied) set({ error: 'Camera unavailable — continuing as a voice call' });
  }
  if (micDenied || cameraDenied) set({ denied: micDenied ? 'mic' : 'camera' });
  if (micError) set({ error: `Microphone unavailable: ${micError}` });
}

let videoEls: {
  local: HTMLVideoElement | null;
  remote: HTMLVideoElement | null;
  screen: HTMLVideoElement | null;
} | null = null;
/** The CallScreen hands in its <video> elements (or nulls on unmount). */
export function bindVideo(
  local: HTMLVideoElement | null,
  remote: HTMLVideoElement | null,
  screen: HTMLVideoElement | null = null,
) {
  videoEls = local || remote || screen ? { local, remote, screen } : null;
  media?.bindVideo(local, remote, screen);
}

async function teardown() {
  const m = media;
  media = null;
  await m?.close();
  set({ denied: null, sharing: false, remoteShare: false });
  schedule(0);
}

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * Call someone. bPhone: if they charge for calls, show their rate first (phase 'quote') and only
 * ring once the caller accepts it with a max spend (acceptQuote). A store build never quotes:
 * it rings, and a callee who charges will end the unpaid call.
 */
export async function dial(peer: Peer, opts: { video?: boolean } = {}) {
  if (!client || busy(snap.call)) return;
  if (PAID_CALLS_ENABLED) {
    const bp = await fetchPeerBPhone(f, peer.key).catch(() => null);
    const card = bp?.profile.rate ?? null;
    if (card) {
      const payTo = payToFor(card, bp?.paymail ?? null);
      if (!payTo) {
        set({ error: `${peer.label} charges for calls but has nowhere to be paid yet` });
        return;
      }
      dispatch({ type: 'QUOTE', peer, card, payTo, video: !!opts.video });
      return;
    }
  }
  dispatch({ type: 'DIAL', peer, video: !!opts.video });
  await place(peer);
}

/** The caller agreed to the quoted rate with a max spend in the card's units: ring, metered. */
export async function acceptQuote(maxUnits: number) {
  const s = snap.call;
  if (!client || s.phase !== 'quote') return;
  dispatch({ type: 'ACCEPT_QUOTE', maxUnits });
  payFailures = 0;
  await place(s.peer);
}

export const declineQuote = () => dispatch({ type: 'DECLINE_QUOTE' });

async function place(peer: Peer) {
  if (!client) return;
  try {
    const call = await client.place(peer.key, { caller: myLabel, callee: peer.label });
    dispatch({ type: 'PLACED', callId: call.id });
    await joinMedia(call.id);
    schedule(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    dispatch({
      type: 'FAIL',
      message: msg,
      reason: /unavailable|too often|too many|not answered/i.test(msg) ? 'unavailable' : 'failed',
    });
  }
}

export async function accept(opts: { video?: boolean } = {}) {
  const s = snap.call;
  if (!client || s.phase !== 'incoming') return;
  // If I charge for calls, this call is metered on my side: the caller's receipts must keep up.
  const me = client.identityKey;
  const charging = PAID_CALLS_ENABLED && me ? myRateCard(me) : null;
  dispatch({ type: 'ACCEPT', video: !!opts.video, charging });
  try {
    await client.act(s.callId, 'accept');
    await joinMedia(s.callId);
    dispatch({ type: 'MEDIA_UP', at: Date.now() });
  } catch (e) {
    void client.act(s.callId, 'end').catch(() => undefined);
    dispatch({ type: 'FAIL', message: e instanceof Error ? e.message : String(e) });
  }
}

export async function decline() {
  const s = snap.call;
  if (!client || s.phase !== 'incoming') return;
  dispatch({ type: 'DECLINE' });
  await client.act(s.callId, 'decline').catch(() => undefined);
}

export async function hangUp(reason?: 'unpaid' | 'cap') {
  const s = snap.call;
  const id = 'callId' in s ? s.callId : null;
  dispatch({ type: 'HANGUP', at: Date.now(), reason });
  if (client && id) await client.act(id, 'end').catch(() => undefined);
}

// ── bPhone meter ─────────────────────────────────────────────────────────────

/**
 * Once per poll while the call is active. Caller: pay the next interval when it is due, send the
 * receipt over the data channel, stop at the cap. Callee: end the call when the caller has not
 * paid for the time being used (the first payment within FIRST_PAYMENT_S, then GRACE_S past
 * paid-through). A free call has neither and does nothing here.
 */
async function meterTick(s: Extract<CallState, { phase: 'active' }>) {
  const elapsedS = (Date.now() - s.since) / 1000;
  if (s.charging && calleeShouldHangUp(elapsedS, s.charging.paidThroughS)) {
    await hangUp('unpaid');
    return;
  }
  if (!s.paying || !ctxRef) return;
  const { meter, payTo } = s.paying;
  const d = decideMeterPayment(meter, elapsedS);
  if (!d.ok) {
    // Out of money under the cap: let what is paid run out, then hang up.
    if (d.reason === 'cap' && elapsedS >= meter.paidThroughS) await hangUp('cap');
    return;
  }
  if (d.units <= 0) {
    dispatch({ type: 'METER', meter: recordPayment(meter, d, null) });
    return;
  }
  dispatch({ type: 'METER', meter: { ...meter, paying: true } });
  try {
    const txid = await pay(ctxRef, meter.card, payTo, d.units);
    payFailures = 0;
    const next = recordPayment(meter, d, txid);
    // The call may have ended while the payment was in flight: never resurrect it.
    if (snap.call.phase === 'active' && snap.call.callId === s.callId) {
      dispatch({ type: 'METER', meter: next });
      await media?.sendData(payNotice(d.seq, d.units, d.throughS, txid));
    }
  } catch (e) {
    payFailures += 1;
    set({ error: `Payment failed: ${e instanceof Error ? e.message : String(e)}` });
    const cur = snap.call;
    if (cur.phase === 'active' && cur.paying) {
      dispatch({
        type: 'METER',
        meter: { ...cur.paying.meter, paying: false, stopped: payFailures >= MAX_PAY_FAILURES },
      });
    }
  }
}

/** One interval's payment, wallet to wallet. Returns the txid (null when the action gives none). */
async function pay(ctx: OneSatContext, card: RateCard, payTo: PayTo, units: number): Promise<string | null> {
  const asset = card.asset;
  if (asset.kind === 'bsv') {
    if (!('paymail' in payTo)) throw new Error('No paymail to pay');
    const rate = cachedExchangeRate() || (await fetchExchangeRate('main').catch(() => 0));
    const sats = usdToSats(units, rate);
    if (sats === null) throw new Error('BSV price unavailable');
    const res = await sendBsv.execute(ctx, {
      requests: [{ paymail: payTo.paymail, satoshis: Math.max(sats, MIN_PAY_SATS) }],
      requireVerified: true,
    } as Parameters<typeof sendBsv.execute>[1]);
    if (res.error || !res.txid) throw new Error(String(res.error ?? 'send failed'));
    return res.txid;
  }
  if (!('address' in payTo)) throw new Error('No address to pay');
  if (asset.kind === 'mnee') {
    const res = await sendMnee.execute(ctx, {
      recipients: [{ address: payTo.address, amount: units }],
      derivations: mneeKeyDerivations(0, mneeKeyCount),
    });
    if (res.error) throw new Error(res.error);
    return res.txid ?? null;
  }
  const raw = BigInt(Math.round(units * 10 ** asset.dec));
  const res = await guardedSendBsv21.execute(ctx, {
    tokenId: asset.id,
    recipients: [{ amount: raw, destination: { address: payTo.address } }],
  });
  if (res.error || !res.txid) throw new Error(String(res.error ?? 'send failed'));
  return res.txid;
}

/** The caller's meter right now (for the in-call spend counter), or null on a free call. */
export const currentMeter = (): Meter | null => {
  const s = snap.call;
  return 'paying' in s && s.paying ? s.paying.meter : null;
};

export async function toggleMute() {
  dispatch({ type: 'TOGGLE_MUTE' });
  const s = snap.call;
  if (s.phase === 'active') await media?.setMuted(s.muted);
}

export async function toggleSpeaker() {
  dispatch({ type: 'TOGGLE_SPEAKER' });
  const s = snap.call;
  if (s.phase === 'active') await media?.setSpeaker(s.speaker);
}

export async function toggleCamera() {
  dispatch({ type: 'TOGGLE_CAMERA' });
  const s = snap.call;
  if (!('camera' in s)) return;
  try {
    await media?.setCamera(s.camera, s.facing);
  } catch (e) {
    // Permission refused / no camera: put the button back and say why.
    if (s.camera) dispatch({ type: 'TOGGLE_CAMERA' });
    if (s.camera && isPermissionDenied(e)) set({ denied: 'camera' });
    else set({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** Back from Settings: try the refused mic/camera again so the call carries on without redialling. */
export async function retryDenied() {
  const s = snap.call;
  const kind = snap.denied;
  if (!kind || !media || !busy(s)) return;
  try {
    if (kind === 'mic') await media.setMuted('muted' in s ? s.muted : false);
    else if ('camera' in s && !s.camera) {
      await media.setCamera(true, s.facing);
      dispatch({ type: 'TOGGLE_CAMERA' });
    }
    set({ denied: null });
  } catch {
    /* still refused: keep the note */
  }
}

/** Start or stop sharing our screen (desktop browsers / extension; see screenShare.ts). */
export async function toggleScreenShare() {
  if (!media || snap.call.phase !== 'active') return;
  const on = !snap.sharing;
  try {
    await media.setScreenShare(on);
    set({ sharing: on });
  } catch (e) {
    set({ sharing: false });
    if (!isShareCancelled(e)) set({ error: `Screen sharing failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}

export const dismissDenied = () => set({ denied: null });

export async function flipCamera() {
  dispatch({ type: 'FLIP_CAMERA' });
  const s = snap.call;
  if ('camera' in s && s.camera) await media?.flipCamera(s.facing).catch(() => undefined);
}

export const dismiss = () => dispatch({ type: 'DISMISS' });

// ── Block list ──────────────────────────────────────────────────────────────

export async function blockCaller(key: string, label?: string) {
  if (!client) throw new Error('Calls are not ready');
  await client.block(key, label);
  const s = snap.call;
  if (s.phase === 'incoming' && s.peer.key === key) dispatch({ type: 'DECLINE' });
}

export async function unblockCaller(key: string) {
  if (!client) throw new Error('Calls are not ready');
  await client.unblock(key);
}

export async function listBlocked(): Promise<BlockEntry[]> {
  if (!client) return [];
  return client.blocks();
}

export const callsReady = () => client !== null;

/** The signed-in calls client, or null while the wallet is locked. */
export const getCallsClient = () => client;

export class CallsClientError extends Error {}
