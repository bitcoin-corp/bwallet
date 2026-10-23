import { useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import { Button } from '../../components/Button';
import { useTheme } from '../../hooks/useTheme';
import type { StreamGrantPrompt } from '../../promptProtocol';
import { satsToUsdText, usdToSats } from '../../services/streamGrants';
import { sendMessage } from '../../utils/chromeHelpers';

export type StreamGrantRequestProps = {
  request: StreamGrantPrompt;
  onResponse: () => void;
};

/**
 * "Allow <site> to stream up to $X/hour while you watch". One sheet; the user may lower the cap, never raise it.
 * Only payments from this site carrying this protocol, inside the hourly budget, go through without a sheet.
 */
export const StreamGrantRequestPage = ({ request, onResponse }: StreamGrantRequestProps) => {
  const { theme } = useTheme();
  const rate = request.usdPerBsv;
  const maxSats = request.capSatsPerHour;
  const maxUsd = rate ? (maxSats / 1e8) * rate : undefined;
  const [usdText, setUsdText] = useState(maxUsd !== undefined ? maxUsd.toFixed(2) : '');
  const [satsText, setSatsText] = useState(String(maxSats));
  const [busy, setBusy] = useState(false);

  const cap = useMemo(() => {
    const n = rate ? usdToSats(Number(usdText), rate) : Math.floor(Number(satsText));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, maxSats) : 0;
  }, [usdText, satsText, rate, maxSats]);

  const respond = (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    sendMessage({ action: 'STREAM_GRANT_RESPONSE', requestID: request.requestID, capSatsPerHour: allow ? cap : null });
    onResponse();
  };

  const gray = theme.color.global.gray;
  const contrast = theme.color.global.contrast;
  const until = new Date(request.expiresAt).toLocaleString();
  const headline = satsToUsdText(maxSats, rate) ?? `${maxSats.toLocaleString()} sats`;

  return (
    <div className="flex flex-col items-center justify-center w-full h-full px-6 text-center gap-3">
      <Play size={36} style={{ color: contrast }} />
      <h2 className="m-0 text-lg font-semibold" style={{ color: contrast }}>
        Allow {request.originator} to stream up to {headline}/hour while you watch
      </h2>
      {rate && (
        <p className="m-0 text-xs" style={{ color: gray }}>
          {maxSats.toLocaleString()} sats an hour at most
        </p>
      )}
      {request.description && (
        <p className="m-0 text-xs" style={{ color: gray, maxWidth: '18rem' }}>
          {request.description}
        </p>
      )}
      <p className="m-0 text-xs leading-relaxed" style={{ color: gray, maxWidth: '18rem' }}>
        Only “{request.protocolName}” payments from {request.originator} go through without asking, until {until}.
        Anything else still asks you. Revoke any time in Settings › Streaming permissions.
      </p>
      <label className="flex items-center gap-2 text-sm" style={{ color: contrast }}>
        Cap per hour {rate ? '$' : ''}
        {rate ? (
          <input
            aria-label="Cap in dollars per hour"
            inputMode="decimal"
            value={usdText}
            onChange={(e) => setUsdText(e.target.value)}
            className="w-24 px-2 py-1 rounded bg-transparent border"
            style={{ color: contrast }}
          />
        ) : (
          <input
            aria-label="Cap in sats per hour"
            inputMode="numeric"
            value={satsText}
            onChange={(e) => setSatsText(e.target.value)}
            className="w-28 px-2 py-1 rounded bg-transparent border"
            style={{ color: contrast }}
          />
        )}
        {!rate && 'sats'}
      </label>
      <p className="m-0 text-xs" style={{ color: gray }}>
        {cap ? `${satsToUsdText(cap, rate) ?? ''} ${cap.toLocaleString()} sats/hour` : 'Enter a cap above zero'}
        {cap === maxSats ? ' (the most this site asked for)' : ''}
      </p>
      <div className="flex flex-col gap-2 w-full mt-2" style={{ maxWidth: '18rem' }}>
        <Button theme={theme} type="primary" label="Allow" disabled={busy || !cap} onClick={() => respond(true)} />
        <Button theme={theme} type="secondary-outline" label="Not now" disabled={busy} onClick={() => respond(false)} />
      </div>
    </div>
  );
};
