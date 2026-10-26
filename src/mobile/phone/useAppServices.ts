import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { initPairing, setAgentPairDeps } from '../pair/sessions';
import { onPairLink, takePairLink } from '../pair/links';
import { useSpaceInviteLinks } from '../spaces/inviteLinks';
import { useSubscribeLinks } from '../pots/subscribeLink';
import { usePeerPayLinks } from '../scan/peerpayLinks';

/**
 * The top bar's non-visual duties, mounted ONCE by PhoneShell in the phone layout (TopNav is mounted inside every
 * page, so it can't own them there): pair links from the camera, reconnecting paired sites, and the paired
 * CLI / MCP wallet context. With the layout off, TopNav keeps doing this exactly as before.
 */
export const useAppServices = () => {
  const { chromeStorageService, apiContext } = useServiceContext();
  const [pairLink, setPairLink] = useState<string | null>(null);
  useEffect(() => {
    const show = () => {
      const url = takePairLink();
      if (url) setPairLink(url);
    };
    show();
    return onPairLink(show);
  }, []);
  useSpaceInviteLinks();
  useSubscribeLinks();
  usePeerPayLinks();
  useEffect(() => {
    initPairing();
  }, []);
  const current = chromeStorageService.getCurrentAccountObject().account?.addresses.identityAddress;
  useEffect(() => {
    setAgentPairDeps({
      ctx: apiContext,
      currentId: current,
      feeRate: () => chromeStorageService.getCustomFeeRate(),
      accountCount: chromeStorageService.getAllAccounts().length,
    });
  }, [apiContext, current, chromeStorageService]);
  return { pairLink, clearPairLink: () => setPairLink(null) };
};
