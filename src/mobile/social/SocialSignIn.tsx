import { useEffect, useRef, useState } from 'react';
import { BadgeCheck, Loader2 } from 'lucide-react';
import { socialLoginEnabled } from '../storeBuild';
import { BWALLET_PAYMAIL_DOMAIN } from '../names/config';
import { CAP, fill, getCapabilities } from '../names/names';
import { paymailAvailable } from '../names/paymail';
import { forgetXHandle, rememberXHandle, xAlias, xPrefill } from './xHandle';

/** True when name@<our domain> already has an identity key (public lookup; nothing of this wallet is sent). */
const nameHasWallet = async (alias: string): Promise<boolean> => {
  try {
    const f = (u: string, i?: RequestInit) => fetch(u, i);
    const pki = (await getCapabilities(f, BWALLET_PAYMAIL_DOMAIN))[CAP.pki];
    if (typeof pki !== 'string') return false;
    const r = await f(fill(pki, alias, BWALLET_PAYMAIL_DOMAIN));
    return r.ok && !!((await r.json()) as { pubkey?: string }).pubkey;
  } catch {
    return false;
  }
};
import { isAgentCreatePending } from '../agents/agentCreate';
import {
  clearSocial,
  onSocialChange,
  NEW_ACCOUNT,
  socialError,
  socialProfile,
  startSocial,
  type SocialProvider,
} from './socialLogin';

/** bWalletX Desktop (Tauri): the X / Google redirect can't come back into the app, so the buttons can't work there. */
const inDesktopApp = () =>
  typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

export const XLogo = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
  </svg>
);
export const GoogleLogo = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
    <path
      fill="#FFC107"
      d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
    />
    <path
      fill="#FF3D00"
      d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
    />
    <path
      fill="#4CAF50"
      d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
    />
    <path
      fill="#1976D2"
      d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
    />
  </svg>
);

/**
 * Create Account: "Continue with X / Google" above the password form. Fills the account name and
 * photo from the verified profile; the verified handle is claimed after the wallet exists
 * (Choose your handle). Off in the store build until App Review is settled (storeBuild.ts).
 */
