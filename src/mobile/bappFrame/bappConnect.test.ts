// Connect bWalletX from a bApp (owner, 25 Oct 2026). A framed page reaches the wallet only over BRC-100 XDM
// (frameBridge.ts); the injected window.CWI / brc100 announce exists only in the full-screen browser. Sites that sign
// in with @bwalletx/connect ≤0.5 look only for the injected wallet, so they must open full screen until they ship a
// connect build with an XDM fallback.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BAPPS } from '../bapps';
import { BX_APPS } from '../bappStandard';

const root = join(import.meta.dir, '..', '..', '..');

/** bApps whose live site signs in with @bwalletx/connect 0.5.0 (no XDM route), checked 25 Oct 2026. */
const PROVIDER_ONLY_SITES = ['https://bvideox.com'];

describe('bApp connect routes', () => {
  test('provider-only sites open full screen, where the wallet is injected', () => {
    for (const url of PROVIDER_ONLY_SITES) {
      const b = BAPPS.find((a) => a.url === url);
      expect(b?.noFrame).toBe(true);
      expect(BX_APPS.find((a) => a.url === url)?.standard.inWallet).toBe(false);
    }
  });

  test('the full-screen browser injects the wallet and announces bWalletX for @bwalletx/connect', () => {
    const provider = readFileSync(join(root, 'src/mobile/dapp/provider.ts'), 'utf8');
    expect(provider).toContain("rdns: 'space.bwallet.mobile'");
    expect(provider).toContain('announceWallet(');
    const cwi = readFileSync(join(root, 'src/cwi.ts'), 'utf8');
    expect(cwi).toMatch(/\.CWI = CWI/);
  });

  test("the iOS bridge gate (#88) guards only Capacitor's 'bridge' handler, not the dApp browser's 'yours' handler", () => {
    const swift = readFileSync(join(root, 'ios/App/App/YoursNativePlugin.swift'), 'utf8');
    // The full-screen browser has its own WKWebView and user content controller with the 'yours' handler.
    expect(swift).toContain('let content = WKUserContentController()');
    expect(swift).toContain('name: "yours"');
    expect(swift).toContain('forMainFrameOnly: true, in: .page');
    // The gate is installed on the wallet's own webView only.
    expect(swift).toContain('let controller = webView?.configuration.userContentController else { return }');
    expect(swift).toContain('static let handlerName = "bridge"');
  });
});
