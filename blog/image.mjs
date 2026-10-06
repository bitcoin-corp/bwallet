// Share image (1200×630 PNG) for a blog post, in the style of og/og-blog-0NN.png: gold b, "Blog · NNN",
// title, lede, a number card with the date. SVG rendered by resvg with the bundled Space Grotesk (OFL), so the
// server needs no browser and no system fonts.
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { esc, pad3 } from './lib.mjs';

const dir = path.dirname(new URL(import.meta.url).pathname);
const FONTS = ['SpaceGrotesk-400.ttf', 'SpaceGrotesk-700.ttf'].map((f) => path.join(dir, 'fonts', f));

/** Greedy wrap by character budget (Space Grotesk is close to fixed-width at these sizes). */
export function wrap(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

export function shareSvg({ num, title, lede, dateLabel, postOf }) {
  const n = pad3(num);
  const titleLines = wrap(title, 24, 3);
  const titleSize = [64, 56, 48][titleLines.length - 1];
  const ledeY = 175 + titleLines.length * (titleSize + 8) + 30;
  const ledeLines = wrap(lede, 52, titleLines.length > 2 ? 3 : 4);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="0.82" cy="0.45" r="0.6"><stop offset="0" stop-color="#5a4300"/><stop offset="0.5" stop-color="#1a1400"/><stop offset="1" stop-color="#000"/></radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE58A"/><stop offset="0.55" stop-color="#FFD24D"/><stop offset="1" stop-color="#C98F00"/></linearGradient>
    <mask id="h"><rect width="140" height="140" fill="#fff"/><circle cx="60" cy="72" r="15" fill="#000"/></mask>
  </defs>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <ellipse cx="960" cy="320" rx="230" ry="300" fill="none" stroke="#F5B800" stroke-opacity="0.1" stroke-width="10"/>
  <g transform="translate(62,58) scale(0.72)" fill="url(#gold)" mask="url(#h)"><polygon points="45,12 45,76 27,76 27,30"/><circle cx="60" cy="72" r="33"/></g>
  <text x="140" y="108" font-family="Space Grotesk" font-weight="700" font-size="34" fill="#fff">Blog · <tspan fill="#F5B800">${n}</tspan></text>
  ${titleLines.map((l, i) => `<text x="72" y="${175 + titleSize * 0.6 + i * (titleSize + 8)}" font-family="Space Grotesk" font-weight="700" font-size="${titleSize}" fill="#fff">${esc(l)}</text>`).join('\n  ')}
  ${ledeLines.map((l, i) => `<text x="72" y="${ledeY + i * 34}" font-family="Space Grotesk" font-size="24" fill="#d6d6d2">${esc(l)}</text>`).join('\n  ')}
  <g transform="rotate(3 960 255)">
    <rect x="790" y="120" width="350" height="270" rx="22" fill="#0d0d0f" stroke="#F5B800" stroke-opacity="0.45" stroke-width="2"/>
    <text x="965" y="290" text-anchor="middle" font-family="Space Grotesk" font-weight="700" font-size="150" fill="url(#gold)">${n}</text>
    <text x="965" y="352" text-anchor="middle" font-family="Space Grotesk" font-size="24" fill="#cfcfca">${esc(dateLabel)}</text>
  </g>
  <text x="72" y="575" font-family="Space Grotesk" font-weight="700" font-size="26" fill="#fff">bwalletx.com/blog <tspan font-weight="400" fill="#bdbdb8">· ${esc(postOf ?? `post ${num}`)}</tspan></text>
</svg>`;
}

export function sharePng(opts) {
  const r = new Resvg(shareSvg(opts), {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Space Grotesk' },
    fitTo: { mode: 'width', value: 1200 },
  });
  return r.render().asPng();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  // node blog/image.mjs out.png — sample render
  fs.writeFileSync(process.argv[2] ?? 'sample.png', sharePng({ num: 15, title: 'Push notifications and a nightly blog', lede: 'Your phone now buzzes for DMs and mentions, and this blog gets a short post on any day something ships.', dateLabel: '6 Oct 2026' }));
}