export const SocialSignIn = ({
  onProfile,
  onRestore,
  onClear,
  owner = NEW_ACCOUNT,
  check = false,
  xOnly = false,
}: {
  /** Create Account (owner, 24 Oct 2026): one optional "Link your X (Twitter)" button; fills name + photo. */
  xOnly?: boolean;
  /** Restore: an optional check that the 12 words own the verified name (restoreGuard.ts), never a sign-in. */
  check?: boolean;
  onProfile: (p: { name: string; avatar: string }) => void;
  /** The sign-in was removed (or expired): `avatar` is the photo this form filled from it, to take back out. */
  onClear?: (avatar: string) => void;
  /** Whose sign-in: NEW_ACCOUNT on Create / Restore / Import, else the account's identity address. */
  owner?: string;
  /** Create Account only: offered when the verified name already belongs to a wallet. */
  onRestore?: () => void;
}) => {
  const [profile, setProfile] = useState(() => socialProfile(owner));
  const [taken, setTaken] = useState('');
  const [error, setError] = useState(socialError);
  const [busy, setBusy] = useState<SocialProvider | null>(null);

  // Fill the (still editable) account name once per signed-in profile: on return from X / Google, and also
  // when the form mounts with a profile already saved, as it does when the app reloads the page on return
  // (owner, 6 Oct 2026: the name stayed empty). X fills the @handle, Google the display name.
  const filled = useRef('');
  const filledAvatar = useRef('');
  const onProfileRef = useRef(onProfile);
  onProfileRef.current = onProfile;
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;
  const fill = (p: ReturnType<typeof socialProfile>) => {
    if (!p) return;
    const key = `${p.provider}:${p.name}`;
    if (filled.current === key) return;
    filled.current = key;
    filledAvatar.current = p.avatar || '';
    if (xOnly) rememberXHandle(xAlias(p));
    onProfileRef.current(
      xOnly && p.provider === 'x'
        ? xPrefill(p)
        : {
            name: p.provider === 'x' ? p.name.replace(/^@/, '') : p.display || p.name.split('@')[0],
            avatar: p.avatar || '',
          },
    );
  };
  useEffect(() => {
    fill(socialProfile(owner));
    return onSocialChange(() => {
      const p = socialProfile(owner);
      setProfile(p);
      setError(socialError());
      setBusy(null);
      if (p) fill(p);
      else if (filled.current) {
        filled.current = '';
        onClearRef.current?.(filledAvatar.current);
        if (xOnly) forgetXHandle();
        filledAvatar.current = '';
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  // New Account makes new keys, so it can't bring back a wallet that already has this name (owner, 6 Oct 2026:
  // tried to get b0asex.x onto a phone that way and got an error). Say so and offer Restore (12 words).
  const alias = profile?.alias || '';
  const offerRestore = !!onRestore;
  // Create: is handle@<our domain> free for "Claim your name" to offer next? (Public lookup, nothing claimed.)
  const xa = xOnly ? xAlias(profile) : '';
  const [xFree, setXFree] = useState<boolean | null>(null);
  useEffect(() => {
    setXFree(null);
    if (!xa || !BWALLET_PAYMAIL_DOMAIN) return;
    let live = true;
    void paymailAvailable((u, i) => fetch(u, i), xa)
      .then((free) => live && setXFree(free))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [xa]);
  useEffect(() => {
    setTaken('');
    if (!offerRestore || !alias || !BWALLET_PAYMAIL_DOMAIN) return;
    let live = true;
    void nameHasWallet(alias).then((yes) => live && yes && setTaken(alias));
    return () => {
      live = false;
    };
  }, [alias, offerRestore]);
  // Not for agent accounts: an agent posting as someone's X account needs its own careful design (owner, 6 Oct 2026).
  if (!socialLoginEnabled() || isAgentCreatePending()) return null;

  const go = async (provider: SocialProvider) => {
    setBusy(provider);
    setError('');
    try {
      await startSocial(provider, owner);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in is unavailable');
      setBusy(null);
    }
  };

  if (profile)
    return (
      <div className={xOnly ? 'w-[85%] mb-3' : 'w-[92%] mb-4'}>
        <div className="flex items-center gap-3 rounded-xl px-3 py-2.5" style={{ background: 'var(--bw-surface)' }}>
          {profile.avatar ? <img src={profile.avatar} alt="" className="w-8 h-8 rounded-full" /> : null}
          <div className="flex-1 min-w-0 text-left">
            <div className="text-sm font-semibold text-white flex items-center gap-1">
              {profile.provider === 'x' ? `@${profile.name}` : profile.name}
              <BadgeCheck size={14} color="var(--bw-accent)" />
            </div>
            <div className="text-[11px]" style={{ color: '#98A2B3' }}>
              {check
                ? `Verified · the 12 words must be the wallet that owns ${alias || 'this name'}`
                : xOnly && xa && xFree
                  ? `Linked · $${xa} (${xa}@${BWALLET_PAYMAIL_DOMAIN}) is free; we'll offer it next`
                  : xOnly && xa && xFree === false
                    ? `Linked · ${xa}@${BWALLET_PAYMAIL_DOMAIN} is taken; you choose your name next`
                    : 'Verified · you choose your handle next'}
            </div>
          </div>
          <button
            type="button"
            onClick={clearSocial}
            className="text-xs bg-transparent border-0"
            style={{ color: '#98A2B3' }}
          >
            Remove
          </button>
        </div>
        {taken && onRestore ? (
          <div
            className="mt-2 rounded-xl px-3 py-2.5 text-left text-xs"
            style={{ background: '#2B2F36', color: '#E7E7E7' }}
          >
            <b>{taken}</b> is already linked to a wallet with its own 12-word recovery phrase. If you have it, enter it
            next: a new account would get new keys and couldn't use this name. The words stay on this phone, encrypted
            with your wallet password.
            <button
              type="button"
              onClick={onRestore}
              className="block mt-2 h-9 w-full rounded-lg text-sm font-semibold border-0"
              style={{ background: 'var(--bw-accent-hi)', color: '#15202B' }}
            >
              Enter the 12 words for {taken}
            </button>
          </div>
        ) : null}
      </div>
    );

  const desktop = inDesktopApp();
  if (xOnly)
    return (
      <div className="w-[85%] mb-3">
        <button
          type="button"
          onClick={() => void go('x')}
          disabled={!!busy || desktop}
          className="flex w-full items-center justify-center gap-2 h-11 rounded-xl text-sm font-semibold border-0"
          style={{ background: 'var(--bw-surface)', color: '#fff', opacity: desktop ? 0.5 : 1 }}
        >
          {busy === 'x' ? <Loader2 size={16} className="animate-spin" /> : <XLogo />}
          Link your X (Twitter)
        </button>
        <p className="text-[11px] mt-1.5 text-center" style={{ color: error ? '#FDA29B' : '#98A2B3' }}>
          {error ||
            (desktop
              ? 'Link X on web or in the phone app for now.'
              : 'Optional. Fills your name and photo, and offers your X handle as your $name.')}
        </p>
      </div>
    );
  const btn = (p: SocialProvider, label: string, icon: JSX.Element) => (
    <button
      type="button"
      onClick={() => void go(p)}
      disabled={!!busy || desktop}
      className="flex flex-1 items-center justify-center gap-2 h-11 rounded-xl text-sm font-semibold border-0"
      style={{ background: 'var(--bw-surface)', color: '#fff', opacity: desktop || (busy && busy !== p) ? 0.5 : 1 }}
    >
      {busy === p ? <Loader2 size={16} className="animate-spin" /> : icon}
      {label}
    </button>
  );

  return (
    <div className="w-[92%] mb-4">
      <div className="flex gap-2">
        {btn('x', check ? 'Check with X' : 'Continue with X', <XLogo />)}
        {btn('google', 'Google', <GoogleLogo />)}
      </div>
      <p className="text-[11px] mt-2 text-center" style={{ color: error ? '#FDA29B' : '#98A2B3' }}>
        {error ||
          (desktop
            ? check
              ? 'Check on web or in the phone app.'
              : 'Use X / Google on web or in the phone app for now.'
            : check
              ? 'Optional check, not a sign-in: confirms these 12 words are the wallet that owns your verified name.'
              : 'Optional: your X or Gmail name becomes your verified handle.')}
      </p>
    </div>
  );
};
