// bPhone profile validation for the paymail server (docs/BPHONE-PLAN.md). Pure: mirrors the
// shape the wallet's src/mobile/calls/rateCard.ts parses, clipped to the same limits, so a
// malformed or oversized profile never reaches the table. Availability math stays in the wallet.
'use strict';

const PERS = ['second', 'minute', 'hour', 'call'];
const CATEGORIES = ['therapy', 'legal', 'medical', 'finance', 'coaching', 'tech', 'creative', 'other'];
const TOKEN_ID_RE = /^[0-9a-f]{64}_\d+$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const AMOUNT_MAX = 1_000_000;
const TITLE_MAX = 60;
const ABOUT_MAX = 280;
const TZ_RE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

const ADDRESS_RE = /^1[1-9A-HJ-NP-Za-km-z]{24,34}$/;

// The callee's identity-key signature over its payout address (wallet src/mobile/calls/payee.ts signPayee). Kept as
// sent: the caller's wallet checks it against the callee's key and refuses an address without one (b-Aware row 114).
function cleanProof(raw) {
  const r = obj(raw);
  return r &&
    typeof r.timestamp === 'string' &&
    /^\d{1,16}$/.test(r.timestamp) &&
    typeof r.signature === 'string' &&
    /^[0-9a-f]{2,200}$/i.test(r.signature)
    ? { timestamp: r.timestamp, signature: r.signature }
    : undefined;
}

function cleanAsset(raw) {
  const r = obj(raw);
  if (!r) return null;
  // MNEE / token payments go to an address the callee's wallet put here; BSV goes to their paymail.
  const address = typeof r.address === 'string' && ADDRESS_RE.test(r.address) ? r.address : undefined;
  const proof = address ? cleanProof(r.proof) : undefined;
  const at = address ? { address, ...(proof ? { proof } : {}) } : {};
  if (r.kind === 'bsv') return { kind: 'bsv' };
  if (r.kind === 'mnee') return { kind: 'mnee', ...at };
  if (r.kind === 'bsv21' && typeof r.id === 'string' && TOKEN_ID_RE.test(r.id)) {
    const dec = Number.isInteger(r.dec) && r.dec >= 0 && r.dec <= 18 ? r.dec : 0;
    const out = {
      kind: 'bsv21',
      id: r.id,
      sym:
        String(r.sym || 'tokens')
          .trim()
          .slice(0, 16) || 'tokens',
      dec,
    };
    return { ...out, ...at };
  }
  return null;
}

/** The rate card, or null (= free calls) when missing or malformed. */
function cleanRate(raw) {
  const r = obj(raw);
  if (!r) return null;
  const asset = cleanAsset(r.asset);
  if (!asset || !PERS.includes(r.per)) return null;
  const amount = Number(r.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > AMOUNT_MAX) return null;
  const dec = asset.kind === 'bsv21' ? Math.min(asset.dec, 8) : 2;
  return { amount: Math.round(amount * 10 ** dec) / 10 ** dec, per: r.per, asset };
}

function cleanHours(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const w of raw.slice(0, 21)) {
    const r = obj(w);
    if (!r || !Number.isInteger(r.day) || r.day < 0 || r.day > 6) continue;
    if (typeof r.from !== 'string' || typeof r.to !== 'string' || !TIME_RE.test(r.from) || !TIME_RE.test(r.to))
      continue;
    if (minutes(r.from) >= minutes(r.to)) continue;
    out.push({ day: r.day, from: r.from, to: r.to });
  }
  return out.sort((a, b) => a.day - b.day || a.from.localeCompare(b.from));
}

function cleanListing(raw) {
  const r = obj(raw) || {};
  return {
    listed: r.listed === true,
    title: String(r.title || '')
      .trim()
      .slice(0, TITLE_MAX),
    about: String(r.about || '')
      .trim()
      .slice(0, ABOUT_MAX),
    category: CATEGORIES.includes(r.category) ? r.category : 'other',
    hours: cleanHours(r.hours),
    timezone: typeof r.timezone === 'string' && TZ_RE.test(r.timezone) && r.timezone.length <= 64 ? r.timezone : 'UTC',
    booking: r.booking !== false,
  };
}

/** Clean profile to store, or a string saying what is wrong with it. */
function cleanProfile(raw) {
  const r = obj(raw);
  if (!r) return 'profile must be an object';
  const listing = cleanListing(r.listing);
  if (listing.listed && !listing.title) return 'A listing needs a title';
  const out = { v: 1, rate: cleanRate(r.rate), listing, updatedAt: Date.now() };
  // bMail price to reach me (USD, 0–100). Absent = Penny post (1¢).
  const usd = obj(r.mail)?.usd;
  if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 && usd <= 100) out.mail = { usd };
  return out;
}

const BOOKING_MIN = 5;
const BOOKING_MAX = 240;

/** Validate a booking request's fields; returns the clean values or a string. */
function cleanBookingRequest(f, now = Date.now()) {
  const at = Date.parse(String(f.at || ''));
  if (!Number.isFinite(at)) return 'Pick a time';
  if (at < now + 5 * 60_000) return 'Pick a time at least 5 minutes from now';
  if (at > now + 90 * 86_400_000) return 'Bookings go up to 90 days ahead';
  const mins = Number(f.minutes);
  if (!Number.isInteger(mins) || mins < BOOKING_MIN || mins > BOOKING_MAX)
    return `Length must be ${BOOKING_MIN}–${BOOKING_MAX} minutes`;
  return {
    at: new Date(at).toISOString(),
    minutes: mins,
    note: String(f.note || '')
      .trim()
      .slice(0, ABOUT_MAX),
    callerLabel: String(f.callerLabel || '')
      .trim()
      .slice(0, 80),
  };
}

module.exports = { cleanProfile, cleanRate, cleanListing, cleanHours, cleanBookingRequest, CATEGORIES, PERS };
