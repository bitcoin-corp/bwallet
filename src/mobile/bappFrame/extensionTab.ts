/**
 * Chrome extension (owner, 23 Oct 2026): the side panel is the bApps launcher, never a cramped in-panel iframe.
 * Tapping a bApp opens it in a normal browser tab — or focuses a tab already on that origin — where the extension's
 * injected BRC-100 provider connects it and the site-theme rule applies. Phones keep the full-screen in-wallet
 * webview; the web wallet keeps its frame. docs/BAPP-STANDARD.md.
 */
export const originPattern = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
};

export async function openInExtensionTab(url: string): Promise<void> {
  const pattern = originPattern(url);
  try {
    if (pattern) {
      const [tab] = await chrome.tabs.query({ url: pattern });
      if (tab?.id !== undefined) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
    }
  } catch {
    // No tabs permission for that host: just open a new tab.
  }
  await chrome.tabs.create({ url });
}
