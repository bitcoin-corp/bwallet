import type { MintPrivatePrompt } from '../../promptProtocol';

/** The private-mint sheet's words (MintPrivateRequest.tsx), apart so a test can pin them. */
export const mintPrivateSheetText = (r: MintPrivatePrompt) => {
  const seq = r.sequence;
  const posts = seq ? seq.totalPosts : r.posts;
  const sats = seq ? seq.totalSats : r.sats;
  const txs = seq ? seq.totalTxs : r.txs;
  return {
    title: posts !== undefined ? `Lock ${posts.toLocaleString('en')} posts to you` : 'Lock your posts to you',
    site: `${r.originator} is asking`,
    privacy:
      'Private: only you can see them. They are encrypted with your wallet’s keys before they leave this device.',
    cost: `About ${sats.toLocaleString('en')} sats in ${txs.toLocaleString('en')} transaction${txs === 1 ? '' : 's'}`,
    chunks: seq
      ? `Sent in ${seq.chunks.toLocaleString('en')} parts. One Allow covers the whole run for 2 hours, up to 10% over this estimate. Anything more asks again.`
      : undefined,
  };
};
