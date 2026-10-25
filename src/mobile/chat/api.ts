/**
 * bChat API client for the native Chat tab.
 *
 * Auth: the wallet signs bChat's own wallet-login challenge (BSM over
 * "bitcoinchat.online wallet login: <nonce>", kind 'yours') with its BRC-100
 * identity key — the same proof bChat's web "Yours" button asks for — and
 * keeps the session token /verify returns. Every call then sends it as
 * `Authorization: Bearer`, which bit-sign's resolveUserHandle accepts.
 *
 * Transport: on device, requests go through CapacitorHttp (native networking),
 * so the WebView's capacitor:// origin never meets CORS. In a browser it falls
 * back to fetch. Both are behind an injectable `Http` for tests.
 */
import { parseHistorySetting, type HistorySetting, type HistoryVisibility } from './history';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { getChatAccount, getChatReceiveAddress, LEGACY_SESSION_KEY, setChatAccount } from './chatAccount';
import { REPORTED_STORAGE_PREFIX, refusedMark, refusedRecently, reportedKey } from './walletAddress';
import type { ChatMessage, ChatRoom } from './messages';

import type { BchatContact } from './contacts';
import { BCHAT_PRIMARY_ORIGIN, routeBchatUrl } from '../../services/bchatOrigin';

/** Primary bChatX origin; requests are moved to the live one (chat.bwalletx.com fallback) by services/bchatOrigin. */
export const BCHAT_ORIGIN = BCHAT_PRIMARY_ORIGIN;
/** Room attachments: bit-sign MAX_UPLOAD_BYTES (25 MB a file); one request up to 4 MB, else 3 MB parts. */
export const ROOM_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const ROOM_SINGLE_REQUEST_BYTES = 4 * 1024 * 1024;
const ROOM_CHUNK_BYTES = 3 * 1024 * 1024;

export type HttpResponse = { status: number; data: unknown };
export type Http = (req: {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}) => Promise<HttpResponse>;

const nativeHttp: Http = async ({ method, url, headers, body }) => {
  const res = await CapacitorHttp.request({
    method,
    url: await routeBchatUrl(url),
    headers: body !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
    data: body,
    responseType: 'json',
  });
  return { status: res.status, data: res.data };
};

const fetchHttp: Http = async ({ method, url, headers, body }) => {
  const res = await fetch(await routeBchatUrl(url), {
    method,
    headers: body !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'omit',
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, data };
};

export const defaultHttp = (native: boolean): Http => (native ? nativeHttp : fetchHttp);

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The response body, for structured refusals (a token room's `token_gated` 403). */
    readonly data: unknown = null,
  ) {
    super(message);
  }
}

/** What signing needs from the wallet: its identity address and a BSM signer. */
export type SpendPer = 'message' | 'minute' | 'hour' | 'day';
export interface RoomSpendRule {
  amountRaw: string;
  per: SpendPer;
  to: 'issuer' | 'burn';
  unit?: 'token' | 'sats';
}
export interface IssuerChallenge {
  roomKey: string;
  kind: string | null;
  issuerAddress: string | null;
  claimedBy: string | null;
  youAreIssuer: boolean;
  message: string | null;
}

export interface ChatSigner {
  address: () => Promise<string>;
  sign: (message: string) => Promise<{ address: string; pubKey: string; sig: string }>;
  /**
   * The handle this wallet's owner already chose (their plain paymail name), for a wallet bChat has not
   * seen yet: bit-sign answers `needs_handle` + `claim_token` and the account is made under this name.
   * Never derived from an email or a provider (owner, 9 Oct 2026: users choose their handle).
   */
  handle?: () => Promise<string | null>;
  /**
   * The wallet's identity key and its BRC-43 signature over this sign-in's nonce (bit-sign
   * lib/adopt-wallet-name.ts). Lets bit-sign swap an auto `yours-xxxxxxxx` handle for the
   * paymail name the owner chose; the server looks the name up itself from the key.
   */
  identityProof?: (nonce: string) => Promise<{ identity_key: string; identity_signature: string } | null>;
  /**
   * Hex signature by the identity key over `walletAddressMessage(address, handle)` (walletAddress.ts), so
   * bChatX can show the owner's real balance on their profile. Best-effort; never blocks sign-in.
   */
  proveAddress?: (address: string, handle: string) => Promise<string>;
}

export interface SignInItem {
  at: string;
  device: 'ios-app' | 'android-app' | 'browser';
  newAccount: boolean;
}

/** Which kind of device is signing in, for the server's sign-in alert. */
export const signInClient = (): SignInItem['device'] => {
  try {
    const p = Capacitor.getPlatform();
    return p === 'ios' ? 'ios-app' : p === 'android' ? 'android-app' : 'browser';
  } catch {
    return 'browser';
  }
};

export interface ChatSession {
  token: string;
  handle: string;
  address: string;
  /** The wallet account (identity address) this session was made for; see setChatAccount. */
  account?: string;
}

/** Quote of the message being replied to (bit-sign stores it as event_payload.reply_to). */
export interface ReplyRef {
  id: string;
  author: string | null;
  snippet: string;
}

export interface MessagePage {
  messages: ChatMessage[];
  /** null when the server predates paging (no has_more field). */
  hasMore: boolean | null;
  /** Set when the server floored this reader's history (since_join room; chat/history.ts). */
  hiddenBefore?: string | null;
}

/** bit-sign's "Choose your handle first" refusal from signIn: open HandleFlow, then claimHandle with these. */
export const needsHandle = (e: unknown): { claimToken: string; address: string } | null => {
  if (!(e instanceof ChatApiError) || e.status !== 409) return null;
  const d = e.data as { needs_handle?: boolean; claim_token?: unknown; address?: unknown } | null;
  return d?.needs_handle && typeof d.claim_token === 'string' && typeof d.address === 'string'
    ? { claimToken: d.claim_token, address: d.address }
    : null;
};

const errorOf = (data: unknown, fallback: string) =>
  (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
    ? (data as { error: string }).error
    : '') || fallback;

export interface SocialProfile {
  provider: 'x' | 'google' | 'github' | 'linkedin';
  /** The provider's account id (stable; a renamed @name keeps it). */
  id?: string;
  /** X @name / GitHub login; Google: the email address (never stored or shown); LinkedIn: an opaque id. */
  name: string;
  display?: string | null;
  avatar?: string | null;
  /** @deprecated users choose their handle (owner, 9 Oct 2026). Old servers: `b0asex.x`; never .gmail now. */
  alias: string | null;
  /** New servers: open "Choose your handle"… */
  choose_handle?: boolean;
  /** …prefilled with this: the X @name only, never anything from an email. */
  suggested_handle?: string | null;
}

