import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import gihubIcon from '../../assets/github.svg';
import { Show } from '../../components/Show';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useTheme } from '../../hooks/useTheme';
import { useServiceContext } from '../../hooks/useServiceContext';
import { YoursIcon } from '../../components/YoursIcon';
import { ThemeBadge } from '../../components/ThemeBadge';
import { VersionLabel } from '../../components/VersionLabel';
import { getPlatform } from '../../platform';
import { ObsidianBackdrop } from '../../mobile/ui/ObsidianBackdrop';
import { SEEDLESS_ENABLED } from '../../mobile/passkey/prf';
import { SeedlessWelcome } from '../../mobile/passkey/SeedlessWelcome';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (delay = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: 'easeOut', delay },
  }),
};

export const Start = () => {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [showStart, setShowStart] = useState(false);
  const { hideMenu, showMenu } = useBottomMenu();
  const { chromeStorageService } = useServiceContext();
  const { account } = chromeStorageService.getCurrentAccountObject();
  const encryptedKeys = account?.encryptedKeys;

  useEffect(() => {
    hideMenu();
    return () => {
      showMenu();
    };
  }, [hideMenu, showMenu]);

  useEffect(() => {
    if (encryptedKeys) {
      setShowStart(false);
      navigate('/bsv-wallet');
      return;
    }
    setShowStart(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encryptedKeys]);

  const accentColor = theme.color.component.primaryButtonLeftGradient;
  const accentRight = theme.color.component.primaryButtonRightGradient;
  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;
  const bg = theme.color.global.walletBackground;

  return (
    <Show when={showStart}>
      <div
        className="flex flex-col items-center justify-between w-full h-full min-h-[var(--wallet-height)] px-6 py-8"
        style={{ backgroundColor: bg, isolation: 'isolate' }}
      >
        <ObsidianBackdrop />
        {/* Top section — logo + branding */}
        <div className="flex flex-col items-center gap-3 mt-6">
          <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={0}>
            <YoursIcon width="5rem" />
            <VersionLabel color={contrast} className="mt-2 text-center" />
          </motion.div>

          <motion.h1
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={0.1}
            className="text-3xl font-bold tracking-tight text-center"
            style={{ color: contrast }}
          >
            {theme.settings.displayName ?? `${theme.settings.walletName} Wallet`}
          </motion.h1>
          <ThemeBadge theme={theme} />
        </div>

        {/* Bottom section — actions */}
        <div className="flex flex-col items-center gap-3 w-full max-w-[420px] mx-auto mb-2 px-1 overflow-visible">
          {SEEDLESS_ENABLED ? (
            <SeedlessWelcome />
          ) : (
            <>
              {/* Primary: Create */}
              <motion.button
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                custom={0.28}
                whileHover={{ scale: 1.025 }}
                whileTap={{ scale: 0.975 }}
                transition={{ type: 'spring', stiffness: 380, damping: 22 }}
                onClick={() => navigate('/create-wallet')}
                className="w-full rounded-xl h-11 text-sm font-bold tracking-wide"
                style={{
                  background: `linear-gradient(135deg, ${accentColor}, ${accentRight})`,
                  color: theme.color.component.primaryButtonText,
                }}
              >
                Create New Wallet
              </motion.button>

              {/* Secondary-outline: Restore */}
              <motion.div
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                custom={0.36}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                transition={{ type: 'spring', stiffness: 380, damping: 22 }}
                className="w-full p-px rounded-xl"
                style={{
                  background: `linear-gradient(135deg, ${theme.color.component.secondaryOutlineButtonGradientLeft}, ${theme.color.component.secondaryOutlineButtonGradientRight})`,
                }}
              >
                <button
                  onClick={() => navigate('/restore-wallet')}
                  className="w-full rounded-xl h-11 text-sm font-bold tracking-wide border-0 outline-none cursor-pointer"
                  style={{ backgroundColor: bg, color: contrast }}
                >
                  Restore Wallet
                </button>
              </motion.div>
            </>
          )}

          {/* GitHub link */}
          <motion.button
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={0.44}
            whileHover={{ opacity: 0.7 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => window.open(theme.settings.repo, '_blank')}
            className="mt-2 opacity-40 hover:opacity-70 transition-opacity"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            aria-label="View on GitHub"
          >
            <img src={gihubIcon} alt="GitHub" style={{ width: '1.4rem', height: '1.4rem' }} />
          </motion.button>

          {/* Legal notice and the open-source line sit at the bottom, under the GitHub logo (owner, 20 Oct 2026). */}
          {getPlatform().welcomeNotice && (
            <p className="text-[10px] leading-relaxed text-center max-w-[18rem]" style={{ color: gray }}>
              {getPlatform().welcomeNotice}
            </p>
          )}
          <p className="text-xs tracking-wide uppercase text-center" style={{ color: gray }}>
            An open source project
          </p>
        </div>
      </div>
    </Show>
  );
};
