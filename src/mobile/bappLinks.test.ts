import { describe, expect, test } from 'bun:test';
import { BAPPS, COMING_BAPPS } from './bapps';
import { BX_APPS, COMMERCIAL_APPS, bareHostOf, productKey, withoutDuplicates } from './bappStandard';
import { RADAR_APPS } from './radarApps';
import { featuredApps } from '../utils/constants';
import { BCHAT_FALLBACK_ORIGIN, liveBchatUrl } from '../services/bchatOrigin';

/**
 * Hosts that answered 200 with a real page on 24 Oct 2026 (curl -L, 10 s timeout). Re-probe and add the host
 * when adding an app. www.bchatx.com is on a registrar hold, so its URLs are checked
 * as the wallet opens them: moved to chat.bwalletx.com by liveBchatUrl.
 */
const LIVE_HOSTS = new Set([
  '1bitclaw.com',
  '1satchel.com',
  '1satsocial.online',
  '21e8.com',
  '3dordi.io',
  'add.bico.media',
  'agelessrepublic.com',
  'agents.bwalletx.com',
  'agidentity.org',
  'aibitcoinrevolution.com',
  'aigf.pro',
  'anvil.sendbsv.com',
  'ark.page',
  'authsig.metanet.app',
  'babbageos.com',
  'bananablocks.com',
  'bcalx.com',
  'bdojox.com',
  'bdrivex.com',
  'beta.peermark.online',
  'beymo.app',
  'bfriendsx.com',
  'bitails.io',
  'bitchart.org',
  'bitcoin-3d.vercel.app',
  'bitcoin-art.vercel.app',
  'bitcoin-books-bay.vercel.app',
  'bitcoin-code.vercel.app',
  'bitcoin-dns.vercel.app',
  'bitcoin-exchange-iota.vercel.app',
  'bitcoin-gaming.vercel.app',
  'bitcoin-identity.vercel.app',
  'bitcoin-maps.vercel.app',
  'bitcoin-paint.vercel.app',
  'bitcoin-photos.vercel.app',
  'bitcoin-search.vercel.app',
  'bitcoin-spreadsheet.vercel.app',
  'bitcoinisbsv.com',
  'bitcoinsv.guide',
  'bitgenius.net',
  'bjobsx.com',
  'blackrug.org',
  'bmailx.com',
  'bmintx.com',
  'bmoneyx.com',
  'bmoviesx.com',
  'bmusicx.com',
  'bnewsx.com',
  'bradiox.com',
  'brandcaster.studio',
  'bsharesx.com',
  'bsocialx.com',
  'bstorex.com',
  'bsv.lol',
  'bsvblockchain.360learning.com',
  'bsvpatentforge.com',
  'bsvradar.com',
  'bsvtimes.com',
  'bsvtube.com',
  'budgirls.pro',
  'budz.lol',
  'buttercupdapp.com',
  'bvideox.com',
  'bwriterx.com',
  'calendar.metanet.app',
  'canonic.xyz',
  'casheio.com',
  'cex.io',
  'chaintap.utxoengineer.com',
  'changenow.io',
  'chat.bwalletx.com',
  'copedex.com',
  'craigs.app',
  'crypton.metanet.app',
  'dobruk.pl',
  'docs.metanet.app',
  'dropblocks.org',
  'dxs.app',
  'edwinpai.com',
  'entangleit.com',
  'everdraw.art',
  'explorer.utxoengineer.com',
  'fast.brc.dev',
  'foxplorer.org',
  'fundfeature.com',
  'gaia-explorer.com',
  'gaialog.world',
  'gloss.metanet.app',
  'gmehl.rocks',
  'guardarian.com',
  'gzone.rocks',
  'handcash.io',
  'hastearcade.com',
  'hypertypist.com',
  'immutify.metanet.app',
  'indelible.one',
  'indigolive.io',
  'intellegio.com',
  'lamint.io',
  'lcx.com',
  'legacy.atx.systems',
  'localbitcoinsv.com',
  'marscast.babbage.systems',
  'metamarket.bapp.dev',
  'metanetapps.com',
  'metanethighway.com',
  'meter.bapp.dev',
  'microblog.bitspv.com',
  'mintblue.com',
  'mintpage.pro',
  'mycoinify.com',
  'ninjapunkgirls.com',
  'ninjapunkgirls.online',
  'npgx.website',
  'numbercrunchermath.com',
  'onramp.money',
  'onramper.com',
  'orangegateway.com',
  'ordfields.vercel.app',
  'paiybit.com',
  'papertrade.metanet.app',
  'pay-quickr.atx.systems',
  'paymail.us',
  'peerjump.fun',
  'peerpay.metanet.app',
  'permastackpress.com',
  'pixelwar.click',
  'pollr.gg',
  'primate.cash',
  'projectaccess.app',
  'qart.app',
  'ramp.alchemypay.org',
  'ramp.bsvblockchain.tech',
  'rapidreader.net',
  'rarepepe.club',
  'saibun.io',
  'satolearn.com',
  'satoshipriceindex.xyz',
  'seven.metanet.app',
  'slictionary.com',
  'socialcert.net',
  'sonicstar.net',
  'soundbase.click',
  'startupscout.co',
  'takeitnft.com',
  'tankscope.pro',
  'tempomusic.net',
  'thatsbtcnotbitcoin.com',
  'themetoken.dev',
  'timestamped.io',
  'tlon.cc',
  'todo.metanet.app',
  'tokenblaster.lol',
  'tonicpow.com',
  'truelink.metanet.app',
  'twetch.rocks',
  'uhrp-ui.bapp.dev',
  'unisot.com',
  'unitsofbelief.vercel.app',
  'utxoengineer.com',
  'uwutv.space',
  'vexvoid.com',
  'vibeglowup.com',
  'votari.app',
  'whatsonchain.com',
  'whoiam.bsvblockchain.tech',
  'wiki.bitcoinsv.io',
  'wonkerly.com',
  'x17b.com',
  'your-files-and-stuff.lovable.app',
  'yours.org',
  'zanaadu.com',
  'zedvibe.org',
  'zerodice.online',
  'zoide.io',
]);

