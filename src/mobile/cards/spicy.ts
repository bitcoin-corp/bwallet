import { SPICY_ENABLED } from '../storeBuild';
import type { CardModel } from './api';

/**
 * Spicy (18+) in the card / image maker. Never in a store build (SPICY_ENABLED). Shown only when the chosen model
 * says spicy:true, and on the web wallet only after the user turned on "Show 18+ options" (a per-browser setting).
 * Each session asks "I'm 18 or over" once before the toggle can be on. Results marked spicy are blurred until tapped.
 */
export const ADULT_PREF_KEY = 'bwx.adult18';
export const ADULT_SESSION_KEY = 'bwx.cards.18ok';

const read = (s: () => Storage, k: string) => {
  try {
    return s().getItem(k) === '1';
  } catch {
    return false;
  }
};
const write = (s: () => Storage, k: string, on: boolean) => {
  try {
    if (on) s().setItem(k, '1');
    else s().removeItem(k);
  } catch {
    /* private mode: stays off */
  }
};

export const adultOptIn = () => read(() => localStorage, ADULT_PREF_KEY);
export const setAdultOptIn = (on: boolean) => write(() => localStorage, ADULT_PREF_KEY, on);
export const adultConfirmedThisSession = () => read(() => sessionStorage, ADULT_SESSION_KEY);
export const confirmAdultThisSession = () => write(() => sessionStorage, ADULT_SESSION_KEY, true);

/** Can the Spicy toggle show for this model? Pure (flags passed in) so it is tested both ways. */
export const spicyAvailable = (
  model: Pick<CardModel, 'spicy'> | undefined,
  o: { web: boolean; optIn: boolean; enabled?: boolean },
): boolean => (o.enabled ?? SPICY_ENABLED) && !!model?.spicy && (!o.web || o.optIn);

/** The 18+ setting row (web only, where spicy is hidden by default). */
export const adultSettingShown = (o: { web: boolean; enabled?: boolean }) => (o.enabled ?? SPICY_ENABLED) && o.web;
