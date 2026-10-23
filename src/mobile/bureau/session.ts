import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { routeBchatUrl } from '../../services/bchatOrigin';
import type { OneSatContext } from '@1sat/actions';
import { defaultHttp, saveSession } from '../chat/api';
import { kycClient, signedInClient } from '../kyc/kycWallet';
import { isNative } from '../native';
import { BureauClient, type BytesFetch } from './api';

/** Document bytes with the bearer: native HTTP on the phone apps (no CORS), fetch in a browser. */
const bytesFetch: BytesFetch = async (url, headers) => {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.request({
      method: 'GET',
      url: await routeBchatUrl(url),
      headers,
      responseType: 'blob',
    });
    const b64 = typeof res.data === 'string' ? res.data : '';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime = res.headers['Content-Type'] ?? res.headers['content-type'] ?? '';
    return { status: res.status, mime, bytes };
  }
  const res = await fetch(url, { headers, credentials: 'omit' });
  return {
    status: res.status,
    mime: res.headers.get('content-type') ?? '',
    bytes: new Uint8Array(await res.arrayBuffer()),
  };
};

/** A client signed in as this wallet (identity-key wallet login; see api.ts). */
export const bureauClient = (ctx: OneSatContext) => {
  const tokenOf = (c: Awaited<ReturnType<typeof signedInClient>>) => {
    const t = c.current?.token;
    if (!t) throw new Error('Could not sign in to bit-sign with this wallet.');
    return t;
  };
  return new BureauClient({
    http: defaultHttp(isNative),
    bytes: bytesFetch,
    token: async () => tokenOf(await signedInClient(ctx)),
    refresh: async () => {
      saveSession(null);
      return tokenOf(await signedInClient(ctx, kycClient()));
    },
  });
};
