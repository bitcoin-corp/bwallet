import { useState } from 'react';
import { Lock } from 'lucide-react';
import { Button } from '../../components/Button';
import { useTheme } from '../../hooks/useTheme';
import type { MintPrivatePrompt } from '../../promptProtocol';
import { dollarsFirst, priceFrom } from '../../utils/dollarsFirst';
import { sendMessage } from '../../utils/chromeHelpers';
import { mintPrivateSheetText } from './mintPrivateSheetText';

export type MintPrivateRequestProps = {
  request: MintPrivatePrompt;
  onResponse: () => void;
};

/** "Lock N posts to you": one sheet for a site's private mint (services/mintPrivateSite.ts). */
export const MintPrivateRequestPage = ({ request, onResponse }: MintPrivateRequestProps) => {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(false);
  const t = mintPrivateSheetText(request);
  const sats = request.sequence ? request.sequence.totalSats : request.sats;
  const amount = dollarsFirst(sats, priceFrom(request.usdPerBsv, true));
  const gray = theme.color.global.gray;
  const contrast = theme.color.global.contrast;

  const respond = (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    sendMessage({ action: 'MINT_PRIVATE_RESPONSE', requestID: request.requestID, allow });
    onResponse();
  };

  return (
    <div className="flex flex-col items-center justify-center w-full h-full px-6 text-center gap-3">
      <Lock size={36} style={{ color: contrast }} />
      <h2 className="m-0 text-lg font-semibold" style={{ color: contrast }}>
        {t.title}
      </h2>
      <p className="m-0 text-xs" style={{ color: gray }}>
        {t.site}
      </p>
      <div className="flex flex-col items-center" data-testid="dollar-amount">
        <span style={{ fontSize: 32, fontWeight: 800, lineHeight: 1.1, color: contrast }}>{amount.main}</span>
        <span className="text-xs" style={{ color: gray }}>
          {amount.sub}
        </span>
      </div>
      <p className="m-0 text-sm" style={{ color: contrast }}>
        {t.cost}
      </p>
      <p className="m-0 text-xs leading-relaxed" style={{ color: gray, maxWidth: '18rem' }}>
        {t.privacy}
      </p>
      {t.chunks && (
        <p className="m-0 text-xs leading-relaxed" style={{ color: gray, maxWidth: '18rem' }}>
          {t.chunks}
        </p>
      )}
      <div className="flex flex-col gap-2 w-full mt-2" style={{ maxWidth: '18rem' }}>
        <Button theme={theme} type="primary" label="Allow" disabled={busy} onClick={() => respond(true)} />
        <Button theme={theme} type="secondary-outline" label="Decline" disabled={busy} onClick={() => respond(false)} />
      </div>
    </div>
  );
};
