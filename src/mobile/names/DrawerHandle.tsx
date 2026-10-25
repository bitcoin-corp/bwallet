import { useEffect, useState } from 'react';
import { AtSign, MessageCircle } from 'lucide-react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from '../chat/nav';
import { tokenKey } from '../chat/tokenRooms';
import { drawerRoomState, getPersonalLink, onPersonalChange } from './personalToken';
import { discoverPersonalLink } from './claimPersonal';
import { useServiceContext } from '../../hooks/useServiceContext';
import { setPrimaryName } from './accountName';
import { useNavigate } from 'react-router-dom';
import { drawerNames } from './drawerNames';

/**
 * Account drawer: a link to the current account's personal $NAME room, or a "Get your $name" button. The handle is
 * shown once, above; it is never repeated here as a paymail line (owner, 11 Oct 2026). Rendered by the mobile TopNav.
 */
export const DrawerHandle = ({
  identityAddress,
  paymail,
  handle,
  onGetName,
  onNavigate,
  names = [],
  shown = '',
}: {
  /** Every name this identity has (accountNames.ts nameCandidates): two or more → "Show as" picker. */
  names?: string[];
  /** The name shown now (AccountNames.payable). */
  shown?: string;
  identityAddress?: string;
  paymail: string;
  handle: string;
  onGetName: () => void;
  onNavigate: () => void;
}) => {
  const { handleSelect } = useBottomMenu();
  const [link, setLink] = useState(() => getPersonalLink(identityAddress));
  useEffect(() => {
    setLink(getPersonalLink(identityAddress));
    return onPersonalChange(() => setLink(getPersonalLink(identityAddress)));
  }, [identityAddress]);

  const name = paymail || handle;
  const roomKey = link ? tokenKey('bsv21', link.tokenId) : null;
  // The link is per device: on a second device (same words) look the personal token up before offering to make one.
  const { apiContext } = useServiceContext();
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    if (!apiContext || !identityAddress || !name || getPersonalLink(identityAddress)) return;
    let live = true;
    setFinding(true);
    void discoverPersonalLink(apiContext, identityAddress, name)
      .catch(() => null)
      .finally(() => live && setFinding(false));
    return () => {
      live = false;
    };
  }, [apiContext, identityAddress, name]);
  const state = drawerRoomState({ name, link, finding });
  const navigate = useNavigate();
  // Never an unbounded list here: an account can hold thousands of OpNS names, which pushed Sign out off-screen
  // (owner, 25 Oct 2026). A few chips, then "Your names (N)" opens Wallet › Names, which has search.
  const { chips, total, more } = drawerNames(names, shown);
  const picker =
    identityAddress && total > 1 ? (
      <div className="mx-2 mb-2 flex flex-wrap items-center gap-1.5 px-1" aria-label="Show as">
        <span className="text-[11px] text-[#98A2B3]">Show as</span>
        {chips.map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={n === shown}
            onClick={() => setPrimaryName(identityAddress, n)}
            className="max-w-[9rem] overflow-hidden text-ellipsis whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold cursor-pointer border"
            style={
              n === shown
                ? { background: 'var(--bw-accent-hi)', color: '#010101', borderColor: 'transparent' }
                : { background: 'transparent', color: 'var(--bw-accent-hi)', borderColor: '#3a2f0c' }
            }
          >
            ${n}
          </button>
        ))}
        {more && (
          <button
            type="button"
            onClick={() => {
              onNavigate();
              navigate('/m/you');
            }}
            className="bg-transparent border-0 p-0 text-xs font-semibold cursor-pointer"
            style={{ color: 'var(--bw-accent-hi)' }}
          >
            Your names ({total.toLocaleString()}) ›
          </button>
        )}
      </div>
    ) : null;

  if (state === 'finding')
    return (
      <>
        {picker}
        <div
          className="mx-2 mb-2 flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm"
          style={{ background: 'var(--bw-surface)', border: '1px solid #2b2f36', color: '#98A2B3' }}
        >
          <AtSign size={15} /> Finding your room…
        </div>
      </>
    );

  if (state !== 'room')
    return (
      <>
        {picker}
        <button
          type="button"
          onClick={onGetName}
          className="mx-2 mb-2 flex items-center gap-2 rounded-xl px-3 py-2.5 text-left cursor-pointer"
          style={{ background: 'var(--bw-surface)', border: '1px solid #3a2f0c' }}
        >
          <AtSign size={15} color="var(--bw-accent-hi)" />
          <span className="text-sm font-semibold" style={{ color: 'var(--bw-accent-hi)' }}>
            {state === 'create' ? 'Create your room' : 'Get your $name'}
          </span>
        </button>
      </>
    );

  return (
    <>
      {picker}
      <div
        className="mx-2 mb-2 flex flex-col gap-1.5 rounded-xl px-3 py-2"
        style={{ background: 'var(--bw-surface)', border: '1px solid #2b2f36' }}
      >
        {roomKey && (
          <button
            type="button"
            onClick={() => {
              requestChatRoom(roomKey);
              onNavigate();
              handleSelect(asMenuItem('chat'));
            }}
            className="self-start mt-0.5 flex items-center gap-1.5 bg-transparent border-0 p-0 cursor-pointer text-xs font-semibold"
            style={{ color: 'var(--bw-accent-hi)' }}
          >
            <MessageCircle size={13} />
            Your ${link?.ticker} room{link?.roomTicker ? '' : ' (opening…)'}
          </button>
        )}
      </div>
    </>
  );
};
