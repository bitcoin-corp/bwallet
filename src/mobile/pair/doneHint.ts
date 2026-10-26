/** PairSheet "done" copy outside the extension: send people back to the browser tab they came from. */
export const switchBackHint = (host: string, ios: boolean) =>
  `Now switch back to ${ios ? 'Safari' : 'your browser'} to carry on at ${host}. Keep bWallet open while you use the site.`;

/**
 * Done copy when the site asked for a return and it was accepted (src/pair/returnTo.ts). The phone apps go back on
 * their own; the web wallet needs a tap (a browser only opens a new tab from one) and must stay open.
 */
export const returnHint = (host: string, web: boolean) =>
  web
    ? `Tap Return to carry on at ${host}. Keep this tab open while you use the site.`
    : `Taking you back to ${host}… Keep bWallet open while you use the site.`;
