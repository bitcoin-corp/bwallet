// One-time OAuth 1.0a (PIN / out-of-band) login for @bmovies_app, using the same X app as xpost.mjs.
// OAuth 1.0a has no scopes: the app's permission setting ("Read and write") covers read, like, repost.
// Tokens go straight into the macOS Keychain (service bmovies-x, account bmovies_app); nothing is printed.
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { appKeys, oauthHeader, KEYCHAIN, BOT_HANDLE } from './lib.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const consumer = appKeys(repo);
const form = (s) => Object.fromEntries(new URLSearchParams(s));

const rtUrl = 'https://api.x.com/oauth/request_token';
let r = await fetch(rtUrl, { method: 'POST', headers: { Authorization: oauthHeader({ method: 'POST', url: rtUrl, consumer, extra: { oauth_callback: 'oob' } }) } });
if (!r.ok) throw new Error(`request_token refused: ${r.status} ${(await r.text()).slice(0, 200)}`);
const rt = form(await r.text());

const authUrl = `https://api.x.com/oauth/authorize?oauth_token=${rt.oauth_token}&force_login=true&screen_name=${BOT_HANDLE}`;
console.log(`\nOpening X. Log in as @${BOT_HANDLE} (NOT your personal account), press Authorize, then copy the PIN.\n${authUrl}\n`);
try { execFileSync('open', [authUrl]); } catch {}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pin = (await rl.question('PIN: ')).trim();
rl.close();

const atUrl = 'https://api.x.com/oauth/access_token';
r = await fetch(atUrl, { method: 'POST', headers: { Authorization: oauthHeader({ method: 'POST', url: atUrl, consumer, token: { token: rt.oauth_token, secret: rt.oauth_token_secret }, extra: { oauth_verifier: pin } }) } });
if (!r.ok) throw new Error(`access_token refused: ${r.status}`);
const at = form(await r.text());
if (at.screen_name?.toLowerCase() !== BOT_HANDLE) {
  console.error(`That login was @${at.screen_name}, not @${BOT_HANDLE}. Nothing saved; run again and log in as @${BOT_HANDLE}.`);
  process.exit(1);
}
const blob = JSON.stringify({ token: at.oauth_token, secret: at.oauth_token_secret, user_id: at.user_id, screen_name: at.screen_name, at: new Date().toISOString() });
// -U updates an existing item. The value is passed as an argument to `security` (local process only, never logged).
execFileSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-l', 'bMovies X bot', '-w', blob], { stdio: 'ignore' });
console.log(`Saved @${at.screen_name} (id ${at.user_id}) to Keychain item "${KEYCHAIN.service}". Test: node bmovies-bot/bot.mjs --dry-run`);