export type HandlesInfo = {
  handles: { handle: string; primary: boolean }[];
  max: number;
  nextFee: { pence: number; sats: number; to: string } | null;
};

/** bit-sign GET /me/handles → HandlesInfo. Pure. */
export function parseHandlesInfo(v: { handles?: unknown; max?: unknown; next_fee?: unknown } | null): HandlesInfo {
  const handles = (Array.isArray(v?.handles) ? v.handles : [])
    .map((h: { handle?: unknown; primary?: unknown }) => ({
      handle: String(h?.handle ?? '')
        .replace(/^\$/, '')
        .toLowerCase(),
      primary: h?.primary === true,
    }))
    .filter((h) => !!h.handle);
  const f = v?.next_fee as { pence?: unknown; sats?: unknown; to?: unknown } | null | undefined;
  const nextFee =
    f && Number(f.sats) > 0 && typeof f.to === 'string' && f.to
      ? { pence: Number(f.pence) || 0, sats: Math.ceil(Number(f.sats)), to: f.to }
      : null;
  return { handles, max: Number(v?.max) > 0 ? Number(v?.max) : 5, nextFee };
}

export class BchatClient {
  constructor(
    private readonly http: Http,
    private session: ChatSession | null = null,
    private readonly origin = BCHAT_ORIGIN,
  ) {}

  /** The signer of the last sign-in, kept to prove the receive address afterwards. */
  private signer: ChatSigner | null = null;

  get handle() {
    return this.session?.handle ?? null;
  }

  /**
   * Tell bChatX this account's BSV receive address, proven by the identity key, so the owner's bChatX
   * profile shows their real balance (bit-sign POST /api/bitsign/me/wallet-address). Best-effort: only
   * when the handle or address changed since the last report; every failure is ignored.
   */
  private async reportWalletAddress(): Promise<void> {
    try {
      const handle = this.session?.handle;
      const address = getChatReceiveAddress();
      if (!handle || !address || !this.signer?.proveAddress) return;
      const storageKey = `${REPORTED_STORAGE_PREFIX}${getChatAccount() ?? 'default'}`;
      const key = reportedKey(handle, address);
      const stored = localStorage.getItem(storageKey);
      if (stored === key || refusedRecently(stored, key, Date.now())) return;
      const signature = await this.signer.proveAddress(address, handle);
      try {
        await this.call('POST', '/api/bitsign/me/wallet-address', { address, signature });
      } catch (e) {
        // 403: this bChatX account has no bWalletX sign-in yet. Don't ask again on every open; retry after a day.
        if (e instanceof ChatApiError && e.status === 403)
          localStorage.setItem(storageKey, refusedMark(key, Date.now()));
        return;
      }
      localStorage.setItem(storageKey, key);
    } catch {
      /* best-effort: the profile shows "Open bWalletX" until a later sign-in reports it */
    }
  }

  get current() {
    return this.session;
  }

