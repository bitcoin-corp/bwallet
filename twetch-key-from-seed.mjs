#!/usr/bin/env node
// Find the bWalletX Twetch signing key from the account's 12 recovery words, ON THIS MAC ONLY.
//
//   node twetch-key-from-seed.mjs [seed-file]      default seed file: ~/Secrets/twetch/seed.txt
//
// Reads the words from a private file (never from the command line, so they stay out of shell history),
// tries the derivation paths Twetch-era wallets used, and stops at the key whose public key is exactly the
// bWalletX Twetch account's (twetch.mjs TWETCH_PUBKEY). It then writes TWETCH_SIGN_WIF into the poster env
// (~/Secrets/bwalletx-poster/poster.env, mode 600). It prints only the path it matched: never the words,
// never a key. If nothing matches, nothing is written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HD, Mnemonic } from '@bsv/sdk';
import { TWETCH_ADDRESS, TWETCH_PUBKEY } from './twetch.mjs';

const seedFile = process.argv[2] || path.join(os.homedir(), 'Secrets/twetch/seed.txt');
const envFile = process.env.BWX_POSTER_ENV || path.join(os.homedir(), 'Secrets/bwalletx-poster/poster.env');

if (!fs.existsSync(seedFile)) {
  console.error(`No seed file at ${seedFile}. Put the 12 words in it (one line), then run this again.`);
  process.exit(1);
}
const words = fs.readFileSync(seedFile, 'utf8').trim().toLowerCase().split(/\s+/).join(' ');
if (words.split(' ').length !== 12) {
  console.error(`Expected 12 words in ${seedFile}, found ${words.split(' ').length}. Nothing written.`);
  process.exit(1);
}

let root;
try {
  root = HD.fromSeed(new Mnemonic(words).toSeed());
} catch (e) {
  console.error('Those words are not a valid recovery phrase (check spelling and order). Nothing written.');
  process.exit(1);
}

// Candidate paths: the root itself, then common BIP32/BIP44 branches (coin 0 and 236 = BSV), indexes 0-24.
const bases = ['m/0', 'm/1', "m/0'", "m/0'/0", "m/0'/1", "m/0'/0'", "m/44'/0'/0'/0", "m/44'/0'/0'/1", "m/44'/236'/0'/0", "m/44'/236'/0'/1", "m/44'/236'/0'/2", "m/44'/145'/0'/0"];
const candidates = ['m'];
for (const b of bases) for (let i = 0; i < 25; i++) candidates.push(`${b}/${i}`);

let found = null;
for (const p of candidates) {
  const node = p === 'm' ? root : root.derive(p);
  if (node.pubKey.toString() === TWETCH_PUBKEY) { found = { path: p, wif: node.privKey.toWif() }; break; }
}

if (!found) {
  console.error(`No match for the bWalletX Twetch key (${TWETCH_ADDRESS}) in ${candidates.length} common paths. Nothing written.`);
  console.error('The words may belong to a different Twetch account, or Twetch used another path: tell Claude, it can widen the search.');
  process.exit(2);
}

// Write or replace the TWETCH_SIGN_WIF line, keeping every other line of the poster env.
fs.mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => !l.startsWith('TWETCH_SIGN_WIF=')) : [];
while (lines.length && lines[lines.length - 1] === '') lines.pop();
lines.push(`TWETCH_SIGN_WIF=${found.wif}`, '');
fs.writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });
fs.chmodSync(envFile, 0o600);

console.log(`Matched the bWalletX Twetch key at path ${found.path} (${TWETCH_ADDRESS}).`);
console.log(`Wrote TWETCH_SIGN_WIF to ${envFile} (mode 600).`);
console.log(`You can now delete the seed file: rm ${seedFile}`);
