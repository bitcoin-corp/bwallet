import { useCallback, useEffect, useRef, useState } from 'react';
import { invertOnLightClass } from '../invertOnLight';
import { createPortal } from 'react-dom';
import { Pause, Play, Square } from 'lucide-react';
import type { PrivateKey } from '@bsv/sdk';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { pauseAudio } from '../player';
import { getPayTo, postSegment, postSponsored, type SponsorStatus } from './api';
import { HEADLINE_ALBUM } from '../featured/featured';
import { VEXVOID_STILLS, VEXVOID_THUMBS } from '../featured/stills';
import { StillsBanner } from '../featured/StillsBanner';
import { StreamEngine } from './engine';
import { isSponsoredTrack, PerSecondKeySource, pickKeySource, SponsoredKeySource, trackSourceKind } from './keySource';
import { paymentsPerSecond, SessionPayer, type PayerSnapshot } from './payer';
import { ACTIVE_SESSIONS, forgetSession, openSession, openSponsoredSession, sweepFirst } from './session';
import { PayToPlay, SponsorEnded, SponsoredPayer, type SponsorSnapshot } from './sponsor';
import { PotGauge, SponsorBadge } from './SponsorBadge';
import { SPONSOR_ALBUM_ID, sponsorName, useManifest, useSponsor } from './useAlbum';
import { boardChoice, claimSession, setBoardChoice } from './board';
import ListenerBoard from './ListenerBoard';
import { useAccountNames } from '../../names/accountNames';
import { estimateTotal, SEGMENT_FEE } from './tx';
import { getWalletBalance } from '../../../utils/wallet';
import { logStep, takePending } from '../../onboarding/funnel/funnel';
import { BMUSIC_FUNNEL } from '../../onboarding/funnel/products';
import { AddFundsSheet } from '../../onboarding/funnel/FunnelSheets';
import { TipButton } from '../../tip/TipButton';
import { SHARE_ALBUMS } from '../shareAlbums';
import { assertNotPaused } from '../../config/killSwitch';

/** The album's free headline track, played from the wallet's own copy (featured.ts) by the page. */
export type Headline = { playing: boolean; duration?: number; onPlay: () => void };

