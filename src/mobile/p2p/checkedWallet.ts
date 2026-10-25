/**
 * A context whose wallet runs a trade check (verify.ts) on every createAction before it is signed, and refuses
 * while spending is paused (kill switch). Used for listing, buying and cancelling player-to-player token listings.
 */
import { assertNotPaused } from '../config/killSwitch';
import type { CheckArgs } from './verify';

type WalletLike = { createAction: (args: never, originator?: string) => Promise<unknown> };

export const checkedContext = <C extends { wallet: W }, W extends WalletLike>(
  ctx: C,
  check: (args: CheckArgs) => void | Promise<void>,
  paused: () => Promise<void> = () => assertNotPaused('spending'),
): C => {
  const wallet = new Proxy(ctx.wallet, {
    get(target, prop, receiver) {
      if (prop === 'createAction')
        return async (args: CheckArgs, originator?: string) => {
          await paused();
          await check(args);
          return target.createAction(args as never, originator);
        };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { wallet });
};
