import { useEffect, useState, type ReactNode } from 'react';
import { loadSession } from '../chat/api';
import { isNative } from '../native';
import {
  deviceTimeZone,
  DEFAULT_UI_PREFS,
  fromServerPrefs,
  setLocalPreviews,
  toServerPrefs,
  type UiPrefs,
} from './logic';
import { onPushState, PUSH_PLATFORM, PushApi, pushEnabled, pushRegistered, setPushEnabled } from './register';
import { ErrorActions } from '../errors/ErrorActions';

/**
 * Settings › Notifications › Push notifications. The master switch is this device's (on by default in the
 * apps; in a browser it is off until you turn it on here, which is when the browser asks). Previews and
 * quiet hours are your account's (GET/PUT /v1/prefs), so they follow you to every device.
 */
const MUTED = '#8a8f98';
const PANEL = '#121316';
const LINE = '#1f2127';

type ToggleC = (p: { label: string; on: boolean; onChange: (v: boolean) => void }) => ReactNode;

const Row = ({ label, sub, right }: { label: string; sub?: string; right: ReactNode }) => (
  <div
    className="mb-2 flex items-center gap-3 rounded-xl px-3 py-3"
    style={{ background: PANEL, border: `1px solid ${LINE}` }}
  >
    <div className="min-w-0 flex-1">
      <p className="text-sm font-semibold text-white">{label}</p>
      {sub && (
        <p className="mt-0.5 text-xs" style={{ color: MUTED }}>
          {sub}
        </p>
      )}
    </div>
    {right}
  </div>
);

const TimeInput = ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
  <input
    type="time"
    aria-label={label}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="rounded-lg px-2 py-1 text-sm text-white outline-none"
    style={{ background: '#0b0b0b', border: `1px solid ${LINE}`, colorScheme: 'dark' }}
  />
);

export const PushSettings = ({ Toggle }: { Toggle: ToggleC }) => {
  const session = loadSession();
  const [on, setOn] = useState(pushEnabled());
  const [registered, setRegistered] = useState(pushRegistered());
  const [prefs, setPrefs] = useState<UiPrefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(
    () =>
      onPushState(() => {
        setOn(pushEnabled());
        setRegistered(pushRegistered());
      }),
    [],
  );
  useEffect(() => {
    if (!session) return;
    new PushApi(session.token)
      .prefs()
      .then((p) => {
        const u = fromServerPrefs(p);
        setLocalPreviews(u.previews);
        setPrefs(u);
      })
      .catch(() => setPrefs({ ...DEFAULT_UI_PREFS }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  const toggleMaster = async (v: boolean) => {
    setBusy(true);
    setError('');
    try {
      const ok = await setPushEnabled(v, session);
      if (v && !ok)
        setError(
          isNative
            ? 'Notifications are blocked for this app. Turn them on in your phone’s Settings.'
            : 'Your browser blocked notifications for this site. Allow them in the site settings, then try again.',
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn on notifications');
    } finally {
      setOn(pushEnabled());
      setRegistered(pushRegistered());
      setBusy(false);
    }
  };

  const save = async (next: UiPrefs) => {
    setPrefs(next);
    setLocalPreviews(next.previews);
    if (!session) return;
    setError('');
    try {
      await new PushApi(session.token).putPrefs(toServerPrefs(next, deviceTimeZone()));
      setSaved('Saved');
      window.setTimeout(() => setSaved(''), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };

  const where =
    PUSH_PLATFORM === 'web' ? 'this browser' : PUSH_PLATFORM === 'extension' ? 'this extension' : 'this phone';
  return (
    <div>
      <Row
        label="Push notifications"
        sub={
          !session
            ? 'Sign in to Chat first: notifications come for your bChat rooms and DMs.'
            : on && registered
              ? `On for ${where}`
              : on
                ? `On: waiting for ${where} to register`
                : `Off for ${where}`
        }
        right={<Toggle label="Push notifications" on={on} onChange={(v) => !busy && void toggleMaster(v)} />}
      />
      {session && prefs && (
        <>
          <Row
            label="Show message previews"
            sub="Off: “$alice sent you a message”. On: the message text shows on your lock screen."
            right={
              <Toggle
                label="Show message previews"
                on={prefs.previews}
                onChange={(v) => void save({ ...prefs, previews: v })}
              />
            }
          />
          <Row
            label="Sign-in alerts"
            sub="A notification when your chat handle signs in on a device."
            right={
              <Toggle
                label="Sign-in alerts"
                on={prefs.categories.sign_in !== false}
                onChange={(v) => void save({ ...prefs, categories: { ...prefs.categories, sign_in: v } })}
              />
            }
          />
          {/* Owner, 26 Oct 2026: bChatX meeting invites (push kind meeting_invite), on unless turned off. */}
          <Row
            label="Meeting invites"
            sub="A notification when you're invited to a meeting, and a tap that joins it once it starts."
            right={
              <Toggle
                label="Meeting invites"
                on={prefs.categories.meeting_invite !== false}
                onChange={(v) => void save({ ...prefs, categories: { ...prefs.categories, meeting_invite: v } })}
              />
            }
          />
          <Row
            label="Quiet hours"
            sub="No notifications in these hours (calls still ring)."
            right={<Toggle label="Quiet hours" on={prefs.quiet} onChange={(v) => void save({ ...prefs, quiet: v })} />}
          />
          {prefs.quiet && (
            <div className="mb-2 flex items-center gap-2 px-1 text-sm text-white">
              From
              <TimeInput
                label="Quiet from"
                value={prefs.quietFrom}
                onChange={(v) => v && void save({ ...prefs, quietFrom: v })}
              />
              to
              <TimeInput
                label="Quiet to"
                value={prefs.quietTo}
                onChange={(v) => v && void save({ ...prefs, quietTo: v })}
              />
            </div>
          )}
          <p className="mt-3 text-xs" style={{ color: MUTED }}>
            Groups notify on mentions unless you change it with the bell in the room. DMs always notify. Previews and
            quiet hours apply to all your devices.
          </p>
        </>
      )}
      {saved && (
        <p className="mt-2 text-xs" style={{ color: MUTED }}>
          {saved}
        </p>
      )}
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="mt-2 text-xs text-red-400">{error}</p>
          <ErrorActions message={String(error)} />
        </div>
      )}
    </div>
  );
};
