import { useState } from 'react';
import { Check, Circle, ExternalLink, Store } from 'lucide-react';
import { OpenTokenRoomButton } from '../chat/OpenTokenRoomButton';
import { tokenRoomsEnabled } from '../storeBuild';
import { openExternal } from './useTokenRowActions';
import { EMPTY_STORE, storeChecklist, type TokenStoreInfo } from './tokenStore';

/**
 * "Room" + "Store" for a launchpad token card (TokenBlaster or Memepool). Room opens the token's chat room in b
 * (keyed by token id; the Chat tab starts it on first visit). Store shows the token's theme and merch when the
 * listing carries them, and always the live/coming checklist. Nothing here pays.
 */
const MUTED = '#98A2B3';
const BTN =
  'flex items-center justify-center gap-2 h-10 rounded-xl text-sm font-bold outline-none border cursor-pointer';
const BTN_STYLE = { background: 'var(--bw-surface)', borderColor: '#3a2f0c', color: 'var(--bw-accent-hi)' };

const Swatch = ({ c, label }: { c: string; label: string }) => (
  <span className="flex items-center gap-1.5 text-xs" style={{ color: MUTED }}>
    <span className="w-4 h-4 rounded-full border border-[#2b2f36]" style={{ background: c }} />
    {label}
  </span>
);

export const TokenStorePanel = ({ sym, info }: { sym: string; info: TokenStoreInfo }) => (
  <div className="flex flex-col gap-3 rounded-xl p-3 bg-[#0F1013]" aria-label={`$${sym} store`}>
    <div className="text-sm font-bold text-white">${sym} store</div>
    {info.theme ? (
      <div className="flex flex-col gap-2">
        <div className="text-xs font-semibold text-white">Theme: {info.theme.name}</div>
        <div className="grid grid-cols-2 gap-2">
          <Swatch c={info.theme.accent} label="Accent" />
          <Swatch c={info.theme.bg} label="Background" />
          <Swatch c={info.theme.surface} label="Cards" />
          <Swatch c={info.theme.text} label="Text" />
        </div>
      </div>
    ) : (
      <p className="text-xs m-0" style={{ color: MUTED }}>
        No theme for ${sym} yet.
      </p>
    )}
    {info.merchUrl ? (
      <button
        type="button"
        className={BTN}
        style={BTN_STYLE}
        onClick={() => info.merchUrl && openExternal(info.merchUrl)}
      >
        Merch shop <ExternalLink size={14} />
      </button>
    ) : (
      <p className="text-xs m-0" style={{ color: MUTED }}>
        No merch for ${sym} yet.
      </p>
    )}
    <ul className="flex flex-col gap-1 m-0 p-0 list-none">
      {storeChecklist(info, tokenRoomsEnabled()).map((it) => (
        <li key={it.label} className="flex items-center gap-2 text-xs" style={{ color: it.live ? '#fff' : MUTED }}>
          {it.live ? <Check size={14} color="#32D583" /> : <Circle size={12} color={MUTED} />}
          {it.label}
          <span className="ml-auto text-[10px] font-bold">{it.live ? 'Live' : 'Coming'}</span>
        </li>
      ))}
    </ul>
  </div>
);

export const TokenRoomStore = ({ id, sym, info = EMPTY_STORE }: { id: string; sym: string; info?: TokenStoreInfo }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        {tokenRoomsEnabled() ? (
          <OpenTokenRoomButton id={id} label="Room" className={BTN} style={BTN_STYLE} />
        ) : (
          <span />
        )}
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={BTN} style={BTN_STYLE}>
          <Store size={14} /> Store
        </button>
      </div>
      {open && <TokenStorePanel sym={sym} info={info} />}
    </div>
  );
};
