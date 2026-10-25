/**
 * bWeb: your web on bitcoin (bwalletx.com/bweb). v1 = settings that make bWalletX yours, kept on this
 * device only (localStorage, like Settings › Preferences): which bApps
 * show in the dock and in the Feed's bApps reel, what Ask b may see, and the optional Ask b add-ons.
 *
 * No money flows here. Add-ons do not cost extra: Ask b is free for now (agent/agent.ts ASK_B_FREE), and
 * otherwise each message is priced as it always is (agent/paid.ts quote, or your own AI key). The enabled
 * add-ons are added to b's instructions and sent as `addOns` with each turn so the server can log/route them.
 */
import { ASK_B_FREE } from '../agent/agent';

export type AddOnId = 'names' | 'exchange' | 'bmail' | 'feed';

export type AddOn = { id: AddOnId; label: string; description: string; prompt: string };

/** Optional skills b can use. Each runs inside a normal Ask b message: no extra charge. */
export const ADD_ONS: readonly AddOn[] = [
  {
    id: 'names',
    label: 'Names',
    description: 'Check handles and OpNS names, and explain how to claim one',
    prompt: 'Names: help the user check, compare and claim $handles and OpNS names (Names screen, /m/names).',
  },
  {
    id: 'exchange',
    label: 'Exchange search',
    description: 'Find tokens, apps and strategies on the Exchange',
    prompt: 'Exchange search: help the user find tokens, apps and strategies on the Exchange (/m/exchange).',
  },
  {
    id: 'bmail',
    label: 'bMail drafting',
    description: 'Draft bMail messages for you to review and send yourself',
    prompt: 'bMail drafting: draft bMail messages as plain text for the user to review and send; never send for them.',
  },
  {
    id: 'feed',
    label: 'Feed summaries',
    description: 'Summarise posts you paste or describe from your Feed',
    prompt: 'Feed summaries: summarise Feed posts the user pastes or describes, briefly and neutrally.',
  },
];
export const ADD_ON_IDS = ADD_ONS.map((a) => a.id);
export const ADD_ON_PRICE_NOTE = ASK_B_FREE
  ? 'No extra charge: talking to b is free for now'
  : 'No extra charge: uses your normal Ask b message price';

export type Privacy = {
  /** Tell b which screen you are on (thread.ts screenContext). */
  shareScreen: boolean;
  /** Tell b which bApps you hid from the dock and Feed, so answers fit your setup. */
  shareSetup: boolean;
};

export type BWebSettings = {
  /** Dock ids (wide/BappsDock.tsx) hidden from the dock. */
  dockHidden: string[];
  /** bApp names (bapps.ts) hidden from the Feed's bApps reel. */
  feedHidden: string[];
  privacy: Privacy;
  addOns: Record<AddOnId, boolean>;
};

export const DEFAULT_BWEB: BWebSettings = {
  dockHidden: [],
  feedHidden: [],
  privacy: { shareScreen: true, shareSetup: false },
  addOns: { names: false, exchange: false, bmail: false, feed: false },
};

const KEY = 'bwallet.bweb';
const EVENT = 'bwallet-bweb';

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))].slice(0, 100)
    : [];

/** Field-by-field validation: bad or old values fall back to defaults, never crash. */
export const parseBWeb = (raw: unknown): BWebSettings => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const p = r.privacy && typeof r.privacy === 'object' ? (r.privacy as Record<string, unknown>) : {};
  const a = r.addOns && typeof r.addOns === 'object' ? (r.addOns as Record<string, unknown>) : {};
  return {
    dockHidden: strList(r.dockHidden),
    feedHidden: strList(r.feedHidden),
    privacy: {
      shareScreen: p.shareScreen !== false,
      shareSetup: p.shareSetup === true,
    },
    addOns: Object.fromEntries(ADD_ON_IDS.map((id) => [id, a[id] === true])) as Record<AddOnId, boolean>,
  };
};

export const loadBWeb = (): BWebSettings => {
  try {
    return parseBWeb(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return parseBWeb(null);
  }
};

export const saveBWeb = (patch: Partial<BWebSettings>): BWebSettings => {
  const next = parseBWeb({ ...loadBWeb(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // storage unavailable
  }
  return next;
};

export const onBWebChange = (fn: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

export const toggleIn = (list: string[], item: string, hidden: boolean): string[] =>
  hidden ? [...new Set([...list, item])] : list.filter((x) => x !== item);

export const enabledAddOns = (s: BWebSettings): AddOnId[] => ADD_ON_IDS.filter((id) => s.addOns[id]);

/** Text added to b's instructions: the enabled add-ons and (if allowed) the user's bWeb setup. */
export const bwebContext = (s: BWebSettings): string => {
  const on = ADD_ONS.filter((a) => s.addOns[a.id]);
  let out = '';
  if (on.length)
    out += `\n\nAsk b add-ons the user switched on (use them when relevant):\n${on.map((a) => `- ${a.prompt}`).join('\n')}`;
  if (s.privacy.shareSetup) {
    const hidden = [...s.dockHidden, ...s.feedHidden];
    out += hidden.length
      ? `\n\nThe user's bWeb setup: they hid these bApps from their dock or Feed: ${hidden.join(', ').slice(0, 300)}.`
      : "\n\nThe user's bWeb setup: every bApp shows in their dock and Feed.";
  }
  return out;
};
