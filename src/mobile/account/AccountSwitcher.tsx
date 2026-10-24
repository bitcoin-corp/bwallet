import { keyFingerprint } from '../wallet/identityLine';
import { loadAccountOrigin, ORIGIN_NAMES, originTint } from '../origins/origins';
import { accountTag } from './accountSwitch';
import { Check, Loader2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { allAgentsStopped, getAgentAccount, isAgentAccount, isPotAccount } from '../agents/agentAccounts';
import { AgentBadge } from '../agents/AgentsScreen';
import { accountNamesFor } from '../names/accountNames';
import { AccountAvatar } from '../names/AccountAvatar';
import { getLocalAvatar, isDefaultAvatar, pickAvatar, resolveAvatarUrl } from '../names/avatar';

const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

export const AgentMark = ({ id }: { id?: string }) =>
  id && isAgentAccount(id) ? (
    <AgentBadge
      stopped={getAgentAccount(id)?.stopped || allAgentsStopped()}
      label={isPotAccount(getAgentAccount(id)) ? 'POT' : 'AGENT'}
    />
  ) : null;

type Account = ReturnType<ReturnType<typeof useServiceContext>['chromeStorageService']['getAllAccounts']>[number];

/** One account as a tappable row (the drawer, the strip's dropdown and the account / agent sheets). */
export const AccountRow = ({
  account,
  current,
  switchingTo,
  onSwitch,
  verified = false,
  compact = false,
  trailing,
}: {
  account: Account;
  current?: string;
  switchingTo: string | null;
  onSwitch: (id: string) => void;
  verified?: boolean;
  compact?: boolean;
  trailing?: React.ReactNode;
}) => {
  const size = compact ? 28 : 36;
  const id = account.addresses.identityAddress;
  const isSwitching = switchingTo === id;
  const n = accountNamesFor(id, account.name, account.settings?.socialProfile?.displayName ?? '');
  const tag = accountTag(id, n.displayName, n.paymail, n.handle);
  // Origin tint (owner, 24 Oct 2026): restored-from wallet as a coloured edge + plain-text pill; fresh = gold default.
  const origin = loadAccountOrigin(id) ?? (account.settings?.relayx?.xpub ? 'relayx' : undefined);
  const tint = originTint(origin);
  return (
    <div className="flex w-full items-center">
      <button
        role="option"
        aria-selected={id === current}
        onClick={() => onSwitch(id)}
        className={`flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left border-0 active:bg-white/5 ${compact ? 'px-3 py-2' : 'px-3 py-3'}`}
        style={{
          background: id === current ? '#17191E' : 'transparent',
          boxShadow: tint ? `inset 3px 0 0 ${tint.accent}` : undefined,
          opacity: switchingTo && !isSwitching ? 0.4 : 1,
        }}
      >
        {isSwitching ? (
          <Loader2 size={20} className="animate-spin p-1.5" style={{ width: size, height: size }} color="#A1FF8B" />
        ) : (
          <AccountAvatar
            size={size}
            ring={false}
            id={id}
            place="list"
            src={resolveAvatarUrl(
              pickAvatar({
                local: getLocalAvatar(id),
                socialAvatar: account.settings?.socialProfile?.avatar,
                accountIcon: isDefaultAvatar(account.icon) ? '' : account.icon,
              }),
            )}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className={`flex items-center gap-1 text-sm font-semibold text-white ${ELLIPSIS}`}>
            {/* Full paymail first (owner, 24 Oct 2026), never the bare $handle when a paymail exists. */}
            <span className={ELLIPSIS}>{n.paymail || tag || n.displayName || n.label}</span>
            {id === current && verified && <Check size={13} strokeWidth={3} color="#2ecc71" />}
            <AgentMark id={id} />
            {tint && origin && (
              <span
                className="shrink-0 rounded-full px-1.5 text-[10px] font-semibold leading-4"
                style={{ background: tint.pill, color: tint.text }}
              >
                {ORIGIN_NAMES[origin] ?? origin}
              </span>
            )}
          </div>
          {/* Handle + identity-key fingerprint only (owner, 10 Oct 2026): never another handle, never copyable. */}
          {!compact && keyFingerprint(account.pubKeys?.identityPubKey) && (
            <div className="text-[11px] font-mono text-[#98A2B3] select-none">
              {keyFingerprint(account.pubKeys?.identityPubKey)}
            </div>
          )}
        </div>
        {id === current && <Check size={16} color="#A1FF8B" />}
      </button>
      {trailing}
    </div>
  );
};

/** Every account as a tappable row. compact = the strip's dropdown (smaller, no address line). */
export const AccountList = ({
  current,
  switchingTo,
  onSwitch,
  verified = false,
  compact = false,
}: {
  current?: string;
  switchingTo: string | null;
  onSwitch: (id: string) => void;
  verified?: boolean;
  compact?: boolean;
}) => {
  const { chromeStorageService } = useServiceContext();
  return (
    <>
      {chromeStorageService.getAllAccounts().map((account) => (
        <AccountRow
          key={account.addresses.identityAddress}
          account={account}
          current={current}
          switchingTo={switchingTo}
          onSwitch={onSwitch}
          verified={verified}
          compact={compact}
        />
      ))}
    </>
  );
};
