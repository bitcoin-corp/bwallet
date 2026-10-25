import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { promptsShowInPanel } from './panelPrompt';

describe('promptsShowInPanel', () => {
  it('extension with an open panel: prompt goes in the panel', () => {
    expect(promptsShowInPanel(1, { sidePanel: {} })).toBe(true);
  });
  it('phone / web wallet (no sidePanel): never the panel, even with the main window port open', () => {
    // The bChatX-in-frame hang (14 Oct 2026): the web shell connects 'extension-popup' but has no PanelPrompt.
    expect(promptsShowInPanel(1, {})).toBe(false);
    expect(promptsShowInPanel(1, undefined)).toBe(false);
  });
  it('no panel open: falls back to the window / overlay', () => {
    expect(promptsShowInPanel(0, { sidePanel: {} })).toBe(false);
  });
  it('background uses it for the panel decision', () => {
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    expect(bg).toMatch(/if \(promptsShowInPanel\(activePopupPorts\.size, chrome\) && kind !== 'unlock'\)/);
  });
});

import { keepPanelPort, promptForNewPanel } from './panelPrompt';

describe('promptForNewPanel', () => {
  it('the prompt the panel was opened for wins, else the oldest pending one', () => {
    expect(promptForNewPanel({ kind: 'bundle', requestID: 'a' }, { kind: 'permission', requestID: 'b' })).toEqual({
      kind: 'bundle',
      requestID: 'a',
    });
    expect(promptForNewPanel(undefined, { kind: 'permission', requestID: 'b' })?.requestID).toBe('b');
    expect(promptForNewPanel(undefined, undefined)).toBeUndefined();
    expect(promptForNewPanel({ kind: 'unlock' }, undefined)).toBeUndefined();
  });
});

/** A fake service worker: holds pending prompts, answers PANEL_READY, and can be "restarted" (ports drop). */
const fakeWorker = () => {
  const pending: { kind: string; requestID: string }[] = [];
  const ports: { deliver: (m: unknown) => void; drop: () => void }[] = [];
  const connect = () => {
    const msgL: ((m: unknown) => void)[] = [];
    const discL: (() => void)[] = [];
    const port = {
      onMessage: { addListener: (f: (m: unknown) => void) => void msgL.push(f) },
      onDisconnect: { addListener: (f: () => void) => void discL.push(f) },
      postMessage: (m: unknown) => {
        // The worker side: a panel that is ready gets what is pending, straight away.
        if ((m as { action?: string }).action === 'PANEL_READY') {
          const p = promptForNewPanel(undefined, pending[0]);
          if (p) msgL.forEach((f) => f({ action: 'SHOW_PROMPT_PANEL', ...p }));
        }
      },
      disconnect: () => undefined,
    };
    ports.push({ deliver: (m) => msgL.forEach((f) => f(m)), drop: () => discL.forEach((f) => f()) });
    return port;
  };
  return { pending, ports, connect };
};

describe('keepPanelPort (service worker restart)', () => {
  it('reconnects when the worker goes away and gets the pending request without any user input', () => {
    const w = fakeWorker();
    const seen: unknown[] = [];
    const timers: (() => void)[] = [];
    const stop = keepPanelPort(
      w.connect,
      (m) => seen.push(m),
      undefined,
      (f) => timers.push(f),
    );
    expect(w.ports.length).toBe(1);

    // Chrome restart / idle: the worker stops, its port drops. A fresh worker has a payment waiting.
    w.ports[0].drop();
    w.pending.push({ kind: 'bundle', requestID: 'pay-10c' });
    expect(timers.length).toBe(1);
    timers.shift()!(); // the immediate reconnect (0 ms), not a click or a scroll
    expect(w.ports.length).toBe(2);
    expect(seen).toContainEqual({ action: 'SHOW_PROMPT_PANEL', kind: 'bundle', requestID: 'pay-10c' });
    stop();
  });

  it('stops reconnecting once the panel closes', () => {
    const w = fakeWorker();
    const timers: (() => void)[] = [];
    const stop = keepPanelPort(
      w.connect,
      () => undefined,
      undefined,
      (f) => timers.push(f),
    );
    stop();
    w.ports[0].drop();
    timers.forEach((f) => f());
    expect(w.ports.length).toBe(1);
  });

  it('background pushes pending prompts on connect and on PANEL_READY', () => {
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    expect(bg).toContain("action !== 'PANEL_READY'");
    expect(bg).toMatch(/promptForNewPanel\(panelPromptOnConnect, getNextPendingPrompt\(\)\)/);
  });
});

import { isFullscreenWindow } from './panelPrompt';
describe('fullscreen sites', () => {
  it('detects a fullscreen window', () => {
    expect(isFullscreenWindow({ state: 'fullscreen' })).toBe(true);
    expect(isFullscreenWindow({ state: 'normal' })).toBe(false);
    expect(isFullscreenWindow(undefined)).toBe(false);
  });
  it('background asks the page to exit fullscreen and the content script does it', () => {
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    const cs = readFileSync(new URL('../content.ts', import.meta.url), 'utf8');
    expect(bg).toContain('void surfaceOverFullscreen(');
    expect(bg).toContain("action: 'BWX_EXIT_FULLSCREEN'");
    expect(cs).toMatch(/BWX_EXIT_FULLSCREEN[\s\S]*?document\.exitFullscreen\(\)/);
  });
});
