import { lazy, Suspense, useEffect, useState } from 'react';
import { AtSign, FileText, Github } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../../hooks/useTheme';
import { UNOFFICIAL_NOTICE } from '../brandText';
import { openDappBrowser } from '../dappBrowser';

declare const __MOBILE_VERSION__: string;
import { AppsAndTools } from '../../pages/AppsAndTools';
import { Settings } from '../../pages/Settings';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { versionLabel } from '../channel';
import { BUREAU_ENABLED, DIRECT_UPDATE_ENABLED } from '../storeBuild';
import { ADD_ACCOUNT_QUERIES } from '../wide/composer';

// Android direct APK only: the in-app updater (update/), not even built into other channels.
const DirectUpdateCard = DIRECT_UPDATE_ENABLED
  ? lazy(() => import('../update/UpdateCard').then((m) => ({ default: m.DirectUpdateCard })))
  : null;

/**
 * Settings tab: upstream Settings, plus upstream Tools (locks, sweep, decoder,
 * sponsor…) and About (version, source code). Opened from the account drawer;
 * 'tools' deep-links (handleSelect('tools')) land on Tools.
 */
type Section = 'settings' | 'new' | 'tools' | 'about';

// Drawer links that open the add-account pages get their own pill, so Settings always means the Settings list.
const NEW_QUERIES = ADD_ACCOUNT_QUERIES;

const SettingsHub = () => {
  const { selected, query, handleSelect } = useBottomMenu();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [section, setSection] = useState<Section>(
    query === 'about' ? 'about' : NEW_QUERIES.includes(query) ? 'new' : selected === 'tools' ? 'tools' : 'settings',
  );
  // Drawer deep links: create / restore account open New; the others are Settings pages.
  useEffect(() => {
    if (query) setSection(query === 'about' ? 'about' : NEW_QUERIES.includes(query) ? 'new' : 'settings');
  }, [query]);

  const choose = (id: Section) => {
    setSection(id);
    // Leave any deep-linked sub-page behind: Settings opens its list, New opens Create account.
    if (id === 'settings' && query) handleSelect('settings', '');
    if (id === 'new' && !NEW_QUERIES.includes(query)) handleSelect('settings', 'restore-account');
  };

  const pill = (id: Section, label: string) => (
    <button
      key={id}
      onClick={() => choose(id)}
      className="flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors"
      style={{
        background: section === id ? '#2b2f36' : 'transparent',
        color: section === id ? '#FFFFFF' : '#98A2B3',
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="relative w-full h-full">
      <div
        className="fixed left-0 right-0 z-[11] px-4 pb-2"
        style={{ top: 'calc(var(--wallet-inset-top, 0px) + 3.5rem)', background: 'var(--bw-bg)' }}
      >
        <div className="flex gap-1 rounded-xl p-1 bg-[var(--bw-surface)]">
          {pill('settings', 'Settings')}
          {pill('new', 'New')}
          {pill('tools', 'Tools')}
          {pill('about', 'About')}
        </div>
      </div>
      <div className="w-full h-full flex flex-col items-center" style={{ paddingTop: '2.75rem' }}>
        {section === 'settings' && <Settings key="settings" />}
        {section === 'new' && <Settings key="new" />}
        {section === 'tools' && (
          // A little clearance below the Settings | Tools | About switch.
          <div className="w-full pt-6">
            <div className="px-4 pb-3">
              <button
                onClick={() => navigate('/m/you')}
                className="flex w-full items-center gap-3 rounded-xl bg-[var(--bw-surface)] px-4 py-3 text-left"
              >
                <AtSign size={18} color="#98A2B3" />
                <div>
                  <div className="text-sm font-semibold text-white">Names, rooms and tickets</div>
                  <div className="text-[11px] text-[#98A2B3]">Three separate things, the same on every device</div>
                </div>
              </button>
            </div>
            {BUREAU_ENABLED && (
              // One-time import of documents signed on bit-sign (retired quietly, 18 Oct 2026); not on bMail's screen.
              <div className="px-4 pb-3">
                <button
                  onClick={() => navigate('/m/bmail/agreements/bit-sign')}
                  className="flex w-full items-center gap-3 rounded-xl bg-[var(--bw-surface)] px-4 py-3 text-left"
                >
                  <FileText size={18} color="#98A2B3" />
                  <div>
                    <div className="text-sm font-semibold text-white">Import from bit-sign</div>
                    <div className="text-[11px] text-[#98A2B3]">Documents you signed there, read-only</div>
                  </div>
                </button>
              </div>
            )}
            <AppsAndTools />
          </div>
        )}
        {section === 'about' && (
          <div className="w-full px-4 pt-20 flex flex-col gap-3">
            <div className="rounded-xl bg-[var(--bw-surface)] px-4 py-3">
              <div className="text-sm font-semibold text-white">{theme.settings.displayName}</div>
              <div className="text-[11px] text-[#98A2B3]">Version {versionLabel(__MOBILE_VERSION__)}</div>
            </div>
            {DirectUpdateCard && (
              <Suspense fallback={null}>
                <DirectUpdateCard />
              </Suspense>
            )}
            <button
              onClick={() => void openDappBrowser(theme.settings.repo)}
              className="flex items-center gap-3 rounded-xl bg-[var(--bw-surface)] px-4 py-3 text-left"
            >
              <Github size={18} color="#98A2B3" />
              <div>
                <div className="text-sm font-semibold text-white">Source code</div>
                <div className="text-[11px] text-[#98A2B3]">{theme.settings.repo.replace('https://', '')}</div>
              </div>
            </button>
            <p className="text-[10px] leading-relaxed text-[#667085] text-center px-2">{UNOFFICIAL_NOTICE}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsHub;