/**
 * Media › the album page ("Echoes in the Abyss" by VexVoid): the free headline track first, then the
 * pay-per-second streaming (bWalletX only, PAY_STREAM_ENABLED). One budget approval funds a
 * session key; after that each 1-second segment is its own transaction (Teranode throughput demo), with no
 * popups. Stop, leaving, or 60 s hidden returns what's left to the wallet.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = 'var(--bw-card)';
const LINE = 'var(--bw-line)';
const MUTED = 'var(--bw-muted)';
const HIDDEN_STOP_MS = 60_000;

/** A paid session (funded budget, swept on stop) or a sponsored one (the pot pays; nothing to sweep). */
type Session = { id: string; key: PrivateKey; engine: StreamEngine; payer?: SessionPayer; sponsor?: SponsoredPayer };

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export default function StreamAlbum({ headline, autoplay }: { headline: Headline; autoplay?: number }) {
  const { apiContext, chromeStorageService } = useServiceContext();
  const wallet = apiContext?.wallet;
  const accountObj = chromeStorageService.getCurrentAccountObject();
  const names = useAccountNames(
    accountObj.account?.addresses.identityAddress,
    accountObj.account?.name ?? '',
    '',
    false,
  );
  const [identityKey, setIdentityKey] = useState<string | null>(null);
  useEffect(() => {
    if (!wallet) return;
    wallet
      .getPublicKey({ identityKey: true })
      .then((r) => setIdentityKey(r.publicKey))
      .catch(() => setIdentityKey(null));
  }, [wallet]);
  /** Listener board opt-in: asked once per session, after its first paid or sponsored second. */
  const [ask, setAsk] = useState<string | null>(null);
  const [boardTick, setBoardTick] = useState(0);
  const [claimNote, setClaimNote] = useState<string | null>(null);
  const asked = useRef<Set<string>>(new Set());
  const { m, error: loadError, view } = useManifest();
  const [sheet, setSheetRaw] = useState<null | { track: number; from?: number; topUp?: boolean }>(null);
  /** The funnel's add-funds step: shown instead of the budget sheet while the wallet can't pay for a minute. */
  const [funds, setFunds] = useState<null | { track: number; from?: number; topUp?: boolean }>(null);
  const satsPerSec = m?.satsPerSegment ?? 1;
  const setSheet = useCallback(
    (x: null | { track: number; from?: number; topUp?: boolean }) => {
      if (!x) return setSheetRaw(null);
      const minute = estimateTotal(60, satsPerSec) + SEGMENT_FEE;
      void getWalletBalance()
        .then((b) => (b < minute ? setFunds(x) : setSheetRaw(x)))
        .catch(() => setSheetRaw(x));
    },
    [satsPerSec],
  );
  /** Sponsored tracks play free; the budget sheet only appears when a pay-to-play track starts or the pot runs out. */
  const sponsorRef = useRef<SponsorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState<PayerSnapshot | null>(null);
  const [sSnap, setSSnap] = useState<SponsorSnapshot | null>(null);
  const [notice, setNotice] = useState<null | { track: number; from: number }>(null);
  const [track, setTrack] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [returned, setReturned] = useState<string | null>(null);
  const [, tick] = useState(0);
  const session = useRef<Session | null>(null);

  const [sponsor, setSponsor, sponsorKnown] = useSponsor(playing ? 15_000 : undefined);
  sponsorRef.current = sponsor;
  const sponsored = !!sponsor?.sponsored;
  const covered = (trackId: string) => isSponsoredTrack(sponsor, trackId);
  // The budget covers the pay-to-play tracks only: the headline is free and the pot pays for the sponsored ones.
  const albumSeconds =
    m && view
      ? view.paid.filter((p) => !covered(p.track.trackId)).reduce((s, p) => s + p.track.segments * m.segmentSeconds, 0)
      : 0;

  /** Stop paying and return the leftover to the wallet. */
  const end = useCallback(async () => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    s.engine.stop();
    setPlaying(false);
    if (!s.payer) return; // sponsored: nothing was funded, nothing to return
    s.payer.close();
    if (!wallet) return;
    try {
      const sats = await sweepFirst(wallet, s.key, s.payer!.sweepCandidates());
      forgetSession(s.id);
      setReturned(sats ? `${sats} sats returned to your wallet` : null);
    } catch (e) {
      ACTIVE_SESSIONS.delete(s.id);
      // The record stays; the next app start sweeps it (session.ts recoverSessions).
      setReturned(`Couldn't return the budget yet (${e instanceof Error ? e.message : e}). It will be retried.`);
    }
  }, [wallet]);

  // Leaving the page ends the session; hidden for 60 s does too.
  useEffect(() => () => void end(), [end]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onVis = () => {
      if (t) clearTimeout(t);
      t = document.hidden ? setTimeout(() => void end(), HIDDEN_STOP_MS) : null;
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onVis);
    return () => {
      if (t) clearTimeout(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onVis);
    };
  }, [end]);
  useEffect(() => {
    if (!playing) return;
    const i = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, [playing]);

  /** Sponsored: no budget sheet, no funding. A 410 mid-listen shows the notice, then the paid flow. */
  const startSponsored = async (index: number, from = 0) => {
    if (!wallet || !m) return;
    setBusy(true);
    setProblem(null);
    setReturned(null);
    setNotice(null);
    try {
      await end();
      const { id, key } = await openSponsoredSession(wallet);
      const sp = new SponsoredPayer({ key, post: (b) => postSponsored(b), onChange: setSSnap });
      const keys = pickKeySource({
        sponsored: new SponsoredKeySource(sp, key, (t) => isSponsoredTrack(sponsorRef.current, t)),
      })!;
      const engine: StreamEngine = new StreamEngine(m, keys, {
        onTrack: setTrack,
        onPlaying: setPlaying,
        onAlbumEnd: () => void end(),
        onError: (e) => {
          // The album moved on to a pay-to-play track (or the server said so): ask for a budget from here.
          if (e instanceof PayToPlay) setSheet({ track: engine.index, from: engine.seg });
          else if (e instanceof SponsorEnded) {
            setSponsor((x) => (x ? { ...x, sponsored: false } : x));
            setNotice({ track: engine.index, from: engine.seg });
          } else setProblem(e instanceof Error ? e.message : String(e));
        },
      });
      session.current = { id, key, engine, sponsor: sp };
      logStep(BMUSIC_FUNNEL.id, 'more');
      setSnap(null);
      setSSnap(sp.snapshot());
      pauseAudio();
      void engine.playTrack(index, from);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async (budget: number, index: number, from = 0) => {
    if (!wallet || !m) return;
    setBusy(true);
    setProblem(null);
    setReturned(null);
    try {
      await end();
      const { id, key, coin } = await openSession(wallet, budget);
      const payer = new SessionPayer({
        key,
        coin,
        getPayTo: (t, n) => getPayTo(t, n),
        post: (b) => postSegment(b),
        onChange: setSnap,
        checkSpending: () => assertNotPaused('spending'),
      });
      const keys = pickKeySource({ perSecond: new PerSecondKeySource(payer, key) })!;
      const engine = new StreamEngine(m, keys, {
        onTrack: setTrack,
        onPlaying: setPlaying,
        onAlbumEnd: () => void end(),
        onError: (e) => {
          if (payer.status === 'out') setSheet({ track: engine.index, from: engine.seg, topUp: true });
          else setProblem(e instanceof Error ? e.message : String(e));
        },
      });
      session.current = { id, key, payer, engine };
      logStep(BMUSIC_FUNNEL.id, 'buy');
      setSSnap(null);
      setSnap(payer.snapshot());
      setSheet(null);
      pauseAudio();
      void engine.playTrack(index, from);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const playAt = (index: number) => {
    const s = session.current;
    const kind = m ? trackSourceKind(sponsor, m.tracks[index].trackId) : 'perSecond';
    // Each track uses its own source: switching between sponsored and paid starts the other kind of session.
    if (!s || (kind === 'sponsored') !== !!s.sponsor)
      return kind === 'sponsored' ? void startSponsored(index) : setSheet({ track: index });
    if (s.engine.index === index) return s.engine.paused ? s.engine.resume() : s.engine.pause();
    void s.engine.playTrack(index);
  };

  const retry = () => {
    const s = session.current;
    if (!s) return;
    s.payer?.resync();
    s.sponsor?.resync();
    setProblem(null);
    void s.engine.playTrack(s.engine.index, s.engine.seg);
  };

  const auto = useRef(autoplay);
  // Back from the funnel's "Get bWalletX" (guest album page): carry on with the first track after the free one.
  const [resume] = useState(() => (autoplay === undefined ? takePending(BMUSIC_FUNNEL.id) : null));
  const resumed = useRef(false);
  useEffect(() => {
    if (!resume || resumed.current || !view?.paid.length) return;
    resumed.current = true;
    auto.current = view.paid[0].index;
  }, [resume, view]);
  useEffect(() => {
    // Opened from a banner / list row: play that track once the manifest and the pot are known.
    if (auto.current === undefined || !m || !wallet || !sponsorKnown) return;
    const i = auto.current;
    auto.current = undefined;
    playAt(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, wallet, sponsorKnown, view]);

  const title = view?.title ?? HEADLINE_ALBUM.title;
  const artist = view?.artist ?? HEADLINE_ALBUM.artist;
  const cover = view?.cover ?? HEADLINE_ALBUM.cover;
  const st = snap?.stats;
  const sst = sSnap?.stats;
  const artistName = view?.artist ?? HEADLINE_ALBUM.artist;
  const sessionId = session.current?.id;
  const firstSecond = (st?.payments ?? 0) + (sst?.payments ?? 0) > 0;
  const claim = async (pub: string) => {
    if (!wallet) return;
    const handle = names.handle?.startsWith('$') ? names.handle : undefined;
    try {
      await claimSession(wallet, pub, handle);
      setClaimNote(null);
      setBoardTick((x) => x + 1);
    } catch (e) {
      const status = (e as { status?: number }).status;
      setClaimNote(
        status === 409
          ? 'This session is already on the board under another identity.'
          : `Couldn't add you to the board: ${e instanceof Error ? e.message : e}`,
      );
    }
  };
  useEffect(() => {
    const cur = session.current;
    if (!firstSecond || !cur || asked.current.has(cur.id)) return;
    asked.current.add(cur.id);
    const choice = boardChoice(artistName);
    const pub = cur.key.toPublicKey().toString();
    if (choice === 'yes') void claim(pub);
    else if (choice === null) setAsk(pub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstSecond, sessionId]);
  const s = session.current;
  const playHeadline = () => {
    void end();
    headline.onPlay();
  };
  const thumb = (n: number) => VEXVOID_THUMBS[n % VEXVOID_THUMBS.length];
  return (
    <section
      className="flex flex-col gap-5"
      style={{ border: `1px solid ${LINE}`, borderRadius: 6, overflow: 'hidden' }}
    >
      <StillsBanner stills={VEXVOID_STILLS} className="w-full">
        <div className="flex flex-col md:flex-row gap-5 md:gap-8 p-4 md:p-6">
          <img
            src={cover}
            onError={(e) => {
              if (e.currentTarget.src !== HEADLINE_ALBUM.cover) e.currentTarget.src = HEADLINE_ALBUM.cover;
            }}
            alt={`${title} cover`}
            className={`w-full md:w-[260px] shrink-0 aspect-square object-cover${invertOnLightClass(artistName)}`}
            style={{ borderRadius: 6, boxShadow: '0 10px 30px rgba(0,0,0,0.7)', background: '#000' }}
          />
          <div className="flex-1 min-w-0 flex flex-col justify-end gap-2">
            <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: GOLD }}>
              Album
            </div>
            <h2 className="text-3xl md:text-5xl font-black text-white leading-tight">{title}</h2>
            <div className="text-sm text-white/80 flex items-center gap-2 flex-wrap">
              <span>
                {artist}
                {m ? ` · ${view!.paid.length + 1} tracks` : ''}
              </span>
              {(() => {
                const al = SHARE_ALBUMS.find((x) => x.artist === artistName && x.tipTo);
                return al?.tipTo ? (
                  <TipButton
                    to={{ name: al.artist, paymail: al.tipTo }}
                    context={{ kind: 'artist', artist: al.artistSlug, album: al.id }}
                  />
                ) : null;
              })()}
            </div>
            <div className="text-sm mt-1" style={{ color: '#e6e8ec' }}>
              Headline track: {HEADLINE_ALBUM.headline.title} · <span style={{ color: GOLD }}>free</span>
            </div>
            {sponsored && <SponsorBadge s={sponsor} />}
            <div className="text-xs" style={{ color: MUTED }}>
              {sponsored && sponsor?.payToPlayTracks?.length
                ? 'Tracks 7–12 are pay to play: 1 sat/sec to the artist + network fee'
                : sponsored
                  ? ''
                  : 'Other tracks: 1 sat/sec to the artist + network fee'}
            </div>
            <div className="mt-2">
              <button
                onClick={playHeadline}
                className="px-5 py-2 text-sm font-bold inline-flex items-center gap-2"
                style={{ background: GOLD, color: '#1a1300', borderRadius: 4 }}
              >
                {headline.playing ? <Pause size={16} /> : <Play size={16} fill="#1a1300" />}
                {headline.playing ? 'Pause' : 'Listen free'}
              </button>
            </div>
          </div>
        </div>
      </StillsBanner>
      <div className="flex flex-col gap-3 px-4 md:px-6 pb-4 md:pb-6">
        {sst && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs" style={{ color: MUTED }}>
              <Stat label="Seconds sponsored" value={String(sst.seconds)} />
              <Stat label="Payments" value={String(sst.payments)} />
              <Stat label="Payments/sec" value={paymentsPerSecond(sst.recent).toFixed(2)} />
              <Stat label="Sponsor" value={sponsor ? sponsorName(sponsor) : 'VexVoid'} />
            </div>
            {sponsor && <PotGauge s={sponsor} wide />}
            {sst.lastTxid && (
              <a
                className="text-[11px] break-all underline-offset-4 hover:underline"
                style={{ color: GOLD }}
                href={`https://whatsonchain.com/tx/${sst.lastTxid}`}
                target="_blank"
                rel="noreferrer"
              >
                Last sponsored payment {sst.lastTxid}
              </a>
            )}
          </div>
        )}
        {notice && (
          <div
            className="flex flex-wrap items-center gap-3 p-3 text-sm"
            style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 4 }}
          >
            <span className="text-white">
              {sponsor ? sponsorName(sponsor) : 'VexVoid'}'s sponsored plays have run out — continue at 1 sat/sec?
            </span>
            <button
              onClick={() => {
                setSheet({ track: notice.track, from: notice.from });
                setNotice(null);
              }}
              className="px-3 py-1.5 text-xs font-bold"
              style={{ background: GOLD, color: '#1a1300', borderRadius: 4 }}
            >
              Continue
            </button>
            <button
              onClick={() => {
                setNotice(null);
                void end();
              }}
              className="text-xs"
              style={{ color: MUTED }}
            >
              Not now
            </button>
          </div>
        )}
        {ask && (
          <div
            className="flex flex-wrap items-center gap-3 p-3 text-sm"
            style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 4 }}
          >
            <span className="text-white">Show me on {artistName}'s listener board?</span>
            <button
              onClick={() => {
                setBoardChoice(artistName, 'yes');
                const pub = ask;
                setAsk(null);
                void claim(pub);
              }}
              className="px-3 py-1.5 text-xs font-bold"
              style={{ background: GOLD, color: '#1a1300', borderRadius: 4 }}
            >
              Yes, show me
            </button>
            <button
              onClick={() => {
                setBoardChoice(artistName, 'no');
                setAsk(null);
              }}
              className="text-xs"
              style={{ color: MUTED }}
            >
              No thanks
            </button>
          </div>
        )}
        {claimNote && (
          <div className="text-xs" style={{ color: MUTED }}>
            {claimNote}
          </div>
        )}
        {st && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs" style={{ color: MUTED }}>
            <Stat label="To the artist" value={`${st.artistSats} sats`} />
            <Stat label="Network fees" value={`${st.feeSats} sats`} />
            <Stat label="Payments" value={String(st.payments)} />
            <Stat label="Payments/sec" value={paymentsPerSecond(st.recent).toFixed(2)} />
            <Stat label="Budget left" value={`${snap?.balance ?? 0} sats`} />
          </div>
        )}
        {st?.lastTxid && (
          <a
            className="text-[11px] break-all underline-offset-4 hover:underline"
            style={{ color: GOLD }}
            href={`https://whatsonchain.com/tx/${st.lastTxid}`}
            target="_blank"
            rel="noreferrer"
          >
            Last payment {st.lastTxid}
          </a>
        )}
        {problem && (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-[#F97066]">Payments stopped: {problem}</span>
            {s && (snap?.status === 'error' || sSnap?.status === 'error') && (
              <button onClick={retry} className="font-bold" style={{ color: GOLD }}>
                Resync and continue
              </button>
            )}
          </div>
        )}
        {returned && (
          <div className="text-xs" style={{ color: MUTED }}>
            {returned}
          </div>
        )}
        {s && (
          <div className="flex gap-2">
            <button
              onClick={() => (s.engine.paused ? s.engine.resume() : s.engine.pause())}
              className="px-4 py-2 text-sm font-bold flex items-center gap-2"
              style={{ background: GOLD, color: '#1a1300', borderRadius: 4 }}
            >
              {playing ? <Pause size={16} /> : <Play size={16} fill="#1a1300" />}
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              onClick={() => void end()}
              className="px-4 py-2 text-sm font-bold flex items-center gap-2"
              style={{ border: `1px solid ${LINE}`, color: MUTED, borderRadius: 4 }}
            >
              <Square size={14} /> {s.payer ? 'Stop and return budget' : 'Stop'}
            </button>
          </div>
        )}
        <div className="flex flex-col" style={{ borderTop: `1px solid ${LINE}` }}>
          <button
            onClick={playHeadline}
            className="flex items-center gap-3 py-2 text-left"
            style={{ borderBottom: `1px solid ${LINE}`, background: 'rgb(var(--bw-accent-hi-rgb) / 0.06)' }}
          >
            <span className="w-6 text-xs text-right" style={{ color: GOLD }}>
              {headline.playing ? '▶' : 1}
            </span>
            <img src={thumb(0)} alt="" className="w-9 h-9 object-cover shrink-0" style={{ borderRadius: 3 }} />
            <span className="flex-1 min-w-0">
              <span className="block text-sm text-white truncate">{HEADLINE_ALBUM.headline.title}</span>
              <span className="block text-[10px] font-bold uppercase tracking-widest" style={{ color: GOLD }}>
                Headline track
              </span>
            </span>
            <span className="text-xs" style={{ color: MUTED }}>
              {headline.duration ? fmt(headline.duration) : ''}
            </span>
            <span
              className="px-2 py-0.5 text-[10px] font-bold uppercase"
              style={{ border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 4 }}
            >
              Free
            </span>
          </button>
          {!m && (
            <div className="py-2 text-xs" style={{ color: MUTED }}>
              {loadError ? 'The other tracks are unavailable right now.' : 'Loading the other tracks…'}
            </div>
          )}
          {m &&
            view!.paid.map(({ index: i, track: t }, row) => (
              <button
                key={t.trackId}
                onClick={() => playAt(i)}
                className="flex items-center gap-3 py-2 text-left"
                style={{ borderBottom: `1px solid ${LINE}` }}
              >
                <span className="w-6 text-xs text-right" style={{ color: track === i ? GOLD : MUTED }}>
                  {track === i && playing ? '▶' : row + 2}
                </span>
                <img
                  src={thumb(row + 1)}
                  alt=""
                  className="w-9 h-9 object-cover shrink-0"
                  style={{ borderRadius: 3 }}
                />
                <span className="flex-1 min-w-0 text-sm text-white truncate">{t.title}</span>
                <span className="text-xs" style={{ color: MUTED }}>
                  {fmt(t.segments * m.segmentSeconds)}
                </span>
                <span className="text-[10px] font-bold uppercase" style={{ color: covered(t.trackId) ? GOLD : MUTED }}>
                  {covered(t.trackId) ? `Sponsored by ${sponsor ? sponsorName(sponsor) : 'VexVoid'}` : '1 sat/sec'}
                </span>
              </button>
            ))}
        </div>
      </div>
      <div className="px-4 md:px-6 pb-4 md:pb-6">
        <ListenerBoard
          albumId={SPONSOR_ALBUM_ID}
          artist={artistName}
          identityKey={identityKey}
          wallet={wallet}
          refresh={boardTick}
        />
      </div>
      {funds && m && (
        <AddFundsSheet
          product={BMUSIC_FUNNEL}
          neededSats={estimateTotal(Math.max(albumSeconds, 60), m.satsPerSegment) + SEGMENT_FEE}
          enoughSats={estimateTotal(60, m.satsPerSegment) + SEGMENT_FEE}
          onFunded={() => {
            const f = funds;
            setFunds(null);
            setSheetRaw(f);
          }}
          onClose={() => {
            if (funds.topUp) void end();
            setFunds(null);
          }}
        />
      )}
      {sheet && m && (
        <BudgetSheet
          albumSeconds={albumSeconds}
          satsPerSecond={m.satsPerSegment}
          topUp={!!sheet.topUp}
          payToPlay={
            sponsored && !!sponsor?.payToPlayTracks?.length ? (sponsor ? sponsorName(sponsor) : 'VexVoid') : null
          }
          busy={busy}
          onCancel={() => {
            setSheet(null);
            if (sheet.topUp) void end();
          }}
          onAllow={(b) => void start(b, sheet.track, sheet.from)}
        />
      )}
    </section>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="p-2" style={{ background: PANEL, borderRadius: 4 }}>
    <div className="text-[10px] uppercase tracking-widest">{label}</div>
    <div className="text-sm font-bold text-white">{value}</div>
  </div>
);

