import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { useAccountNames } from '../names/accountNames';
import { AccountAvatar } from '../names/AccountAvatar';
import { useAvatar } from '../names/useAvatar';
import { AccountList, AgentMark } from './AccountSwitcher';
import { accountTag, useAccountSwitch } from './accountSwitch';

const MUTED = '#98A2B3';

/**
 * Account strip (owner, 6 Oct 2026: "the account name should always appear at the top, above the top navbar,
 * so we can quickly switch between accounts and always see which account we're in").
 * Slim bar above TopNav on every tab: [avatar] name · AGENT · $handle ▾, the ▾ opens a compact switcher.
 * Its height is --account-strip-height (mobile.css), set only while it is mounted (html.has-account-strip),
 * and is folded into --wallet-inset-top so TopNav and every page shift down from one place.
 */
export const AccountStrip = () => {
  const { chromeStorageService } = useServiceContext();
  const { account } = chromeStorageService.getCurrentAccountObject();
  const [open, setOpen] = useState(false);
  const { current, switchingTo, switchAccount } = useAccountSwitch(() => setOpen(false));
  const names = useAccountNames(
    current,
    account?.name ?? '',
    account?.settings?.socialProfile?.displayName ?? '',
    false,
  );
  const avatar = useAvatar(current);
  const many = chromeStorageService.getAllAccounts().length > 1;
  useBackClose(open && !switchingTo, () => setOpen(false));

  useEffect(() => {
    document.documentElement.classList.add('has-account-strip');
    return () => document.documentElement.classList.remove('has-account-strip');
  }, []);

  const tag = current ? accountTag(current, names.displayName, names.paymail, names.handle) : '';
  // Owner, 24 Oct 2026: signed in, the strip names the account by its FULL paymail (b0asex@bwalletx.com).
  const name = names.paymail || names.displayName || names.label || account?.name || 'Account';
  const showTag = !names.paymail && !!tag && tag.length <= 16 && tag.toLowerCase() !== `$${name.toLowerCase()}`;

  return (
    <>
      <div className="bw-account-strip fixed left-0 w-full z-[11] flex items-center px-3" data-testid="account-strip">
        <button
          type="button"
          onClick={() => many && setOpen((o) => !o)}
          aria-expanded={open}
          aria-label="Switch account"
          className="flex min-w-0 max-w-full items-center gap-2 border-0 bg-transparent p-0 text-left"
        >
          <AccountAvatar src={avatar} size={20} ring={false} id={current} />
          <span className="truncate text-[13px] font-bold text-white">{name}</span>
          <AgentMark id={current} />
          {showTag && (
            <span className="shrink-0 text-xs font-extrabold" style={{ color: 'var(--bw-accent-hi)' }}>
              {tag}
            </span>
          )}
          {many && (
            <ChevronDown
              size={14}
              color={MUTED}
              className="shrink-0"
              style={{ transform: open ? 'rotate(180deg)' : '', transition: 'transform .15s' }}
            />
          )}
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-[300] bg-black/50" onClick={() => !switchingTo && setOpen(false)}>
          <div
            className="absolute left-2 right-2 max-w-[360px] max-h-[60vh] overflow-y-auto rounded-xl p-1 border border-white/10"
            style={{ top: 'var(--wallet-inset-top)', background: '#101114' }}
            role="listbox"
            onClick={(e) => e.stopPropagation()}
          >
            <AccountList
              current={current}
              switchingTo={switchingTo}
              onSwitch={(id) => void switchAccount(id)}
              compact
            />
          </div>
        </div>
      )}
    </>
  );
};
