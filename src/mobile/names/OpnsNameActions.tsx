/**
 * The Name card's body (owner, 25 Oct 2026): for an application/op-ns NFT, one plain sentence saying what it is, who
 * it came from, status chips, and "What you can do with it": real actions wired to the existing flows, or an honest
 * "Coming" row with no button (owner rules "pages show status" and "no mocks"). Helpers: nameCard.ts.
 *
 *  - $handle: HandleFlow prefilled with the name (the paymail server's own availability check and confirmation).
 *  - Identity key: registerOpns (as Settings › Get your name's Use this name), after the standard SendConfirmation.
 *  - bAvatar: the gold bAvatar seeded by the name, set as this device's picture.
 *  - Room: the room of the token launched under this name; a room owned by the name itself is Coming.
 *  - Token: TokenBlaster's launch page, prefilled (not in the store edition).
 *  - Sell / give: Wallet › Names (OpnsSellSection / OpnsGiftSection). Send: the host's Send.
 *  - A name received as a plain NFT (a gift): "Add to my Names" moves it into the Names basket (opnsAdopt.ts, no
 *    transaction), after which the identity-key and sell rows work as for a minted name.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { listOpns, registerOpns } from '@1sat/actions';
import {
  AtSign,
  Check,
  Coins,
  KeyRound,
  Link2,
  MessageCircle,
  Plus,
  Send,
  ShoppingBag,
  Sparkles,
  UserCircle,
} from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { SendConfirmation } from '../../components/SendConfirmation';
import { moneyNow } from '../money/money';
import { MARKET_ENABLED, TOKENBLASTER_ENABLED } from '../storeBuild';
import { OpenTokenRoomButton } from '../chat/OpenTokenRoomButton';
import { getPaymail, ownedFromOutputs, syncAccountNames, type OwnedName } from './accountName';
import { setLocalAvatar } from './avatar';
import { BWALLET_PAYMAIL_DOMAIN, OPNS_PROFILE_DOMAIN } from './config';
import { HandleFlow } from './HandleFlow';
import { useOpnsName } from './OpnsNameCard';
import { adoptOpnsNft } from './opnsAdopt';
import { setMyName } from './myName';
import { paymailEnabled } from './paymail';
import { getPersonalLink, onPersonalChange, personalKey } from './personalToken';
import { handlePaymail, nameBavatarUri, nameChips, nameIntro, nameOrigin, tokenblasterLaunchUrl } from './nameCard';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
// registerOpns = self-transfer of the 1-sat name ordinal + MAP (GetYourName REGISTER_FEE_ESTIMATE_SATS).
const BIND_FEE_SATS = 50;

const Row = ({
  icon,
  title,
  sub,
  action,
  coming,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  action?: ReactNode;
  coming?: boolean;
}) => (
  <li className="flex flex-col gap-2 rounded-2xl bg-[#111216] border border-white/5 p-3">
    <div className="flex items-start gap-3">
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        style={{ background: 'rgb(var(--bw-accent-rgb) / 0.14)' }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-bold text-white">{title}</span>
          {coming && (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#98A2B3]">
              Coming
            </span>
          )}
        </span>
        <span className="block text-xs leading-snug" style={{ color: MUTED }}>
          {sub}
        </span>
      </span>
    </div>
    {action}
  </li>
);

const BIG = 'flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold disabled:opacity-40';
const Done = ({ children }: { children: ReactNode }) => (
  <span className="flex items-center gap-1.5 text-sm font-semibold text-[#A1FF8B]">
    <Check size={16} /> {children}
  </span>
);

export const OpnsNameActions = ({
  name,
  from,
  held = true,
  outpoint,
  onSend,
}: {
  /** The name, already read from the inscription and checked (opnsNameFrom). */
  name: string;
  /** Who sent it ($name or address), when known (bMail airdrops). */
  from?: string | null;
  /** In the wallet's list (false: a kept airdrop the wallet hasn't indexed yet). */
  held?: boolean;
  /** This NFT's outpoint in the wallet, when it is held (lets a gifted name be moved into Names). */
  outpoint?: string;
  /** The host's Send for this NFT, when it has one. */
  onSend?: () => void;
}) => {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const [owned, setOwned] = useState<OwnedName | null | undefined>(undefined);
  const [link, setLink] = useState(() => getPersonalLink(identityAddress));
  const [paymail, setPm] = useState(() => getPaymail(identityAddress));
  const [handleOpen, setHandleOpen] = useState(false);
  const [confirmBind, setConfirmBind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [avatarSet, setAvatarSet] = useState(false);
  const [adopting, setAdopting] = useState(false);

  useEffect(() => onPersonalChange(() => setLink(getPersonalLink(identityAddress))), [identityAddress]);
  // The wallet's own copy in the OpNS names basket (mints and buys land there; registerOpns needs its id).
  useEffect(() => {
    let live = true;
    setOwned(undefined);
    // Whole basket (not a name: tag filter): a gifted name moved in by opnsAdopt carries its name in its custom
    // instructions, since the wallet only writes tags for new rows.
    listOpns
      .execute(apiContext, { includeTags: true, includeCustomInstructions: true, limit: 1000 })
      .then((r) => live && setOwned(ownedFromOutputs(r.outputs).find((o) => o.name === name) ?? null))
      .catch(() => live && setOwned(null));
    return () => {
      live = false;
    };
  }, [apiContext, name]);

  const pm = handlePaymail(name, BWALLET_PAYMAIL_DOMAIN);
  const chips = nameChips({
    name,
    published: !!owned?.published,
    paymail,
    domain: BWALLET_PAYMAIL_DOMAIN,
    link,
  });
  const on = (k: string) => chips.find((c) => c.key === k)?.on ?? false;
  const ownLink = link && personalKey(link.name) === name ? link : null;
  const canAdopt = owned === null && held && !!outpoint;

  const bind = async () => {
    if (!owned) return;
    setConfirmBind(false);
    setBusy(true);
    setMsg('');
    try {
      const profileName = account?.settings?.socialProfile?.displayName ?? '';
      const res = await registerOpns.execute(apiContext, {
        id: owned.id,
        profile: { domain: OPNS_PROFILE_DOMAIN, ...(profileName ? { name: profileName } : {}) },
      });
      if (res.error) throw new Error(res.error);
      setMyName(identityAddress, name);
      setOwned({ ...owned, published: true });
      setMsg(`${name} now points to your identity key. People can find you by it.`);
      syncAccountNames(apiContext, identityAddress, { force: true }).catch(() => undefined);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Not linked. Nothing was sent.');
    } finally {
      setBusy(false);
    }
  };

  // A name that came in with the NFTs: move its row into the Names basket (no transaction, no fee).
  const adopt = async () => {
    if (!outpoint) return;
    setAdopting(true);
    setMsg('');
    try {
      const r = await adoptOpnsNft(apiContext.wallet, outpoint, name);
      if ('error' in r) throw new Error(r.error);
      setOwned({ name, id: r.id, published: false });
      setMsg(`${name} is in your Names now. You can link your identity key or sell it.`);
      syncAccountNames(apiContext, identityAddress, { force: true }).catch(() => undefined);
    } catch (e) {
      setMsg(e instanceof Error ? `Not moved: ${e.message}` : 'Not moved. Nothing changed.');
    } finally {
      setAdopting(false);
    }
  };

  const useAvatar = () => {
    if (!identityAddress) return setMsg('Couldn’t set the picture.');
    setLocalAvatar(identityAddress, nameBavatarUri(name));
    setAvatarSet(true);
    setMsg(`Your picture is now the ${name} bAvatar on this device.`);
  };

  return (
    <section className="flex flex-col gap-3" aria-label={`What you can do with ${name}`}>
      <div
        className="flex flex-col gap-2 rounded-2xl border p-4"
        style={{ borderColor: '#3a2f0c', background: '#0f0d07' }}
      >
        <p className="m-0 text-[15px] leading-snug text-white">{nameIntro(name)}</p>
        <p className="m-0 text-sm font-semibold" style={{ color: GOLD }}>
          {nameOrigin({ inNames: !!owned, from })}
        </p>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Status">
          {chips.map((c) => (
            <li
              key={c.key}
              className="rounded-full px-3 py-1 text-xs font-bold"
              style={
                c.on
                  ? { background: 'rgb(161 255 139 / 0.14)', color: '#A1FF8B' }
                  : { background: 'rgb(255 255 255 / 0.06)', color: MUTED }
              }
            >
              {c.label}: {c.on ? 'yes' : 'no'}
            </li>
          ))}
        </ul>
      </div>

      <h3 className="m-0 text-xs font-bold uppercase tracking-widest" style={{ color: MUTED }}>
        What you can do with it
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {/* 1. $handle / paymail */}
        {!paymailEnabled() || !pm ? (
          <Row
            icon={<AtSign size={20} color={GOLD} />}
            title="Use as my $handle"
            coming
            sub={
              !pm && paymailEnabled()
                ? `A $handle can be up to 32 letters, numbers, - or _, starting and ending with a letter or number. ${name} doesn’t fit, so it can’t be a handle.`
                : '$handles aren’t available in this edition.'
            }
          />
        ) : (
          <Row
            icon={<AtSign size={20} color={GOLD} />}
            title="Use as my $handle"
            sub={`Get paid at ${pm}. Handles live on the bWalletX name server, separate from the on-chain name, so the next screen checks it is free.`}
            action={
              on('handle') ? (
                <Done>Your $handle</Done>
              ) : (
                <button
                  className={`${BIG} text-[#010101]`}
                  style={{ background: GOLD }}
                  onClick={() => setHandleOpen(true)}
                >
                  <AtSign size={16} /> Make ${name} my handle
                </button>
              )
            }
          />
        )}

        {/* 2. Identity key (OpNS registration) */}
        {owned ? (
          <Row
            icon={<KeyRound size={20} color={GOLD} />}
            title="Link my identity key"
            sub="Signs your identity key onto the name on chain, so apps and people can find you by it. One approval, a tiny network fee."
            action={
              owned.published ? (
                <Done>Linked to your identity key</Done>
              ) : (
                <button
                  disabled={busy || !held}
                  className={`${BIG} text-[#010101]`}
                  style={{ background: GOLD }}
                  onClick={() => setConfirmBind(true)}
                >
                  <KeyRound size={16} /> Link my identity key
                </button>
              )
            }
          />
        ) : (
          <Row
            icon={<KeyRound size={20} color={GOLD} />}
            title="Link my identity key"
            coming={owned === null && !canAdopt}
            sub={
              owned === undefined
                ? 'Checking your names…'
                : canAdopt
                  ? 'This name came in with your NFTs. Add it to your Names list first, then link it and sell it. Adding is free: no transaction, nothing sent.'
                  : 'This name came in with your NFTs, not into your Names list, so the wallet can’t sign it yet. It can be added to Names once it shows in Wallet › NFTs.'
            }
            action={
              canAdopt ? (
                <button
                  disabled={adopting}
                  className={`${BIG} text-[#010101]`}
                  style={{ background: GOLD }}
                  onClick={() => void adopt()}
                >
                  <Plus size={16} /> {adopting ? 'Adding…' : 'Add to my Names'}
                </button>
              ) : undefined
            }
          />
        )}

        {/* 3. bAvatar */}
        <Row
          icon={<UserCircle size={20} color={GOLD} />}
          title="Make it my bAvatar"
          sub={`A gold picture drawn from the name ${name}, the same every time. Set on this device.`}
          action={
            <div className="flex items-center gap-3">
              <img src={nameBavatarUri(name)} alt="" className="h-14 w-14 shrink-0 rounded-full" />
              {avatarSet ? (
                <Done>Your picture</Done>
              ) : (
                <button className={`${BIG} text-[#010101]`} style={{ background: GOLD }} onClick={useAvatar}>
                  <UserCircle size={16} /> Use as my bAvatar
                </button>
              )}
            </div>
          }
        />

        {/* 4. Chat room */}
        {ownLink?.roomTicker ? (
          <Row
            icon={<MessageCircle size={20} color={GOLD} />}
            title="Open its chat room"
            sub={`The room for $${ownLink.ticker}, the token launched with this name.`}
            action={<OpenTokenRoomButton id={ownLink.tokenId} />}
          />
        ) : (
          <Row
            icon={<MessageCircle size={20} color={GOLD} />}
            title="Open its chat room"
            coming
            sub="A room owned by the name itself, so whoever holds the name runs the room. Today rooms open for tokens: launch a token with this name and its room follows."
          />
        )}

        {/* 5. Token (TokenBlaster; not in the store edition) */}
        {MARKET_ENABLED && TOKENBLASTER_ENABLED && (
          <Row
            icon={<Coins size={20} color={GOLD} />}
            title="Launch a token with this name"
            sub={
              ownLink
                ? `$${ownLink.ticker} is already yours.`
                : `Start a $${name.toUpperCase()} token on TokenBlaster, with the name filled in.`
            }
            action={
              ownLink ? (
                <Done>Token launched</Done>
              ) : (
                <a
                  href={tokenblasterLaunchUrl(name)}
                  target="_blank"
                  rel="noreferrer"
                  className={`${BIG} text-[#010101] no-underline`}
                  style={{ background: GOLD }}
                >
                  <Coins size={16} /> Launch ${name.toUpperCase()}
                </a>
              )
            }
          />
        )}

        {/* 6. Store, theme, collection */}
        <Row
          icon={<Link2 size={20} color={GOLD} />}
          title="Link a store, theme or collection"
          coming
          sub={`Point ${name} at your shop, a theme or an NFT collection, so the name opens it.`}
        />

        {/* 7. Sell / give, and Send */}
        {owned ? (
          <Row
            icon={<ShoppingBag size={20} color={GOLD} />}
            title={MARKET_ENABLED ? 'Sell it' : 'Give it away'}
            sub={MARKET_ENABLED ? 'List it for sale in Wallet › Names.' : 'Give it to someone from Wallet › Names.'}
            action={
              <button className={`${BIG} bg-[var(--bw-surface)] text-white`} onClick={() => navigate('/m/my-names')}>
                <ShoppingBag size={16} /> Open Names
              </button>
            }
          />
        ) : (
          owned === null && (
            <Row
              icon={<ShoppingBag size={20} color={GOLD} />}
              title={MARKET_ENABLED ? 'Sell it' : 'Give it away'}
              coming={!canAdopt}
              sub={
                canAdopt
                  ? 'Selling works for names in your Names list. Use Add to my Names above, then sell it from Wallet › Names.'
                  : 'Selling works for names in your Names list. A name received with your NFTs can be sent now, and added to Names once it shows in Wallet › NFTs.'
              }
            />
          )
        )}
        {onSend && (
          <Row
            icon={<Send size={20} color={GOLD} />}
            title="Send it"
            sub="Give the name to a $handle, paymail or address. They own it from then on."
            action={
              <button disabled={!held} className={`${BIG} bg-[var(--bw-surface)] text-white`} onClick={onSend}>
                <Send size={16} /> Send {name}
              </button>
            }
          />
        )}
      </ul>
      {!held && (
        <p className="m-0 text-xs" style={{ color: '#e6d08a' }}>
          <Sparkles size={12} className="inline" /> It’s at your address. Linking, selling and sending unlock once it
          shows in Wallet › NFTs.
        </p>
      )}
      {msg && <p className="m-0 text-sm text-[#98A2B3] break-words">{msg}</p>}

      {handleOpen && (
        <HandleFlow
          title="Use as my $handle"
          suggest={name}
          onClose={() => {
            setHandleOpen(false);
            setPm(getPaymail(identityAddress));
          }}
        />
      )}
      <SendConfirmation
        show={confirmBind}
        theme={theme}
        lineItems={[{ address: `Link ${name} → your identity key`, amount: '1 sat (kept)' }]}
        total={`~${moneyNow(BIND_FEE_SATS)} network fee`}
        isProcessing={busy}
        onConfirm={() => void bind()}
        onCancel={() => setConfirmBind(false)}
      />
    </section>
  );
};

/** The Name card body for a name NFT by its content URL: reads the name (useOpnsName), nothing for an invalid one. */
export const OpnsNameSection = ({
  url,
  fallback,
  ...rest
}: { url: string | null | undefined; fallback?: string } & Omit<Parameters<typeof OpnsNameActions>[0], 'name'>) => {
  const { name } = useOpnsName(url, fallback);
  return name ? <OpnsNameActions name={name} {...rest} /> : null;
};
