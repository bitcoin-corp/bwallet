/**
 * Top-bar bMail button (replaces the centred b): mailbox icon + badge. Opens bMail in the content area (/m/bmail,
 * owner 9 Oct 2026: between the top bar and the tab bar, not over them); tapping it again goes back. Airdrops live
 * in Quarantine (with a pointer from Inbox and Requests).
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { bmailRequestPending, OPEN_BMAIL_EVENT } from '../bmail/store';
import { TabBadge } from '../../components/TabBadge';
import { badgeLabel } from '../tabs/tabBadges';
import { useBMailBadge } from '../tabs/useTabBadges';
import { Mailbox } from 'lucide-react';

export const BMAIL_ROUTE = '/m/bmail';
// Several TopNavs can be mounted at once: only the first listener routes an openBMail() event.
let lastOpen = 0;

export const AirdropsNavButton = ({ color, ring }: { color: string; ring: string }) => {
  const badge = useBMailBadge();
  const navigate = useNavigate();
  const onMail = useLocation().pathname.startsWith(BMAIL_ROUTE);
  useEffect(() => {
    const on = () => {
      const now = Date.now();
      if (onMail || now - lastOpen < 500) return;
      lastOpen = now;
      navigate(BMAIL_ROUTE);
    };
    window.addEventListener(OPEN_BMAIL_EVENT, on);
    // A compose link or meeting tap that arrived before this bar mounted (launch, before unlock) (owner, 26 Oct 2026).
    if (bmailRequestPending()) on();
    return () => window.removeEventListener(OPEN_BMAIL_EVENT, on);
  }, [navigate, onMail]);
  return (
    <button
      type="button"
      aria-label={badgeLabel('bMail', badge)}
      aria-pressed={onMail}
      onClick={() => (onMail ? navigate(-1) : navigate(BMAIL_ROUTE))}
      className="relative w-9 h-9 rounded-full flex items-center justify-center cursor-pointer"
      style={{ border: onMail ? `1px solid ${color}` : ring, background: onMail ? `${color}33` : 'transparent' }}
    >
      <Mailbox size={16} color={color} />
      <TabBadge count={badge} className="-top-1 -right-1.5" />
    </button>
  );
};
