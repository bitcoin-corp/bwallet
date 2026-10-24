// b-Aware row 56: on iOS a framed page could post to Capacitor's "bridge" message handler and
// get JavaScript run in the wallet's main frame via an unescaped callbackId. We can't run Swift
// here, so pin the gate's shape statically, and pin the Capacitor facts it relies on.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const swift = readFileSync(join(root, 'ios/App/App/YoursNativePlugin.swift'), 'utf8');
const gate = swift.slice(
  swift.indexOf('final class MainFrameBridgeGate'),
  swift.indexOf('/// Native side of src/mobile/native.ts.'),
);

describe('iOS bridge gate', () => {
  test("root view controller swaps Capacitor's handler for the gate", () => {
    expect(swift).toContain('installBridgeGate()');
    expect(swift).toContain('controller.removeScriptMessageHandler(forName: MainFrameBridgeGate.handlerName)');
    expect(swift).toContain('controller.add(gate, name: MainFrameBridgeGate.handlerName)');
    expect(swift).toContain('static let handlerName = "bridge"');
  });

  test('gate drops sub-frame and foreign-origin messages before forwarding', () => {
    expect(gate.length).toBeGreaterThan(0);
    const forward = gate.indexOf('inner?.userContentController(controller, didReceive: message)');
    const mainFrame = gate.indexOf('guard message.frameInfo.isMainFrame else { return }');
    const origin = gate.indexOf('origin.host.lowercased() == appHost');
    const cb = gate.indexOf('Self.isSafeCallbackId(id) else { return }');
    for (const i of [mainFrame, origin, cb]) {
      expect(i).toBeGreaterThan(0);
      expect(i).toBeLessThan(forward);
    }
  });

  test('callbackId rule only admits plain integers', () => {
    // Same rule as isSafeCallbackId in Swift.
    const safe = (id: string) => id.length > 0 && id.length <= 20 && /^-?[0-9]+$/.test(id);
    expect(safe('123456')).toBe(true);
    expect(safe('-1')).toBe(true);
    expect(safe("x', a:(document.title='p'),z:'")).toBe(false);
    expect(safe('')).toBe(false);
    expect(safe('1'.repeat(21))).toBe(false);
    expect(gate).toContain('id.count <= 20');
    expect(gate).toContain('digits.allSatisfy { $0 >= "0" && $0 <= "9" }');
  });

  test('Capacitor still generates numeric callbackIds (else the gate would drop real calls)', () => {
    const js = readFileSync(
      join(root, 'node_modules/@capacitor/ios/Capacitor/Capacitor/assets/native-bridge.js'),
      'utf8',
    );
    expect(js).toContain("let callbackId = '-1';");
    expect(js).toContain('callbackId = String(++callbackIdCount);');
    expect(js).toContain('let callbackIdCount = Math.floor(Math.random() * 134217728);');
  });
});
