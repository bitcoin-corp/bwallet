import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Bot, KeyRound, ShieldCheck } from 'lucide-react';
import { useBackClose } from '../backStack';
import { DAILY_LIMITS, useAgentPrefs, type AgentMode } from '../agent/agentPrefs';
import { PROVIDERS, PROVIDER_IDS, callProvider, cleanModel, type ProviderId } from '../agent/providers';
import { deleteKey, loadKey, maskKey, saveKey } from '../agent/keyStore';
import { STORE_AGENT_NOTE, STORE_BUILD } from '../storeBuild';
import { ASK_B_DISCLOSURE, ASK_B_FREE } from '../agent/agent';
import { consentInfo, consentTarget, hasConsent, revokeConsent } from '../agent/consent';

/**
 * Settings › b agent: how the b agent runs. bCorp's service (ASK_B_FREE: no charge and no price shown; else pay per message in
 * BSV with a daily limit) or the user's own provider key (kept in the device's secure storage, sent only to that provider).
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

type RowProps = {
  icon: ReactNode;
  label: string;
  description?: string;
  right?: ReactNode;
  onClick?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
};
type Props = {
  Section: ComponentType<{ title: string; children: ReactNode }>;
  Row: ComponentType<RowProps>;
  Divider: ComponentType;
};

const Pills = <T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) => (
  <div
    className="grid grid-flow-col auto-cols-fr gap-1.5 w-full"
    role="radiogroup"
    aria-label={label}
    onClick={(e) => e.stopPropagation()}
  >
    {options.map((o) => (
      <button
        key={String(o.id)}
        role="radio"
        aria-checked={o.id === value}
        onClick={() => onChange(o.id)}
        className="rounded-full px-1 py-1.5 text-[11px] font-bold whitespace-nowrap text-center"
        style={
          o.id === value
            ? { background: GOLD, color: '#1a1300' }
            : { background: PANEL, color: MUTED, border: `1px solid ${LINE}` }
        }
      >
        {o.label}
      </button>
    ))}
  </div>
);

const MODES: { id: AgentMode; label: string }[] = [
  { id: 'paid', label: ASK_B_FREE ? 'b' : 'Pay per message' },
  { id: 'own', label: 'Own API key' },
];

const Heading = ({ children }: { children: ReactNode }) => (
  <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-widest" style={{ color: MUTED }}>
    {children}
  </p>
);

export const KeyScreen = ({ onBack }: { onBack: () => void }) => {
  useBackClose(true, onBack);
  const [prefs, setPrefs] = useAgentPrefs();
  const provider = PROVIDERS[prefs.provider];
  const [stored, setStored] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState(prefs.models[prefs.provider]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let live = true;
    setDraft('');
    setNote(null);
    setModel(prefs.models[prefs.provider]);
    void loadKey(prefs.provider).then((k) => live && setStored(k));
    return () => {
      live = false;
    };
  }, [prefs.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickProvider = (p: ProviderId) => setPrefs({ provider: p });
  const saveModel = (m: string) => {
    setModel(m);
    setPrefs({ models: { ...prefs.models, [prefs.provider]: cleanModel(prefs.provider, m) } });
  };
  const save = async () => {
    const k = draft.trim();
    if (!k) return;
    await saveKey(prefs.provider, k);
    setStored(k);
    setDraft('');
    setNote({ ok: true, text: 'Saved on this device.' });
  };
  const remove = async () => {
    await deleteKey(prefs.provider);
    setStored(null);
    setNote({ ok: true, text: 'Key deleted from this device.' });
  };
  const test = async () => {
    const k = draft.trim() || stored;
    if (!k) return;
    setTesting(true);
    setNote(null);
    try {
      await callProvider(
        prefs.provider,
        k,
        cleanModel(prefs.provider, model),
        'Reply with the single word: ok',
        [{ role: 'user', text: 'ping' }],
        16,
      );
      setNote({ ok: true, text: `${provider.label} answered. The key works.` });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[150] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div
        className="flex items-center gap-2 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: `1px solid ${LINE}` }}
      >
        <button onClick={onBack} aria-label="Back" className="p-2">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Your API key</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 pb-24">
        <p className="text-xs" style={{ color: MUTED }}>
          The key is stored only on this device (Keychain / Keystore) and sent only to the provider you pick. Our
          servers never receive it. You pay the provider directly.
        </p>
        <Heading>Provider</Heading>
        <Pills
          label="Provider"
          options={PROVIDER_IDS.map((p) => ({ id: p, label: PROVIDERS[p].label }))}
          value={prefs.provider}
          onChange={pickProvider}
        />
        <Heading>Model</Heading>
        <Pills label="Model" options={provider.models} value={model} onChange={saveModel} />
        {provider.freeModel && (
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => saveModel(model)}
            aria-label="Model id"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="mt-2 w-full rounded-xl px-3 py-2 text-sm text-white outline-none"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          />
        )}
        <Heading>Key</Heading>
        {stored && (
          <p className="mb-2 text-sm text-white">
            Saved: <span className="font-mono">{maskKey(stored)}</span>
          </p>
        )}
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={stored ? 'Replace with a new key' : provider.keyHint}
          aria-label={`${provider.label} API key`}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="w-full rounded-xl px-3 py-2 text-sm text-white outline-none"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        />
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => void save()}
            disabled={!draft.trim()}
            className="rounded-full px-4 py-2 text-xs font-bold disabled:opacity-40"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            Save
          </button>
          <button
            onClick={() => void test()}
            disabled={testing || (!draft.trim() && !stored)}
            className="rounded-full px-4 py-2 text-xs font-bold disabled:opacity-40"
            style={{ border: `1px solid ${GOLD}`, color: GOLD }}
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
          {stored && (
            <button
              onClick={() => void remove()}
              className="rounded-full px-4 py-2 text-xs font-bold"
              style={{ border: '1px solid #ff6b6b', color: '#ff6b6b' }}
            >
              Delete key
            </button>
          )}
        </div>
        {note && (
          <p className="mt-3 text-xs" style={{ color: note.ok ? '#5ad17a' : '#ff6b6b' }}>
            {note.text}
          </p>
        )}
        <p className="mt-4 text-xs" style={{ color: MUTED }}>
          Get a key at {provider.keyUrl.replace('https://', '')}.
        </p>
      </div>
    </div>,
    document.body,
  );
};

export const AgentSettings = ({ Section, Row, Divider }: Props) => {
  const [prefs, setPrefs] = useAgentPrefs();
  const [keyScreen, setKeyScreen] = useState(false);
  const target = consentTarget(prefs.mode, prefs.provider);
  const [allowed, setAllowed] = useState(() => hasConsent(target));
  useEffect(() => setAllowed(hasConsent(target)), [target]);
  const info = consentInfo(target);
  return (
    <>
      <Section title="Ask b">
        <Row
          icon={<Bot size={16} />}
          label="Mode"
          description={
            STORE_BUILD
              ? STORE_AGENT_NOTE
              : prefs.mode === 'paid'
                ? ASK_B_FREE
                  ? ASK_B_DISCLOSURE
                  : 'Pay per message from this wallet'
                : 'Use your own AI provider key'
          }
          isFirst
        />
        {!STORE_BUILD && (
          <div className="px-4 pb-3 pl-12">
            <Pills label="b agent mode" options={MODES} value={prefs.mode} onChange={(v) => setPrefs({ mode: v })} />
          </div>
        )}
        <Divider />
        {prefs.mode === 'paid' && ASK_B_FREE ? null : prefs.mode === 'paid' ? (
          <Row
            icon={<Bot size={16} />}
            label="Daily limit"
            description="The most the b agent can spend in a day. Small messages under your one-click limit skip the confirm."
          />
        ) : null}
        {prefs.mode === 'paid' && ASK_B_FREE ? null : prefs.mode === 'paid' ? (
          <div className="px-4 pb-3 pl-12">
            <Pills
              label="Daily limit"
              options={DAILY_LIMITS.map((v) => ({ id: v, label: v ? `$${(v / 100).toFixed(2)}` : 'Off' }))}
              value={prefs.dailyLimitCents}
              onChange={(v) => setPrefs({ dailyLimitCents: v })}
            />
          </div>
        ) : (
          <Row
            icon={<KeyRound size={16} />}
            label="Provider, model and key"
            description={`${PROVIDERS[prefs.provider].label} · ${prefs.models[prefs.provider]}`}
            onClick={() => setKeyScreen(true)}
          />
        )}
        <Divider />
        <Row
          icon={<ShieldCheck size={16} />}
          label={`Sharing with ${info.provider}`}
          description={
            allowed
              ? `Allowed: your b agent messages and recent conversation go to ${info.provider}. Revoke to stop; b will ask again before sending.`
              : `Not allowed. b asks before sending anything to ${info.provider}.`
          }
          right={
            allowed ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  revokeConsent(target);
                  setAllowed(false);
                }}
                className="rounded-full px-3 py-1 text-[11px] font-bold"
                style={{ border: '1px solid #ff6b6b', color: '#ff6b6b' }}
              >
                Revoke
              </button>
            ) : undefined
          }
          isLast
        />
      </Section>
      {keyScreen && <KeyScreen onBack={() => setKeyScreen(false)} />}
    </>
  );
};
