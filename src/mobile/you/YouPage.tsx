/**
 * You (/m/you): Names, Rooms and Tickets as three separate things (approved screens, 24 Oct 2026).
 * Live today on existing bit-sign endpoints: Names (WalletNames: /me/handles, main name follows the account
 * on every device) and Rooms with no token (open rooms: /rooms/open). Behind NRT_ENABLED (off): a room inside
 * another room, Tickets, and the "You already have one" guard lookups. Server needs:
 * /Volumes/2026/Projects/NAMES-ROOMS-TICKETS-SERVER-SPEC.md.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { WalletNames } from '../settings/WalletNames';
import { signedInClient, kycClient } from '../kyc/kycWallet';
import type { ChatRoom } from '../chat/messages';
import { roomNameProblem, type OpenVisibility } from '../chat/openRooms';
import { getPaymail } from '../names/accountName';
import { NRT_ENABLED } from '../storeBuild';
import { myRooms, roomPath, slugPart, subRoomProblem } from './nrt';

const TicketsPanel = NRT_ENABLED ? lazy(() => import('./TicketsPanel')) : null;

const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';

type View = { v: 'main' } | { v: 'names' } | { v: 'rooms' } | { v: 'new' } | { v: 'tickets'; room: ChatRoom };

const STATUS: [string, boolean][] = [
  ['Names: main name follows your key on every device', true],
  ['Rooms with no token (Anyone / Invite only)', true],
  ['A room inside another room (studio.yourname)', NRT_ENABLED],
  ['Tickets: tokens a room accepts at the door', false],
  ['Several tickets per room', false],
  ['"You already have one" check across devices', false],
];

const Row = ({ icon, title, sub, onClick }: { icon: string; title: string; sub: string; onClick: () => void }) => (
  <button
    onClick={onClick}
    className="w-full flex items-center gap-3 rounded-2xl px-4 py-3 text-left"
    style={{ background: PANEL, border: `1px solid ${LINE}` }}
  >
    <span
      className="w-9 h-9 rounded-full flex items-center justify-center font-bold"
      style={{ color: GOLD, border: `1px solid ${GOLD}` }}
    >
      {icon}
    </span>
    <span className="flex-1 min-w-0">
      <span className="block text-white font-semibold">{title}</span>
      <span className="block text-xs truncate" style={{ color: MUTED }}>
        {sub}
      </span>
    </span>
    <ChevronRight size={18} color={MUTED} />
  </button>
);

export const YouPage = () => {
  const navigate = useNavigate();
  const { apiContext, chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const main = (getPaymail(identityAddress) || '').split('@')[0];
  const [view, setView] = useState<View>({ v: 'main' });
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null);
  const [handles, setHandles] = useState<string[]>(main ? [main] : []);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      const c = await signedInClient(apiContext, kycClient());
      const [all, h] = await Promise.all([c.rooms(), c.listHandles().catch(() => null)]);
      if (!live) return;
      const names = h?.handles.map((x) => x.handle) ?? [];
      const mine = [...new Set([...(main ? [main] : []), ...names, c.current?.handle ?? ''])].filter(Boolean);
      setHandles(mine);
      setRooms(myRooms(all, mine));
    })().catch(() => live && setRooms([]));
    return () => {
      live = false;
    };
  }, [apiContext, main, tick]);

  const back = () =>
    view.v === 'main' ? navigate(-1) : setView({ v: view.v === 'tickets' || view.v === 'new' ? 'rooms' : 'main' });
  const title = { main: 'You', names: 'Your names', rooms: 'Rooms', new: 'New room', tickets: 'Tickets' }[view.v];
  const roomSub =
    rooms === null ? 'Loading…' : rooms.length ? rooms.map((r) => r.name || r.ticker).join(', ') : 'None yet';

  return (
    <div className="min-h-full px-4 pb-24" style={{ background: '#000' }}>
      <div className="flex items-center gap-2 py-3">
        <button
          onClick={back}
          aria-label="Back"
          className="p-1 -ml-1 flex items-center text-sm"
          style={{ color: GOLD }}
        >
          <ChevronLeft size={20} /> {view.v === 'main' ? '' : 'You'}
        </button>
        <span className="text-white font-semibold text-lg">{title}</span>
      </div>

      {view.v === 'main' && (
        <div className="flex flex-col gap-3">
          <div className="text-center py-2">
            <div className="text-xl font-bold" style={{ color: GOLD }}>
              {main ? `$${main}` : 'No name yet'}
            </div>
            <div className="text-xs" style={{ color: MUTED }}>
              Same on every device
            </div>
          </div>
          <p className="text-sm" style={{ color: MUTED }}>
            Three separate things. Set up any of them, in any order, whenever you like.
          </p>
          <Row
            icon="$"
            title="Names"
            sub={handles.length ? handles.map((h, i) => `$${h}${i === 0 ? ' (main)' : ''}`).join(', ') : 'Get a name'}
            onClick={() => setView({ v: 'names' })}
          />
          <Row icon="#" title="Rooms" sub={roomSub} onClick={() => setView({ v: 'rooms' })} />
          <Row
            icon="⌗"
            title="Tickets"
            sub={NRT_ENABLED ? 'Add one to a room to charge entry' : 'Coming soon'}
            onClick={() => setView({ v: 'rooms' })}
          />
          <p className="text-xs" style={{ color: MUTED }}>
            Everything here belongs to your key, not to this phone. Restore your 12 words anywhere and it all comes back
            the same. Nothing is ever created for you automatically.
          </p>
          <div className="rounded-2xl p-3 mt-1" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
            <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: MUTED }}>
              Status
            </div>
            {STATUS.map(([t, live]) => (
              <div key={t} className="text-xs flex gap-2 py-[2px]" style={{ color: live ? '#fff' : MUTED }}>
                <span style={{ color: live ? GOLD : MUTED }}>{live ? '✓' : '○'}</span>
                {t}
                {!live && ' · coming'}
              </div>
            ))}
          </div>
        </div>
      )}

      {view.v === 'names' && (
        <div className="flex flex-col gap-3">
          <p className="text-sm" style={{ color: MUTED }}>
            A name is how people pay and find you. It doesn't create a room or a token.
          </p>
          <WalletNames />
          <p className="text-xs" style={{ color: MUTED }}>
            Your main name follows your key. Change it here and every other device shows the new one.
          </p>
        </div>
      )}

      {view.v === 'rooms' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm" style={{ color: MUTED }}>
            A room is a place to talk. It needs no token.{NRT_ENABLED ? ' Tap a room to add tickets.' : ''}
          </p>
          {(rooms ?? []).map((r) => (
            <Row
              key={r.ticker}
              icon="#"
              title={r.name || r.ticker}
              sub={(r.metadata as { tokenGate?: unknown } | null)?.tokenGate ? 'Token room' : 'No token needed'}
              onClick={() => (NRT_ENABLED ? setView({ v: 'tickets', room: r }) : navigate('/m/chat'))}
            />
          ))}
          <button
            className="rounded-xl py-3 text-sm font-bold"
            style={{ background: GOLD, color: '#1a1300' }}
            onClick={() => setView({ v: 'new' })}
          >
            + New room
          </button>
        </div>
      )}

      {view.v === 'new' && (
        <NewRoomForm
          owner={main}
          parents={(rooms ?? []).map((r) => slugPart(r.name || r.ticker))}
          onDone={() => {
            setTick((t) => t + 1);
            setView({ v: 'rooms' });
          }}
        />
      )}

      {view.v === 'tickets' && TicketsPanel && (
        <Suspense fallback={null}>
          <TicketsPanel room={view.room} owner={main} identityAddress={identityAddress} />
        </Suspense>
      )}
    </div>
  );
};

const NewRoomForm = ({ owner, parents, onDone }: { owner: string; parents: string[]; onDone: () => void }) => {
  const { apiContext } = useServiceContext();
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [vis, setVis] = useState<OpenVisibility>('public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = useMemo(() => roomPath(name, NRT_ENABLED ? parent : null), [name, parent]);

  const create = async () => {
    const bad = roomNameProblem(name) || (NRT_ENABLED ? subRoomProblem(name, parent || null, parents) : null);
    if (bad) return setError(bad);
    setBusy(true);
    setError('');
    try {
      const c = await signedInClient(apiContext, kycClient());
      // A parent needs the server (spec §2); until then the room is made with its full dotted name.
      await c.createOpenRoom({ name: NRT_ENABLED && parent ? path : name.trim(), visibility: vis });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pill = (v: OpenVisibility, label: string) => (
    <button
      onClick={() => setVis(v)}
      className="flex-1 rounded-lg py-2 text-sm font-bold"
      style={vis === v ? { background: GOLD, color: '#1a1300' } : { color: MUTED, border: `1px solid ${LINE}` }}
    >
      {label}
    </button>
  );
  const input = 'w-full rounded-xl px-3 py-2 text-sm text-white outline-none';
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm" style={{ color: MUTED }}>
        A room is a place to talk. It needs no token. You can add tickets later.
      </p>
      <label className="text-xs" style={{ color: MUTED }}>
        Room name
        <input
          className={input}
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {NRT_ENABLED && (
        <label className="text-xs" style={{ color: MUTED }}>
          Inside another room? (optional)
          <select
            className={input}
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
            value={parent}
            onChange={(e) => setParent(e.target.value)}
          >
            <option value="">No, a room of its own</option>
            {parents.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {parent && (
            <span className="block mt-1">
              <b style={{ color: GOLD }}>{path}</b>: a dot means "a smaller room inside".
            </span>
          )}
        </label>
      )}
      <div className="text-xs" style={{ color: MUTED }}>
        Who can come in
      </div>
      <div className="flex gap-2">
        {pill('public', 'Anyone')}
        {pill('invite', 'Invite only')}
      </div>
      <p className="text-xs" style={{ color: MUTED }}>
        Want to charge entry? Add a ticket after the room exists.
      </p>
      {error && <p className="text-xs text-[#F97066]">{error}</p>}
      <button
        disabled={busy}
        onClick={() => void create()}
        className="rounded-xl py-3 text-sm font-bold disabled:opacity-50"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {busy ? 'Creating…' : 'Create room'}
      </button>
      <p className="text-[11px] text-center" style={{ color: MUTED }}>
        Free · no token is made{owner ? ` · owned by $${owner}` : ''}
      </p>
    </div>
  );
};

export default YouPage;
