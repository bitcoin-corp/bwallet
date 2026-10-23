import { useState } from 'react';
import { listOrdinals } from '@1sat/actions';
import { Send } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { NftDetail } from '../media/NftDetail';
import type { MediaItem } from '../media/useWalletMedia';

/**
 * After a card is minted: "Send it" opens the minted NFT in the normal NFT detail, whose Send goes to a $name
 * (sendOrdinals, the same path as Wallet › NFTs), with "Who's it for?" filled in when it was a $name or paymail.
 * Once sent, the recipient can "Use as my bAvatar" from their own NFT detail.
 */
export default function CardSend({ txid, title, to }: { txid: string; title: string; to: string }) {
  const { apiContext } = useServiceContext();
  const [item, setItem] = useState<MediaItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const open = async () => {
    setBusy(true);
    setMsg('');
    try {
      // The new output can take a moment to show in the wallet: look a few times.
      for (let i = 0; i < 5; i++) {
        const { outputs } = await listOrdinals.execute(apiContext, { limit: 50, offset: 0 });
        const o = outputs.find((x) => x.outpoint.startsWith(`${txid}.`) || x.outpoint.startsWith(`${txid}_`));
        if (o) {
          const origin = o.outpoint.replace('.', '_');
          return setItem({
            output: o,
            name: title,
            type: 'image',
            kind: 'images',
            origin,
            url: `${apiContext.services!.ordfs.getContentUrl(origin)}?outpoint=${o.outpoint}`,
            flagged: false,
          });
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      setMsg('Your card is still landing. Send it from Wallet › NFTs in a minute.');
    } catch {
      setMsg("Couldn't find the card yet. Send it from Wallet › NFTs.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => void open()}
        className="h-11 flex items-center justify-center gap-2 rounded-xl font-bold border cursor-pointer bg-transparent disabled:opacity-50"
        style={{ borderColor: 'rgba(255,255,255,0.12)', color: '#F5C542' }}
      >
        <Send size={16} /> {busy ? 'Finding your card…' : to ? `Send it to ${to}` : 'Send it'}
      </button>
      {msg && (
        <p className="text-xs m-0" style={{ color: '#999' }}>
          {msg}
        </p>
      )}
      {item && <NftDetail item={item} initialTo={to} onClose={() => setItem(null)} onSent={() => undefined} />}
    </>
  );
}
