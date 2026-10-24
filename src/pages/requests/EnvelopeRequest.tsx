import { useState } from 'react';
import type { StreamGrantPrompt } from '../../promptProtocol';
import { ApprovalCard, Check, Chip } from '../../components/approval/ApprovalCard';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { CARD } from '../../components/approval/cardTheme';
import { EnvelopePresets } from '../../components/approval/EnvelopePresets';
import { DEFAULT_ENVELOPE_USD, ENVELOPE_PRESETS_USD, envelopeUsdText } from '../../services/envelopes';
import { siteName } from '../../services/approvalKind';
import { usdToSats } from '../../services/streamGrants';
import { dollarsFirst, priceFrom } from '../../utils/dollarsFirst';
import { sendMessage } from '../../utils/chromeHelpers';

/**
 * "Put $1 in tokenblaster.lol's envelope" (services/envelopes.ts). The user picks the amount; the site can spend
 * only from it, without a sheet per payment, and when it is empty it has to ask again. Dollars first and large,
 * sats small. Without a price the amounts cannot be turned into sats, so the sheet says so and only offers Not now.
 */
export const EnvelopeRequestPage = ({
  request,
  onResponse,
}: {
  request: StreamGrantPrompt;
  onResponse: () => void;
}) => {
  const rate = request.usdPerBsv;
  const [usd, setUsd] = useState<number>(DEFAULT_ENVELOPE_USD);
  const [busy, setBusy] = useState(false);
  const sats = rate ? usdToSats(usd, rate) : 0;
  const balance = request.envelope?.balanceSats ?? 0;
  const price = priceFrom(rate, true);
  const amount = dollarsFirst(sats, price);
  const name = siteName(request.originator);

  const respond = (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    sendMessage({ action: 'STREAM_GRANT_RESPONSE', requestID: request.requestID, capSatsPerHour: allow ? sats : null });
    onResponse();
  };

  return (
    <ApprovalCard
      site={request.originator}
      siteSub={request.description || 'Many small payments'}
      onClose={() => respond(false)}
      closeLabel="Not now"
      closeDisabled={busy}
      hero={<PayHero amount={rate ? envelopeUsdText(usd) : amount.main} sub={amount.sub} badge="ENVELOPE" />}
      title={
        <>
          Put {rate ? envelopeUsdText(usd) : 'money'} in <span style={{ color: CARD.gold }}>{name}</span>&apos;s
          envelope
        </>
      }
      primary={{
        label: rate ? `Put ${envelopeUsdText(usd)} in` : 'Price unavailable',
        onClick: () => respond(true),
        disabled: busy || !sats,
      }}
      secondary={{ label: 'Not now', onClick: () => respond(false), disabled: busy }}
      testId="envelope-sheet"
    >
      <div className="flex flex-col" style={{ gap: 10 }}>
        <EnvelopePresets presetsUsd={ENVELOPE_PRESETS_USD} value={usd} onChange={setUsd} disabled={busy} />
        {balance > 0 && (
          <span style={{ fontSize: 13, color: CARD.muted }} data-testid="envelope-balance">
            Already in it: {dollarsFirst(balance, price).main}
          </span>
        )}
        <div className="flex flex-wrap" style={{ gap: 8 }}>
          <Chip>
            <Check />
            Stays in your wallet
          </Chip>
          <Chip>
            <Check />
            Only {name} can spend it
          </Chip>
          <Chip>
            <Check />
            Coin return any time
          </Chip>
        </div>
        <span style={{ fontSize: 13, color: CARD.soft }}>
          Small payments from {request.originator} come out of the envelope without asking. When it is empty, it asks
          you again. Settings › Envelopes shows what is left.
        </span>
      </div>
    </ApprovalCard>
  );
};
