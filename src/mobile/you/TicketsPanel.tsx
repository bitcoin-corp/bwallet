/**
 * You › Rooms › a room › Tickets (NRT_ENABLED only, never in a store build). A ticket is a token (or, kind
 * 'collection', any NFT of a 1Sat collection) the room accepts at the door; one is used up on entry. The list
 * here is a draft until bit-sign stores tickets per room (NAMES-ROOMS-TICKETS-SERVER-SPEC.md §3): Save stays
 * off and the page says so. Making a new ticket token goes through the "You already have one" guard first.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatRoom } from '../chat/messages';
import { getPersonalLink } from '../names/personalToken';
import {
  addTicket,
  doorText,
  guardCopy,
  guardFor,
  newTicket,
  removeTicket,
  ticketNote,
  type Existing,
  type Ticket,
  type TicketKind,
} from './nrt';

const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';

const TicketsPanel = ({ room, owner, identityAddress }: { room: ChatRoom; owner: string; identityAddress: string }) => {
  const navigate = useNavigate();
  const link = getPersonalLink(identityAddress);
  const gate = (room.metadata as { tokenGate?: { key?: string; symbol?: string } } | null)?.tokenGate;
  const [tickets, setTickets] = useState<Ticket[]>(() =>
    gate?.key
      ? [
          newTicket({
            kind: 'token',
            id: gate.key.replace(/^bsv21:/, ''),
            label: `$${(gate.symbol || '').replace(/^\$/, '')}`,
            mine: !!link && gate.key.endsWith(link.tokenId),
          }),
        ]
      : [],
  );
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<TicketKind>('token');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [guard, setGuard] = useState<Existing | null>(null);
  const roomName = room.name || room.ticker;

  const addMine = () => {
    if (!link) return;
    setTickets((l) =>
      addTicket(l, newTicket({ kind: 'token', id: link.tokenId, label: `$${link.ticker}`, mine: true })),
    );
  };
  const addTyped = () => {
    if (!id.trim()) return;
    setTickets((l) =>
      addTicket(l, newTicket({ kind, id: id.trim(), label: label.trim() || id.trim().slice(0, 10), mine: false })),
    );
    setId('');
    setLabel('');
    setAdding(false);
  };
  const makeNew = () => {
    const existing: Existing[] = link ? [{ kind: 'token', label: `$${link.ticker}`, opens: [roomName] }] : [];
    const g = guardFor('token', existing);
    if (g) setGuard(g);
    else navigate('/m/bmint');
  };

  const input = 'w-full rounded-xl px-3 py-2 text-sm text-white outline-none';
  return (
    <div className="flex flex-col gap-3">
      <div className="text-lg font-bold" style={{ color: GOLD }}>
        {roomName}
      </div>
      <p className="text-sm" style={{ color: MUTED }}>
        A ticket is a token this room accepts at the door. One is used up each time someone comes in.
      </p>
      {tickets.map((t) => (
        <div
          key={`${t.kind}:${t.id}`}
          className="flex items-center gap-3 rounded-2xl px-4 py-3"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        >
          <span className="flex-1 min-w-0">
            <span className="block text-white font-semibold">
              {t.kind === 'token' ? `${t.amount} ${t.label}` : `Any ${t.label} NFT`}
            </span>
            <span className="block text-xs" style={{ color: MUTED }}>
              {ticketNote(t)}
            </span>
          </span>
          <button className="text-xs" style={{ color: MUTED }} onClick={() => setTickets((l) => removeTicket(l, t))}>
            Remove
          </button>
        </div>
      ))}
      <div className="text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>
        Add a ticket
      </div>
      {link && (
        <button
          className="rounded-xl py-2 text-sm font-bold"
          style={{ border: `1px solid ${GOLD}`, color: GOLD }}
          onClick={addMine}
        >
          Use a token you already have (${link.ticker})
        </button>
      )}
      {!adding ? (
        <button
          className="rounded-xl py-2 text-sm"
          style={{ border: `1px solid ${LINE}`, color: '#fff' }}
          onClick={() => setAdding(true)}
        >
          Someone else's token or collection
        </button>
      ) : (
        <div className="flex flex-col gap-2 rounded-2xl p-3" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
          <div className="flex gap-2">
            {(['token', 'collection'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className="flex-1 rounded-lg py-1 text-xs font-bold"
                style={
                  kind === k ? { background: GOLD, color: '#1a1300' } : { color: MUTED, border: `1px solid ${LINE}` }
                }
              >
                {k === 'token' ? 'Token' : '1Sat collection'}
              </button>
            ))}
          </div>
          <input
            className={input}
            style={{ background: '#000', border: `1px solid ${LINE}` }}
            placeholder={kind === 'token' ? 'Token id (txid_0)' : 'Collection id (txid_0)'}
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
          <input
            className={input}
            style={{ background: '#000', border: `1px solid ${LINE}` }}
            placeholder={kind === 'token' ? '$TICKER' : 'Collection name'}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button
            className="rounded-xl py-2 text-sm font-bold"
            style={{ background: GOLD, color: '#1a1300' }}
            onClick={addTyped}
          >
            Add
          </button>
        </div>
      )}
      <button className="rounded-xl py-2 text-sm" style={{ color: GOLD }} onClick={makeNew}>
        + Make a new ticket token
      </button>
      <p className="text-xs" style={{ color: MUTED }}>
        {doorText(roomName, tickets, owner)}
      </p>
      <button
        disabled
        className="rounded-xl py-3 text-sm font-bold opacity-50"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        Save tickets · coming
      </button>
      <p className="text-[11px] text-center" style={{ color: MUTED }}>
        Saving tickets to a room needs a server update. Nothing is saved or charged yet.
      </p>

      {guard && (
        <div
          className="fixed inset-0 z-[150] flex items-end"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setGuard(null)}
        >
          <div
            className="w-full rounded-t-3xl px-5 pt-5 flex flex-col gap-3"
            style={{
              background: '#0e0e0e',
              borderTop: `1px solid ${LINE}`,
              paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-white font-semibold text-lg">{guardCopy(guard).title}</span>
            <p className="text-sm" style={{ color: MUTED }}>
              {guardCopy(guard).body}
            </p>
            <button
              className="rounded-xl py-3 text-sm font-bold"
              style={{ background: GOLD, color: '#1a1300' }}
              onClick={() => {
                addMine();
                setGuard(null);
              }}
            >
              {guardCopy(guard).keep}
            </button>
            <button className="rounded-xl py-2 text-sm" style={{ color: MUTED }} onClick={() => navigate('/m/bmint')}>
              {guardCopy(guard).again}
            </button>
            <p className="text-[11px] text-center" style={{ color: MUTED }}>
              Every device checks your key first, so nothing gets made twice by accident.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default TicketsPanel;