  protected async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth) {
      // A session made for another account (the wallet switched since) is never reused.
      const active = getChatAccount();
      if (this.session?.account && active && this.session.account !== active) this.session = null;
      if (!this.session) throw new ChatApiError('Not signed in to bChat', 401);
      headers.Authorization = `Bearer ${this.session.token}`;
    }
    let res: HttpResponse;
    try {
      res = await this.http({ method, url: `${this.origin}${path}`, headers, body });
    } catch (e) {
      throw new ChatApiError(e instanceof Error ? e.message : 'Network error', 0);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ChatApiError(errorOf(res.data, `bChat error ${res.status}`), res.status, res.data);
    }
    return res.data as T;
  }

  /** One JSON call for small feature clients (chat/invitesApi.ts) that keep their own routes. */
  request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    auth = true,
  ): Promise<unknown> {
    return this.call(method, path, body, auth);
  }

  /** Challenge → wallet BSM signature → verify. Returns (and keeps) the session. */
  async signIn(signer: ChatSigner): Promise<ChatSession> {
    this.signer = signer;
    let address = await signer.address();
    for (let attempt = 0; attempt < 2; attempt++) {
      const ch = await this.call<{ nonce: string; message: string }>(
        'POST',
        '/api/bitsign/auth/wallet/challenge',
        { address, kind: 'yours' },
        false,
      );
      const signed = await signer.sign(ch.message);
      const proof = await signer.identityProof?.(ch.nonce).catch(() => null);
      // The nonce is bound to the address it was issued for; if the wallet
      // signed with a different key, ask again for that one.
      if (signed.address !== address) {
        address = signed.address;
        continue;
      }
      const v = await this.call<{
        token?: string;
        handle?: string;
        needs_handle?: boolean;
        claim_token?: string;
        error?: string;
      }>(
        'POST',
        '/api/bitsign/auth/wallet/verify',
        // intent=sign-in: sign in as this wallet's owner, ignoring any stale cookie session in the
        // native cookie jar (bit-sign PR #41). Older servers ignore the field.
        {
          address,
          kind: 'yours',
          nonce: ch.nonce,
          pubkey_hex: signed.pubKey,
          signature: signed.sig,
          intent: 'sign-in',
          // For the "New sign-in to bChat" alert only (bit-sign lib/sign-in-alert.ts); not used for auth.
          client: signInClient(),
          ...(proof ?? {}),
        },
        false,
      );
      if (v.needs_handle && v.claim_token) {
        // A wallet bit-sign hasn't seen (bit-sign PR #102): no default handle any more, the owner's
        // chosen one makes the account. Without one, the caller shows "Choose your handle".
        const chosen = await signer.handle?.().catch(() => null);
        if (chosen) return this.claimHandle(v.claim_token, chosen, address);
        throw new ChatApiError('Choose your handle first.', 409, {
          needs_handle: true,
          claim_token: v.claim_token,
          address,
        });
      }
      if (!v.token || !v.handle) throw new ChatApiError('bChat sign-in failed', 401);
      const account = getChatAccount();
      this.session = { token: v.token, handle: v.handle, address, ...(account ? { account } : {}) };
      void this.reportWalletAddress();
      return this.session;
    }
    throw new ChatApiError('The wallet signed with an unexpected key', 401);
  }

  /**
   * Make the account for a proven-but-new wallet under the handle its owner chose
   * (bit-sign POST /api/bitsign/auth/wallet/handle; the address comes from the claim token).
   */
  async claimHandle(claimToken: string, handle: string, address: string): Promise<ChatSession> {
    const r = await this.call<{ token?: string; handle?: string }>(
      'POST',
      '/api/bitsign/auth/wallet/handle',
      { claim_token: claimToken, handle: handle.replace(/^\$/, '') },
      false,
    );
    if (!r.token || !r.handle) throw new ChatApiError('bChat sign-in failed', 401);
    const account = getChatAccount();
    this.session = { token: r.token, handle: r.handle, address, ...(account ? { account } : {}) };
    void this.reportWalletAddress();
    return this.session;
  }

  /**
   * Take the wallet's verified paymail name as the bChat handle (bit-sign
   * POST /api/bitsign/auth/wallet/paymail-handle). Only a provisional `yours-*`
   * handle is replaced server-side. Keeps the fresh session the server returns.
   */
  async claimPaymailHandle(proof: {
    paymail: string;
    identity_key: string;
    timestamp: number;
    signature: string;
  }): Promise<ChatSession> {
    const r = await this.call<{ token?: string; handle?: string; renamed?: boolean }>(
      'POST',
      '/api/bitsign/auth/wallet/paymail-handle',
      proof,
    );
    if (!this.session || !r.handle) throw new ChatApiError('bChat handle update failed', 500);
    this.session = { ...this.session, handle: r.handle, token: r.token || this.session.token };
    void this.reportWalletAddress();
    return this.session;
  }

  // ── Several names per account (bit-sign /me/handles; owner, 15 Oct 2026) ──

  /** This account's names, the max, and what the next extra name costs (null = free). */
  async listHandles(): Promise<HandlesInfo> {
    const r = await this.call<{ handles?: unknown; max?: unknown; next_fee?: unknown }>(
      'GET',
      '/api/bitsign/me/handles',
    );
    return parseHandlesInfo(r);
  }

  /** Add a name. Without `beef` bit-sign answers 402 `payment_required` with what to pay (ChatApiError.data). */
  async addHandle(handle: string, beef?: string): Promise<void> {
    await this.call('POST', '/api/bitsign/me/handles', { handle, ...(beef ? { beef } : {}) });
  }

  /** Remove a name (not the primary); bit-sign holds it for 90 days. */
  async removeHandle(handle: string): Promise<void> {
    await this.call('DELETE', '/api/bitsign/me/handles', { handle });
  }

  /** Make a name primary (30-day cooldown on bit-sign). Keeps the new session token it returns. */
  async setPrimaryHandle(handle: string): Promise<ChatSession> {
    const r = await this.call<{ token?: string; handle?: string }>('POST', '/api/bitsign/me/handle', { handle });
    if (!this.session) throw new ChatApiError('Not signed in to bChat', 401);
    this.session = { ...this.session, handle: r.handle || handle, token: r.token || this.session.token };
    return this.session;
  }

  /** bWalletX Continue with X / Google: start (no session) → the provider's sign-in URL. */
  async socialStart(provider: 'x' | 'google', verifierHash: string): Promise<string> {
    const r = await this.call<{ authorizeUrl?: string }>(
      'POST',
      '/api/bitsign/wallet/social/start',
      { provider, verifier_hash: verifierHash },
      false,
    );
    if (!r.authorizeUrl) throw new ChatApiError('Sign-in is unavailable', 500);
    return r.authorizeUrl;
  }

  /** What a returned ticket proves (name, photo, alias), without binding anything. */
  async socialPreview(ticket: string, secret: string): Promise<SocialProfile> {
    return this.call<SocialProfile>(
      'POST',
      '/api/bitsign/wallet/social/claim',
      { ticket, secret, preview: true },
      false,
    );
  }

  /** Record the verified X / Google name on this wallet's account; returns the alias it may now use. */
  async socialClaim(ticket: string, secret: string): Promise<SocialProfile> {
    return this.call<SocialProfile>('POST', '/api/bitsign/wallet/social/claim', { ticket, secret });
  }

  signOut() {
    this.session = null;
  }

  async rooms(): Promise<ChatRoom[]> {
    const r = await this.call<{ rooms?: ChatRoom[] }>('GET', '/api/bitsign/rooms');
    return r.rooms ?? [];
  }

  /**
   * One room's server metadata (GET /api/bitsign/rooms/[ticker]: membership-gated, the same row the list sends).
   * Used when a room was opened from a stub (just joined / just started) so its look (metadata.site + .look) still
   * shows. Null on any failure.
   */
  async roomMetadata(ticker: string): Promise<Record<string, unknown> | null> {
    try {
      const r = await this.call<{ room?: { metadata?: unknown } }>('GET', BchatClient.path(ticker));
      const m = r.room?.metadata;
      return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private static path(ticker: string) {
    return `/api/bitsign/rooms/${encodeURIComponent(ticker.replace(/^\$/, ''))}`;
  }

  /**
   * Newest page (or the page before `before`). Uses the paging params added on
   * bit-sign's feat/native-chat-api branch; against a server without them the
   * response has no has_more and is the OLDEST 200, so the caller catches up
   * with `since` (see latestPage).
   */
  async page(ticker: string, opts: { before?: string; limit?: number } = {}): Promise<MessagePage> {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (opts.before) q.set('before', opts.before);
    else q.set('latest', '1');
    const r = await this.call<{ messages?: ChatMessage[]; has_more?: boolean; history_hidden_before?: string | null }>(
      'GET',
      `${BchatClient.path(ticker)}/messages?${q}`,
    );
    return {
      messages: r.messages ?? [],
      hasMore: typeof r.has_more === 'boolean' ? r.has_more : null,
      hiddenBefore: typeof r.history_hidden_before === 'string' ? r.history_hidden_before : null,
    };
  }

  async since(ticker: string, sinceIso: string): Promise<ChatMessage[]> {
    const r = await this.call<{ messages?: ChatMessage[] }>(
      'GET',
      `${BchatClient.path(ticker)}/messages?since=${encodeURIComponent(sinceIso)}`,
    );
    return r.messages ?? [];
  }

  /**
   * Open a conversation at its end. With paging support that is one call; on
   * an older server, page forward with `since` (200 per call, capped) until
   * caught up, keeping the tail.
   */
  async latestPage(ticker: string, limit = 50): Promise<MessagePage> {
    const first = await this.page(ticker, { limit });
    if (first.hasMore !== null) return first;
    let all = first.messages;
    let batch = first.messages;
    for (let i = 0; i < 10 && batch.length >= 200; i++) {
      batch = await this.since(ticker, batch[batch.length - 1].created_at);
      all = all.concat(batch);
    }
    return { messages: all.slice(-Math.max(limit, 200)), hasMore: null };
  }

  /** `spend`: a priced room's payment (chat/roomSpend.ts), the message and payment in one tx. */
  async send(
    ticker: string,
    body: string,
    spend?: { beef: string; rule: string } | null,
    replyTo?: ReplyRef | null,
  ): Promise<ChatMessage | null> {
    const r = await this.call<{ message?: ChatMessage }>('POST', `${BchatClient.path(ticker)}/messages`, {
      body,
      ...(spend ? { spend } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
    return r.message ?? null;
  }

  /** Bearer header for byte requests (media), or throws when signed out. */
  private bearer(): string {
    const active = getChatAccount();
    if (this.session?.account && active && this.session.account !== active) this.session = null;
    if (!this.session) throw new ChatApiError('Not signed in to bChat', 401);
    return `Bearer ${this.session.token}`;
  }

  /**
   * A room attachment's bytes (member-gated on bit-sign, so it cannot be a plain <video src>).
   * Fetched only when the viewer taps it (chat/RoomMedia.tsx). Phone apps go through native HTTP.
   */
  async mediaBlob(ticker: string, mediaId: string, mime: string): Promise<Blob> {
    const url = `${this.origin}${BchatClient.path(ticker)}/media/${encodeURIComponent(mediaId)}`;
    const Authorization = this.bearer();
    if (Capacitor.isNativePlatform()) {
      const res = await CapacitorHttp.request({ method: 'GET', url, headers: { Authorization }, responseType: 'blob' });
      if (res.status < 200 || res.status >= 300) throw new ChatApiError(`Could not load (${res.status})`, res.status);
      const b64 = typeof res.data === 'string' ? res.data : '';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime || 'application/octet-stream' });
    }
    const res = await fetch(url, { headers: { Authorization }, credentials: 'omit' });
    if (!res.ok) throw new ChatApiError(`Could not load (${res.status})`, res.status);
    const blob = await res.blob();
    return mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob;
  }

  /**
   * Upload a photo or video into a room (bit-sign POST rooms/[ticker]/media, or /media/chunk in
   * 3 MB parts above 4 MB, as bChatX does). Free; the room's members see it in the thread.
   * Browser builds only (web, desktop, extension): the phone apps' HTTP bridge has no multipart.
   */
  async uploadMedia(ticker: string, file: File, onProgress?: (fraction: number) => void): Promise<void> {
    if (file.size > ROOM_UPLOAD_MAX_BYTES)
      throw new ChatApiError(`Files can be up to ${ROOM_UPLOAD_MAX_BYTES / 1024 / 1024} MB.`, 413);
    const Authorization = this.bearer();
    const base = `${this.origin}${BchatClient.path(ticker)}/media`;
    const post = async (url: string, form: FormData) => {
      const res = await fetch(url, { method: 'POST', headers: { Authorization }, body: form, credentials: 'omit' });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        skipped?: { reason: string }[];
        assembled?: boolean;
      } | null;
      if (!res.ok) throw new ChatApiError(data?.error || `Upload failed (${res.status})`, res.status, data);
      if (data?.skipped?.length) throw new ChatApiError(data.skipped[0].reason, 400, data);
      return data;
    };
    if (file.size <= ROOM_SINGLE_REQUEST_BYTES) {
      const form = new FormData();
      form.append('file', file, file.name);
      onProgress?.(0.1);
      await post(base, form);
      onProgress?.(1);
      return;
    }
    const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const total = Math.ceil(file.size / ROOM_CHUNK_BYTES);
    for (let seq = 0; seq < total; seq++) {
      const form = new FormData();
      form.append('uploadId', uploadId);
      form.append('seq', String(seq));
      form.append('total', String(total));
      form.append('chunk', file.slice(seq * ROOM_CHUNK_BYTES, (seq + 1) * ROOM_CHUNK_BYTES), `${file.name}.part${seq}`);
      if (seq === total - 1) {
        form.append('filename', file.name);
        form.append('mime', file.type || '');
      }
      const data = await post(`${base}/chunk`, form);
      onProgress?.((seq + 1) / total);
      if (seq === total - 1 && !data?.assembled) throw new ChatApiError('Upload did not complete', 500);
    }
  }

  /** Toggle my emoji reaction on a message (bit-sign appends a `reaction` event; toggled server-side). */
  async react(ticker: string, messageId: string, emoji: string): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/message/${encodeURIComponent(messageId)}/action`, {
      action: 'react',
      emoji,
    });
  }

  /** "I am typing" (best effort; throttle in the caller). */
  async typing(ticker: string): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/typing`, {});
  }

  /** Who else is typing now (handles). Older servers: 404 → nobody. */
  async whoIsTyping(ticker: string): Promise<string[]> {
    try {
      const r = await this.call<{ typing?: string[] }>('GET', `${BchatClient.path(ticker)}/typing`);
      return r.typing ?? [];
    } catch {
      return [];
    }
  }

  /** "Share to room": post one of my private $b answers publicly. */
  async shareBAnswer(ticker: string, id: string): Promise<ChatMessage | null> {
    const r = await this.call<{ message?: ChatMessage }>('POST', `${BchatClient.path(ticker)}/b-share`, { id });
    return r.message ?? null;
  }

  /**
   * Upload my own picture (bit-sign PUT /api/bitsign/me/avatar, PR #264): the file's original bytes as a data URL,
   * animated GIF / WebP / APNG kept as they are. The server checks type (magic bytes), ≤ 512 px and ≤ 2 MB, stores
   * it and sets my avatar_url. 503 until its migration runs: the caller treats that as "not available yet".
   */
  async uploadAvatar(dataUrl: string): Promise<AvatarUploaded> {
    return this.call('PUT', '/api/bitsign/me/avatar', { avatar: dataUrl });
  }

  /** My public bio (bit-sign GET /api/bitsign/me/bio, PR #270). 404 until that ships: the caller hides the field. */
  async getBio(): Promise<string | null> {
    const r = await this.call<{ bio?: string | null }>('GET', '/api/bitsign/me/bio');
    return typeof r.bio === 'string' && r.bio ? r.bio : null;
  }

  /** Set my public bio (≤ 160 chars; '' clears). Returns what the server stored. */
  async setBio(bio: string): Promise<string | null> {
    const r = await this.call<{ ok?: boolean; bio?: string | null }>('PUT', '/api/bitsign/me/bio', {
      bio: bio.trim() || null,
    });
    return typeof r.bio === 'string' && r.bio ? r.bio : null;
  }

  /** Publish my X / Google picture so other people's chat bubbles show it (bit-sign keeps a chosen photo). */
  async publishAvatar(url: string): Promise<void> {
    await this.call('POST', '/api/bitsign/avatars', { url });
  }

  async markRead(ticker: string): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/read`, {});
  }

  // ── bSpaces (docs/BSPACES-PLAN.md): the room's live space. Same member gate as the thread. ──

  /** bCal: your calendar — Spaces you follow (rooms you're in, reminders) and host/booked/guest in (bit-sign me/spaces/calendar). */
  async myCalendar(): Promise<unknown> {
    return this.call('GET', '/api/bitsign/me/spaces/calendar');
  }

  /** Reminder slots you have set (`booking:<id>` for scheduled Spaces). */
  async spaceReminders(): Promise<unknown> {
    return this.call('GET', '/api/bitsign/spaces/schedule/remind');
  }

  /** Remind me / stop reminding me about one scheduled Space. */
  async setSpaceReminder(slot: string, on: boolean): Promise<unknown> {
    return this.call('POST', '/api/bitsign/spaces/schedule/remind', { slot, on });
  }

  /** The room's live space: `{ space, participants, me }`, or `{ space: null }`. */
  async space(ticker: string): Promise<unknown> {
    return this.call('GET', `${BchatClient.path(ticker)}/space`);
  }

  /** join | heartbeat | leave | end | hand | role | step_down (bit-sign rooms/[ticker]/space). */
  async spaceAction(ticker: string, body: Record<string, unknown>): Promise<unknown> {
    return this.call('POST', `${BchatClient.path(ticker)}/space`, body);
  }

  /** A Space's transcript (speakers + host only; bit-sign answers 404 to anyone else). */
  async spaceTranscript(ticker: string, spaceId: string): Promise<unknown> {
    return this.call('GET', `${BchatClient.path(ticker)}/space/transcript?space_id=${encodeURIComponent(spaceId)}`);
  }

  /** Delete (redact) one of MY transcript lines. */
  async spaceRedactLine(ticker: string, id: string): Promise<unknown> {
    return this.call('PATCH', `${BchatClient.path(ticker)}/space/transcript`, { id });
  }

  /** Synced Space video (bit-sign rooms/[ticker]/space-video): item + clock, or item null. */
  async spaceVideo(ticker: string): Promise<unknown> {
    return this.call('GET', `${BchatClient.path(ticker)}/space-video`);
  }

  /** Staff only: play | pause | resume | seek | stop | set_loop, with optional if_version (409 when stale). */
  async spaceVideoAction(ticker: string, body: Record<string, unknown>): Promise<unknown> {
    return this.call('PATCH', `${BchatClient.path(ticker)}/space-video`, body);
  }

  /** Paid listening (bit-sign rooms/[ticker]/space/paid): config, my paid time and the next minute's signed plan. */
  async spacePaid(ticker: string): Promise<unknown> {
    return this.call('GET', `${BchatClient.path(ticker)}/space/paid`);
  }

  /** config | payout | pay (bit-sign rooms/[ticker]/space/paid). */
  async spacePaidAction(ticker: string, body: Record<string, unknown>): Promise<unknown> {
    return this.call('POST', `${BchatClient.path(ticker)}/space/paid`, body);
  }

  /** LiveKit join token. The server mints it from your participant row, never from the request. */
  async spaceToken(ticker: string): Promise<unknown> {
    return this.call('POST', `${BchatClient.path(ticker)}/space/token`, {});
  }

  /** The green room shown before entering: title, stage, counts, recording notice. */
  async spaceGreenRoom(ticker: string): Promise<unknown> {
    return this.call('GET', `${BchatClient.path(ticker)}/space/green-room`);
  }

  /**
   * Is a Space live in this room, asked WITHOUT membership: the same public guest route bChatX's
   * /s/<room> and the profile stage use (404 = nothing live; 200 / 403 sign-in or holders / 409 not
   * on the SFU = a live Space exists). The fallback when the member-gated GET space fails (not
   * signed in to bChat yet, not a member row), so the room still shows "Live now".
   */
  async spaceLivePublic(ticker: string): Promise<'live' | 'none' | 'unknown'> {
    try {
      await this.call('POST', `${BchatClient.path(ticker)}/space/guest-token`, {}, false);
      return 'live';
    } catch (e) {
      const st = e instanceof ChatApiError ? e.status : 0;
      if (st === 404) return 'none';
      if (st === 403 || st === 409) return 'live';
      return 'unknown';
    }
  }

  /** Listen anonymously: a hidden, listen-only token. No participant row; still member-gated (ticket). */
  async spaceAnonToken(ticker: string): Promise<unknown> {
    return this.call('POST', `${BchatClient.path(ticker)}/space/anon-token`, {});
  }

  /** The live space's permanent page `/s/<slug>` (host or room admin only). `{ page }`. */
  async spacePageLink(ticker: string): Promise<unknown> {
    return this.call('POST', `${BchatClient.path(ticker)}/space/page`, {});
  }

  /** A new invite `/i/<code>` to the live space (host or room admin only). `{ invite, managed }`. */
  async createSpaceInvite(ticker: string, opts: { expires_in: string; max_uses?: number }): Promise<unknown> {
    return this.call('POST', `${BchatClient.path(ticker)}/space/invite`, opts);
  }

  /** The live space's invites with uses (host or room admin only). `{ invites }`. */
  async spaceInvites(ticker: string): Promise<unknown> {
    return this.call('GET', `${BchatClient.path(ticker)}/space/invite`);
  }

  async revokeSpaceInvite(ticker: string, code: string): Promise<unknown> {
    return this.call('DELETE', `${BchatClient.path(ticker)}/space/invite?code=${encodeURIComponent(code)}`);
  }

  /** A new room invite `/i/<code>` (any member; it grants nothing). `{ invite, managed }`. */
  async createRoomInvite(ticker: string, opts: { expires_in: string; max_uses?: number }): Promise<unknown> {
    return this.call('POST', `${BchatClient.path(ticker)}/room-invite`, opts);
  }

  /** Your room invites (the room admin sees all). `{ invites }`. */
  async roomInvites(ticker: string): Promise<unknown> {
    return this.call('GET', `${BchatClient.path(ticker)}/room-invite`);
  }

  async revokeRoomInvite(ticker: string, code: string): Promise<unknown> {
    return this.call('DELETE', `${BchatClient.path(ticker)}/room-invite?code=${encodeURIComponent(code)}`);
  }

  /** Open an invite: counts one use for this visitor and answers `{ invite }` (no session needed). */
  async openInvite(code: string): Promise<unknown> {
    return this.call('POST', `/api/bitsign/space-invites/${encodeURIComponent(code)}/use`, {}, !!this.handle);
  }

  /** A Space's permanent page (public). `{ page }`. */
  async spacePage(slug: string): Promise<unknown> {
    return this.call('GET', `/api/bitsign/space-pages/${encodeURIComponent(slug)}`, undefined, false);
  }

  /** A room's public page (token / discoverable rooms). `{ page }`. */
  async roomPage(ticker: string): Promise<unknown> {
    return this.call('GET', `/api/bitsign/room-pages/${encodeURIComponent(ticker)}`, undefined, false);
  }

  /** Is there a room for this token key, and am I in it? (GET never joins.) */
  async tokenRoom(key: string): Promise<unknown> {
    return this.call('GET', `/api/bitsign/rooms/token-gated?key=${encodeURIComponent(key)}`);
  }

  /** Create (or open) the token's room. The server re-checks the holding. Returns its ticker. */
  async startTokenRoom(
    key: string,
    opts: { name?: string; min?: string; purpose?: string; personal_name?: string } = {},
  ): Promise<string> {
    const r = await this.call<{ ticker: string }>('POST', '/api/bitsign/rooms/token-gated', { key, ...opts });
    return r.ticker;
  }

  /** Ticket registry (bit-sign, docs/TICKETS.md): public list of tickets minted in bWallet. */
  async tickets(): Promise<unknown> {
    return this.call('GET', '/api/bitsign/tickets', undefined, false);
  }

  /** Ticket registry: announce a ticket you just minted (the server re-checks the deploy). */
  async registerTicket(body: Record<string, unknown>): Promise<void> {
    await this.call('POST', '/api/bitsign/tickets', body);
  }

  /** The token id bound to a personal name ("boase"), or null. For the "$BOASE ✓" check. */
  async personalToken(name: string): Promise<{ tokenId: string | null; ticker: string | null }> {
    const r = await this.call<{ token_id?: string | null; ticker?: string | null }>(
      'GET',
      `/api/bitsign/rooms/token-gated?name=${encodeURIComponent(name)}`,
    );
    return { tokenId: r.token_id ?? null, ticker: r.ticker ?? null };
  }

  /**
   * Link an existing token to this account's personal name (import, not mint). Body: the signed challenge
   * (names/existingToken.ts). NEEDS bit-sign: POST /api/bitsign/rooms/personal-import verifying the identity
   * signature and the issuer/holder proof, then binding name → token_id. Until it exists this 404s and the
   * client falls back to opening the token room with personal_name (bound when the handle matches).
   */
  async importPersonalToken(body: {
    name: string;
    token_id: string;
    message: string;
    identity_key: string;
    signature: string;
    proof?: { address: string; signature: string } | null;
  }): Promise<void> {
    await this.call('POST', '/api/bitsign/rooms/personal-import', body);
  }

  /** Room admin: the ban list. */
  async bans(ticker: string): Promise<{ handle: string | null; address: string | null; reason: string | null }[]> {
    const r = await this.call<{ bans?: { handle: string | null; address: string | null; reason: string | null }[] }>(
      'GET',
      `${BchatClient.path(ticker)}/bans`,
    );
    return r.bans ?? [];
  }

  /** Room admin: ban a $handle or an address (membership = holds the token AND not banned). */
  async ban(ticker: string, target: string, reason?: string): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/bans`, { target, reason });
  }

  async unban(ticker: string, target: string): Promise<void> {
    await this.call('DELETE', `${BchatClient.path(ticker)}/bans`, { target });
  }

  /** Room admin: change the membership minimum (whole tokens). */
  async setTokenRoomMinimum(ticker: string, min: string): Promise<void> {
    await this.call('PATCH', '/api/bitsign/rooms/token-gated', { ticker, min });
  }

  /**
   * Token room issuer: the chain-resolved issuer address and a fresh challenge to sign with
   * its key (only the token's issuer configures a token room).
   */
  async issuerChallenge(ticker: string): Promise<IssuerChallenge> {
    const r = await this.call<{
      room_key?: string;
      kind?: string | null;
      issuer_address?: string | null;
      claimed_by?: string | null;
      you_are_issuer?: boolean;
      message?: string | null;
    }>('GET', `${BchatClient.path(ticker)}/claim-issuer`);
    return {
      roomKey: r.room_key ?? '',
      kind: r.kind ?? null,
      issuerAddress: r.issuer_address ?? null,
      claimedBy: r.claimed_by ?? null,
      youAreIssuer: r.you_are_issuer === true,
      message: r.message ?? null,
    };
  }

  /** Prove the issuer address (compact BSM, base64) → become the room's admin. */
  async claimIssuer(ticker: string, message: string, signature: string): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/claim-issuer`, { message, signature });
  }

  /** Issuer only: minimum (whole tokens), spend rule (raw units; null clears), title. */
  async updateRoomSettings(
    ticker: string,
    s: { min?: string; spend?: RoomSpendRule | null; name?: string },
  ): Promise<void> {
    await this.call('PATCH', '/api/bitsign/rooms/token-gated', { ticker, ...s });
  }

  /** "New members can see earlier messages" (bit-sign rooms/[ticker]/history). Any member may read it. */
  async historySetting(ticker: string): Promise<HistorySetting> {
    return parseHistorySetting(await this.call('GET', `${BchatClient.path(ticker)}/history`));
  }

  /** Room admin only (the issuer in a token room, the owner in an open room); the server enforces it. */
  async setHistoryVisibility(ticker: string, visibility: HistoryVisibility): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/history`, { history_visibility: visibility });
  }

  /** Issuer only (token rooms): set or clear (null) the cover image, an image data URL. */
  async setRoomCover(ticker: string, dataUrl: string | null): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/cover`, { dataUrl });
  }

  /** Link wallet keys to the account: each proof is a DER signature over `message` by that key. */
  async proveAddresses(
    message: string,
    proofs: { pubkey_hex: string; signature: string; role: 'receive' | 'token' }[],
  ): Promise<{ accepted: string[] }> {
    const r = await this.call<{ accepted?: string[] }>('POST', '/api/bitsign/wallet/addresses', { message, proofs });
    return { accepted: r.accepted ?? [] };
  }

  /** Collection rooms: name the items held so the server can verify them. */
  async proveItems(key: string, outpoints: string[]): Promise<number> {
    const r = await this.call<{ accepted?: number }>('POST', '/api/bitsign/wallet/holdings', { key, outpoints });
    return r.accepted ?? 0;
  }

  /** Where to send this room's token to invite $handle (members only). */
  async inviteAddress(ticker: string, handle: string): Promise<string> {
    const r = await this.call<{ address: string }>(
      'GET',
      `${BchatClient.path(ticker)}/invite-address?handle=${encodeURIComponent(handle)}`,
    );
    return r.address;
  }

  // ── Bounties paid on merge (bit-sign feat/bounty-payouts; src/mobile/chat/bounties.ts) ──

  async bounties(ticker: string): Promise<unknown> {
    return this.call('GET', `${BchatClient.path(ticker)}/bounty`);
  }

  /** Claim by linking the PR. `agentLabel` names an agent acting for this handle. */
  async claimBounty(ticker: string, no: number, prUrl: string, agentLabel?: string): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/bounty/${no}/claim-pr`, {
      pr_url: prUrl.trim(),
      ...(agentLabel?.trim() ? { agent_label: agentLabel.trim() } : {}),
    });
  }

  /** Admin / treasury holder: the transfer spec this wallet performs. */
  async bountyPayoutSpec(ticker: string, no: number): Promise<unknown> {
    return this.call('GET', `${BchatClient.path(ticker)}/bounty/${no}/payout`);
  }

  /** After the wallet broadcast: record the txid (server marks the bounty paid, once). */
  async confirmBountyPayout(ticker: string, no: number, txid: string): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/bounty/${no}/payout`, { txid });
  }

  // ── bCredits (bit-sign lib/credits.ts; src/mobile/credits) ──

  /** Balance + public config (treasury, price, cap, terms, this account's deposit reference). */
  async credits(): Promise<unknown> {
    return this.call('GET', '/api/bitsign/credits');
  }

  async creditLedger(limit = 50): Promise<unknown> {
    return this.call('GET', `/api/bitsign/credits/ledger?limit=${limit}`);
  }

  /** After the wallet sent BSV + the reference output to the treasury: bit-sign verifies the tx and credits once. */
  async depositCredits(txid: string): Promise<unknown> {
    return this.call('POST', '/api/bitsign/credits/deposit', { txid });
  }

  // ── Verified identity (src/mobile/kyc) ──

  /** Ask bit-sign for a BRC-52 KYC certificate for this identity key (needs approved Veriff). */
  async kycWalletCert(body: { identity_key: string; timestamp: string; signature: string }): Promise<unknown> {
    const r = await this.call<{ certificate?: unknown }>('POST', '/api/bitsign/kyc/wallet-cert', body);
    return r.certificate ?? null;
  }

  /** bit-sign's current investor statements (server-supplied text). */
  async investorSelfCertOptions(): Promise<{ value?: unknown; label?: unknown; statement?: unknown }[]> {
    const r = await this.call<{ options?: { value?: unknown; label?: unknown; statement?: unknown }[] }>(
      'GET',
      '/api/bitsign/investor-self-cert',
    );
    return r.options ?? [];
  }

  /** Record an identity-key-signed self-certification. */
  async investorSelfCertWallet(body: {
    cert_type: string;
    statement_sha256: string;
    identity_key: string;
    timestamp: string;
    signature: string;
  }): Promise<void> {
    await this.call('POST', '/api/bitsign/investor-self-cert/wallet', body);
  }

  /** Share-offer audit event / register interest (identity-key signed). */
  async shareOfferEvent(body: {
    kind: 'view' | 'interest' | 'qualification';
    offer_ids: string[];
    identity_key: string;
    timestamp: string;
    signature: string;
  }): Promise<void> {
    await this.call('POST', '/api/bitsign/share-offers/events', body);
  }

  /**
   * The b agent's PAID endpoints (agent/paid.ts): price, quote, and the answer to a paid message.
   * Limited to /api/bitsign/agent/. The free composer chat (/api/bitsign/compose) is no longer used.
   */
  async agentCall(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    if (!path.startsWith('/api/bitsign/agent/')) throw new Error('Not a b agent endpoint');
    return this.call(method, path, body);
  }

  /**
   * Who the server says this token is (GET /api/bitsign/whoami). With `address`, also whether that wallet
   * address is a credential of that handle (null when the server can't say). Wallet card mismatch chip.
   */
  /** Is `name` free to use as this account's bChatX handle? (GET /api/bitsign/me/handle?check=). */
  async checkHandle(name: string): Promise<{ handle: string; available: boolean; error?: string }> {
    const r = await this.call<{ handle?: string; available?: boolean; error?: string }>(
      'GET',
      `/api/bitsign/me/handle?check=${encodeURIComponent(name.replace(/^[$@]/, ''))}`,
    );
    return { handle: r.handle ?? name, available: !!r.available, error: r.error };
  }

  /** Change this account's bChatX handle (POST /api/bitsign/me/handle). Returns the new session. */
  async changeHandle(name: string): Promise<ChatSession> {
    const r = await this.call<{ ok?: boolean; token?: string; handle?: string; error?: string }>(
      'POST',
      '/api/bitsign/me/handle',
      { handle: name.replace(/^[$@]/, '') },
    );
    if (!r.token || !r.handle || !this.session)
      throw new ChatApiError(r.error || 'Could not change your bChatX name', 400);
    this.session = { ...this.session, token: r.token, handle: r.handle };
    return this.session;
  }

  async whoami(address?: string): Promise<{ handle: string; addressLinked: boolean | null }> {
    const q = address ? `?address=${encodeURIComponent(address)}` : '';
    const r = await this.call<{ handle?: string; address_linked?: boolean | null }>('GET', `/api/bitsign/whoami${q}`);
    return { handle: r.handle ?? '', addressLinked: typeof r.address_linked === 'boolean' ? r.address_linked : null };
  }

  /** The last 10 sign-ins to this handle (GET /api/bitsign/me/sign-ins): Settings › Chat › Recent sign-ins. */
  async signIns(): Promise<SignInItem[]> {
    const r = await this.call<{ sign_ins?: SignInItem[] }>('GET', '/api/bitsign/me/sign-ins');
    return Array.isArray(r.sign_ins) ? r.sign_ins : [];
  }

  /** Profile pictures for up to 50 handles (bit-sign /api/bitsign/avatars): handle → https URL. */
  async avatars(handles: string[]): Promise<Record<string, string>> {
    if (!handles.length) return {};
    const q = handles.map((h) => encodeURIComponent(h)).join(',');
    const r = await this.call<{ avatars?: Record<string, string> }>('GET', `/api/bitsign/avatars?h=${q}`);
    return r.avatars ?? {};
  }

  /** bChat address book (bit-sign /api/bitsign/me/contacts), synced across devices. */
  async contacts(): Promise<BchatContact[]> {
    const r = await this.call<{ contacts?: BchatContact[] }>('GET', '/api/bitsign/me/contacts');
    return r.contacts ?? [];
  }

  async addContact(identifier: string, name?: string): Promise<void> {
    await this.call('POST', '/api/bitsign/me/contacts', { identifier: identifier.trim().replace(/^\$/, ''), name });
  }

  async removeContact(id: string): Promise<void> {
    await this.call('DELETE', `/api/bitsign/me/contacts?id=${encodeURIComponent(id)}`);
  }

  // ── Safety and account (bit-sign feat/store-fixes; src/mobile/ugc, src/mobile/account) ──

  /** Handles this account has blocked (bit-sign /api/bitsign/me/blocks). */
  async blocks(): Promise<string[]> {
    const r = await this.call<{ blocked?: string[] }>('GET', '/api/bitsign/me/blocks');
    return r.blocked ?? [];
  }

  /** Block $handle: the server refuses DMs between you both. */
  async block(handle: string): Promise<void> {
    await this.call('POST', '/api/bitsign/me/blocks', { handle: handle.trim().replace(/^\$/, '') });
  }

  async unblock(handle: string): Promise<void> {
    await this.call('DELETE', '/api/bitsign/me/blocks', { handle: handle.trim().replace(/^\$/, '') });
  }

  /** Feed bookmarks synced across this account's devices (bit-sign /api/bitsign/me/bookmarks). */
  async bookmarks<P extends { txid: string }>(): Promise<P[]> {
    const r = await this.call<{ bookmarks?: { post?: P }[] }>('GET', '/api/bitsign/me/bookmarks');
    return (r.bookmarks ?? []).map((b) => b.post).filter((p): p is P => !!p && typeof p.txid === 'string');
  }

  async addBookmark(post: { txid: string }): Promise<void> {
    await this.call('POST', '/api/bitsign/me/bookmarks', { post });
  }

  async removeBookmark(txid: string): Promise<void> {
    await this.call('DELETE', '/api/bitsign/me/bookmarks', { txid });
  }

  /**
   * bCorp sponsors a new user's first mint: a small gift of sats to their own address (bit-sign
   * /api/bitsign/sponsor/mint; once per handle and address, only to a near-empty wallet).
   */
  async sponsorMint(address: string): Promise<{ txid?: string; sats?: number }> {
    return this.call('POST', '/api/bitsign/sponsor/mint', { address });
  }

  /** This account's bAvatar edition: number (signup order), Founding 1,000 or not, and whether it is minted. */
  async bavatarMine(): Promise<BavatarMine> {
    return this.call('GET', '/api/bitsign/bavatar/mine');
  }

  /** bCorp pays a Founding 1,000 account's bAvatar mint fee: sats to its own address, once per account. */
  async sponsorBavatar(address: string): Promise<{ ok?: boolean; txid?: string; sats?: number }> {
    return this.call('POST', '/api/bitsign/bavatar/sponsor', { address });
  }

  /** Record the bAvatar inscription so the number shows as minted (once per account). */
  async recordBavatarMint(txid: string): Promise<{ ok?: boolean }> {
    return this.call('POST', '/api/bitsign/bavatar/minted', { txid });
  }

  /** Delete this bChat account (identity-key signed; see src/mobile/account/deleteAccount.ts). */
  async deleteAccount(body: {
    identity_key: string;
    timestamp: string;
    signature: string;
    confirm: 'DELETE';
  }): Promise<{ status?: string; retained?: string[]; note?: string }> {
    return this.call('POST', '/api/bitsign/account/delete', body);
  }

  /** Open (or find) the 1:1 room with $handle (Chat › DMs). Returns its ticker. */
  async openDirect(handle: string): Promise<string> {
    const r = await this.call<{ ticker: string }>('POST', '/api/bitsign/rooms/direct', {
      handle: handle.trim().replace(/^\$/, ''),
    });
    return r.ticker;
  }

  // ── Open rooms: no token to hold (docs/TOKEN-ROOMS.md › Open rooms) ──

  /** Public open rooms (raw; parsed by parsePublicRooms). */
  async openRooms(q = ''): Promise<unknown> {
    return this.call('GET', `/api/bitsign/rooms/open${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  }

  async createOpenRoom(body: {
    name: string;
    description?: string;
    visibility: 'public' | 'invite';
  }): Promise<{ ticker: string; name: string; invite_code: string | null }> {
    return this.call('POST', '/api/bitsign/rooms/open', body);
  }

  /** Join by invite code / link, or a public room by ticker. */
  async joinOpenRoom(by: { code: string } | { ticker: string }): Promise<{ ticker: string; name: string }> {
    return this.call('POST', '/api/bitsign/rooms/open/join', by);
  }

  /** The room card: description, role, members, and (owner / moderators) the invite code. */
  async openRoomCard(ticker: string): Promise<unknown> {
    return this.call('GET', `/api/bitsign/rooms/open/${encodeURIComponent(ticker.replace(/^\$/, ''))}`);
  }

  /**
   * Edit your own text message. The server APPENDS a version (nothing is overwritten) and
   * returns it: a new row whose `supersedes_id` is the one edited — merge it and it replaces
   * the old bubble in place (messages.ts mergeMessages). Author / text-only / latest-version
   * rules are the server's.
   */
  async editMessage(ticker: string, id: string, body: string): Promise<ChatMessage> {
    const r = await this.call<{ message: ChatMessage }>('PATCH', `${BchatClient.path(ticker)}/messages`, { id, body });
    return { ...r.message, edited: true };
  }

  async openRoomAction(
    ticker: string,
    action: 'leave' | 'remove' | 'add' | 'delete_message' | 'close' | 'mod' | 'unmod' | 'rotate_code',
    extra: { handle?: string; message_id?: string } = {},
  ): Promise<{ invite_code?: string }> {
    return this.call('POST', `/api/bitsign/rooms/open/${encodeURIComponent(ticker.replace(/^\$/, ''))}`, {
      action,
      ...extra,
    });
  }
}