/** One approval before the first play: the most this album can spend. No popups after it. */
function BudgetSheet(p: {
  albumSeconds: number;
  satsPerSecond: number;
  topUp: boolean;
  /** Artist name when some tracks are sponsored and the rest pay to play. */
  payToPlay?: string | null;
  busy: boolean;
  onAllow: (sats: number) => void;
  onCancel: () => void;
}) {
  const options = [
    { label: 'The whole album', seconds: p.albumSeconds },
    { label: '10 minutes', seconds: 600 },
    { label: '1 minute', seconds: 60 },
  ].filter((o) => o.seconds <= p.albumSeconds || o.label === 'The whole album');
  const [pick, setPick] = useState(0);
  const seconds = options[pick].seconds;
  // + one sweep fee so the leftover can always come back.
  const sats = estimateTotal(seconds, p.satsPerSecond) + SEGMENT_FEE;
  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-end md:items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
    >
      <div
        className="w-full max-w-[440px] p-5 flex flex-col gap-4"
        style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8 }}
      >
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: GOLD }}>
            {p.topUp ? 'Budget used up' : 'Listening budget'}
          </div>
          <h3 className="text-xl font-black text-white mt-1">
            Allow up to {sats.toLocaleString()} sats for this album
          </h3>
          {p.payToPlay && (
            <p className="text-sm mt-2 text-white">
              Tracks 7–12 are pay to play: 1 sat/sec to {p.payToPlay} + network fee
            </p>
          )}
          <p className="text-xs mt-2" style={{ color: MUTED }}>
            ≈ {p.satsPerSecond + SEGMENT_FEE} sats per second: {p.satsPerSecond} to the artist + {SEGMENT_FEE} network
            fee (one payment every second). Pause stops paying. Whatever is left comes back to your wallet when you
            stop.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {options.map((o, i) => (
            <button
              key={o.label}
              onClick={() => setPick(i)}
              className="flex justify-between px-3 py-2 text-sm"
              style={{
                borderRadius: 4,
                border: `1px solid ${pick === i ? GOLD : LINE}`,
                color: pick === i ? GOLD : '#fff',
              }}
            >
              <span>{o.label}</span>
              <span>{(estimateTotal(o.seconds, p.satsPerSecond) + SEGMENT_FEE).toLocaleString()} sats</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            disabled={p.busy}
            onClick={() => p.onAllow(sats)}
            className="flex-1 py-2.5 text-sm font-bold"
            style={{ background: GOLD, color: '#1a1300', borderRadius: 4, opacity: p.busy ? 0.6 : 1 }}
          >
            {p.busy ? 'Waiting for the wallet…' : 'Allow and play'}
          </button>
          <button onClick={p.onCancel} className="px-4 py-2.5 text-sm" style={{ color: MUTED }}>
            Not now
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