/** Every tappable entry the Apps screens, the bApps directory and the in-app browser's featured list expose. */
const tappable = (): { name: string; url: string; where: string }[] => [
  ...BAPPS.map((a) => ({ name: a.name, url: a.url, where: 'built-in' })),
  ...BX_APPS.map((a) => ({ name: a.name, url: a.url, where: 'b*X' })),
  ...COMMERCIAL_APPS.map((a) => ({ name: a.name, url: a.url, where: 'commercial' })),
  ...RADAR_APPS.map((a) => ({ name: a.name, url: a.url, where: 'community' })),
  ...featuredApps.map((a) => ({ name: a.name, url: a.link, where: 'featured' })),
];

describe('bApp links', () => {
  test('every tappable site is on the live allow-list', () => {
    const dead = tappable()
      .filter((e) => !e.url.startsWith('/'))
      .filter((e) => !LIVE_HOSTS.has(bareHostOf(liveBchatUrl(e.url, BCHAT_FALLBACK_ORIGIN)) ?? ''))
      .map((e) => `${e.where}: ${e.name} ${e.url}`);
    expect(dead).toEqual([]);
  });

  test('built-in bApps: no product or URL listed twice', () => {
    const keys = BAPPS.map((a) => productKey(a.name));
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    const urls = BAPPS.map((a) => a.url);
    expect(urls.filter((u, i) => urls.indexOf(u) !== i)).toEqual([]);
  });

  test('b*X and commercial apps: unique ids, products and URLs', () => {
    const all = [...BX_APPS, ...COMMERCIAL_APPS];
    const ids = all.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = all.map((a) => productKey(a.name));
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    const hosts = all.map((a) => bareHostOf(a.url));
    expect(hosts.filter((h, i) => hosts.indexOf(h) !== i)).toEqual([]);
  });

  test('the bApps directory lists each product once across all sections', () => {
    const listed = [...BX_APPS, ...COMMERCIAL_APPS];
    const built = withoutDuplicates(BAPPS, listed);
    const community = withoutDuplicates(RADAR_APPS, [...listed, ...built]);
    const shown = [...listed, ...built, ...community];
    const keys = shown.map((a) => productKey(a.name));
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    const hosts = shown.map((a) => bareHostOf(a.url)).filter(Boolean);
    expect(hosts.filter((h, i) => hosts.indexOf(h) !== i)).toEqual([]);
    // The in-wallet bMovies/bMail/… entries are the b*X sites now, so they collapse into the Featured cards.
    expect(built.map((a) => a.name)).not.toContain('bMoviesX');
    expect(built.map((a) => a.name)).not.toContain('bChatX');
  });

  test('bMintX, bMailX, bCalX and bSharesX open the working in-wallet screens', () => {
    const url = (n: string) => BAPPS.find((a) => a.name === n)?.url;
    expect(url('bMintX')).toBe('/m/bmint');
    expect(url('bMailX')).toBe('/m/bmail');
    expect(url('bCalX')).toBe('/m/calendar');
    expect(url('bSharesX')).toBe('/m/bshares');
    for (const n of ['bMint', 'bMail', 'bCal', 'bShares']) expect(url(n)).toBeUndefined();
  });

  test('product keys fold a b*X name onto its b-name only', () => {
    expect(productKey('bMoviesX')).toBe(productKey('bMovies'));
    expect(productKey('bChatX')).toBe('bchat');
    expect(productKey('bExchange')).toBe('bexchange');
    expect(productKey('NPGX')).toBe('npgx');
  });

  test('Coming entries are not also tappable', () => {
    const keys = new Set(tappable().map((e) => productKey(e.name)));
    for (const c of COMING_BAPPS) expect(keys.has(productKey(c.name))).toBe(false);
  });
});