// ── Session persistence (per wallet ACCOUNT) ──
/**
 * ⚠ ONE SESSION PER ACCOUNT. This used to be a single global key, so after switching accounts the
 * new account kept acting with the previous account's bit-sign token: a room created from
 * richardwboase.gmail was recorded as started by b0asex (8 Oct 2026). Sessions are now stored
 * under the active account's identity address (set at startup and on every switch by
 * `setChatAccount`) and carry that account, so a session can never be read by another account.
 */
const KEY = LEGACY_SESSION_KEY;
const keyFor = (account: string) => `${KEY}:${account}`;
export { setChatAccount, getChatAccount };

export const loadSession = (address?: string): ChatSession | null => {
  const chatAccount = getChatAccount();
  if (!chatAccount) return null;
  try {
    const s = JSON.parse(localStorage.getItem(keyFor(chatAccount)) || 'null') as ChatSession | null;
    if (!s?.token || !s.handle) return null;
    if (s.account && s.account !== chatAccount) return null;
    if (address && s.address !== address) return null;
    return s;
  } catch {
    return null;
  }
};

/** Fired on every sign-in / sign-out, so push registration (src/mobile/push) follows the bChat login. */
export const SESSION_EVENT = 'bwallet:bchat-session';

export const saveSession = (s: ChatSession | null) => {
  try {
    const chatAccount = getChatAccount();
    // No active account yet: nothing to store against (and nothing another account could pick up).
    if (chatAccount) {
      if (s) localStorage.setItem(keyFor(chatAccount), JSON.stringify({ ...s, account: chatAccount }));
      else localStorage.removeItem(keyFor(chatAccount));
    }
  } catch {
    /* storage unavailable */
  }
  try {
    window.dispatchEvent(new Event(SESSION_EVENT));
  } catch {
    /* no window (tests) */
  }
};

export type BavatarMine = {
  handle: string;
  number: number;
  founding: boolean;
  edition: number;
  minted: { txid: string; outpoint: string } | null;
  sponsored: boolean;
};

export type AvatarUploaded = {
  ok?: boolean;
  avatar_url: string;
  mime?: string;
  width?: number;
  height?: number;
  animated?: boolean;
};
