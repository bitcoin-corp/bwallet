import { useEffect, useState } from 'react';
import { RECONCILE_RECORD_KEY, type ReconcileRecord } from '../services/storageReconcile';
import { sendMessageAsync } from '../utils/chromeHelpers';
import { useSnackbar } from './useSnackbar';
import { useStorageRepair } from './useStorageRepair';

/**
 * The recovery tools of Settings › Troubleshooting (Repair Sync, Find a missing token, Find mined payments,
 * Resync coins, Recover a payment by transaction ID), shared with the wallet home shortcuts (owner, 25 Oct 2026)
 * so both places behave identically. Moved unchanged from Settings.tsx. Restore from backup stays in Settings only.
 */
export const useRecoveryTools = () => {
  const { addSnackbar } = useSnackbar();
  const { record: repairRecord, outcome: repairOutcome, runRepair } = useStorageRepair();

  const [missingTokenId, setMissingTokenId] = useState('');
  const missingTokenValid = /^[0-9a-f]{64}[._]\d+$/i.test(missingTokenId.trim());

  type StepResult = { ok: boolean; text: string };
  const handleRepairSync = async (tokenIds?: string[]) => {
    if (repairOutcome === 'running') return;
    // Once a run starts, the overlay shows its result; only a refusal before
    // that (no remote, wallet unavailable) needs a snackbar.
    const before = repairRecord?.startedAt;
    try {
      const response = await runRepair(tokenIds);
      const recovered = response?.data?.tokensRecovered ?? 0;
      const dropped = response?.data?.staleDropped ?? 0;
      if (recovered > 0 || dropped > 0) {
        const parts = [
          recovered > 0
            ? `found ${recovered} token ${recovered === 1 ? 'output' : 'outputs'} this wallet had missed`
            : '',
          dropped > 0 ? `removed ${dropped} already-spent token ${dropped === 1 ? 'record' : 'records'}` : '',
        ].filter(Boolean);
        const text = parts.join(', ');
        addSnackbar(text.charAt(0).toUpperCase() + text.slice(1), 'success');
      } else if (response?.success && response.data?.noRemote) {
        addSnackbar('Tokens checked: nothing to fix', 'success');
      }
      if (response?.success) return;
      const after = (await chrome.storage.local.get(RECONCILE_RECORD_KEY))[RECONCILE_RECORD_KEY] as
        | ReconcileRecord
        | undefined;
      if (after?.startedAt === before) addSnackbar(response?.error ?? 'Repair failed', 'error');
    } catch (error) {
      addSnackbar(error instanceof Error ? error.message : 'Repair failed', 'error');
    }
  };

  // Live step + elapsed seconds for the two recovery buttons (owner, 15 Oct 2026: "Checking…" forever).
  const [recoverStep, setRecoverStep] = useState<{ mined?: string; txid?: string }>({});
  const [recoverStartedAt, setRecoverStartedAt] = useState<{ mined?: number; txid?: number }>({});
  const [, setTick] = useState(0);
  useEffect(() => {
    const onMsg = (m: { action?: string; data?: { kind?: 'mined' | 'txid'; step?: string } }) => {
      if (m?.action !== 'RECOVER_PROGRESS' || !m.data?.kind) return;
      const { kind, step } = m.data;
      setRecoverStep((p) => ({ ...p, [kind]: step }));
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);
  useEffect(() => {
    if (!recoverStartedAt.mined && !recoverStartedAt.txid) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [recoverStartedAt]);
  const elapsed = (k: 'mined' | 'txid') =>
    recoverStartedAt[k] ? ` (${Math.floor((Date.now() - recoverStartedAt[k]!) / 1000)} s)` : '';
  const [recoverFailedMined, setRecoverFailedMined] = useState(false);
  const [recoverFailedTxid, setRecoverFailedTxid] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoverResult, setRecoverResult] = useState('');
  const handleRecoverMined = async () => {
    if (recovering) return;
    setRecovering(true);
    setRecoverResult('');
    setRecoverFailedMined(false);
    setRecoverStep((p) => ({ ...p, mined: 'Starting…' }));
    setRecoverStartedAt((p) => ({ ...p, mined: Date.now() }));
    try {
      const r = await sendMessageAsync<{ success: boolean; error?: string; data?: { summary?: string } }>({
        action: 'STORAGE_RECOVER_MINED',
      });
      const text = r?.data?.summary ?? r?.error ?? 'No answer from the wallet. Try again.';
      setRecoverResult(text);
      setRecoverFailedMined(!r?.success);
      addSnackbar(text, r?.success ? 'success' : 'error');
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Check failed';
      setRecoverResult(text);
      setRecoverFailedMined(true);
      addSnackbar(text, 'error');
    } finally {
      setRecovering(false);
      setRecoverStartedAt((p) => ({ ...p, mined: undefined }));
    }
  };

  const [recoverTxid, setRecoverTxid] = useState('');
  const [recoveringTxid, setRecoveringTxid] = useState(false);
  const [recoverTxidResult, setRecoverTxidResult] = useState('');
  const handleRecoverTxid = async () => {
    if (recoveringTxid) return;
    setRecoveringTxid(true);
    setRecoverTxidResult('');
    setRecoverFailedTxid(false);
    setRecoverStep((p) => ({ ...p, txid: 'Starting…' }));
    setRecoverStartedAt((p) => ({ ...p, txid: Date.now() }));
    try {
      const r = await sendMessageAsync<{ success: boolean; error?: string; data?: { summary?: string } }>({
        action: 'STORAGE_RECOVER_TXID',
        txid: recoverTxid.trim(),
      });
      const text = r?.data?.summary ?? r?.error ?? 'No answer from the wallet. Try again.';
      setRecoverTxidResult(text);
      setRecoverFailedTxid(!r?.success && !/not mined|isn’t|belongs|already/i.test(text));
      addSnackbar(text, r?.success ? 'success' : 'error');
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Check failed';
      setRecoverTxidResult(text);
      setRecoverFailedTxid(true);
      addSnackbar(text, 'error');
    } finally {
      setRecoveringTxid(false);
      setRecoverStartedAt((p) => ({ ...p, txid: undefined }));
    }
  };

  // Resync coins (owner, 17 Oct 2026): clear coins spent from another device, so sends stop failing UTXO_SPENT.
  const [resyncing, setResyncing] = useState(false);
  const [resyncResult, setResyncResult] = useState('');
  const handleResyncCoins = async (): Promise<StepResult> => {
    if (resyncing) return { ok: false, text: 'Already checking' };
    setResyncing(true);
    setResyncResult('');
    setRecoverStep((p) => ({ ...p, txid: 'Starting…' }));
    try {
      const r = await sendMessageAsync<{ success: boolean; error?: string; data?: { summary?: string } }>({
        action: 'STORAGE_RESYNC_COINS',
      });
      const text = r?.data?.summary ?? r?.error ?? 'No answer from the wallet. Try again.';
      setResyncResult(text);
      addSnackbar(text, r?.success ? 'success' : 'error');
      return { ok: !!r?.success, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Resync failed';
      setResyncResult(text);
      addSnackbar(text, 'error');
      return { ok: false, text };
    } finally {
      setResyncing(false);
    }
  };

  const txidValid = /^[0-9a-fA-F]{64}$/.test(recoverTxid.trim());
  const recoverTxidOk = !recoveringTxid && /^(Checked|Restored|Found)/.test(recoverTxidResult ?? '');

  return {
    repairRecord,
    repairOutcome,
    handleRepairSync,
    missingTokenId,
    setMissingTokenId,
    missingTokenValid,
    recoverStep,
    elapsed,
    recovering,
    recoverResult,
    recoverFailedMined,
    handleRecoverMined,
    recoverTxid,
    setRecoverTxid,
    recoveringTxid,
    recoverTxidResult,
    recoverFailedTxid,
    txidValid,
    recoverTxidOk,
    handleRecoverTxid,
    resyncing,
    resyncResult,
    handleResyncCoins,
  };
};

export type RecoveryTools = ReturnType<typeof useRecoveryTools>;
