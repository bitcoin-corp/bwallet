/** Printable statement (HTML; the user prints it to PDF). No libraries. */
import { bsvString, netOf, totals, usdValue, type HistoryRow, type Range } from './txHistory';
import { assetText } from './historyEvents';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const day = (t: number | null) => (t === null ? '' : new Date(t).toLocaleDateString());

export const statementHtml = (opts: {
  account: string;
  addresses: string[];
  range: Range;
  rows: HistoryRow[];
  opening: number | null;
  closing: number | null;
  now?: number;
  autoPrint?: boolean;
}) => {
  const { account, addresses, range, rows } = opts;
  const t = totals(rows);
  const period =
    range.from === null && range.to === null
      ? 'All time'
      : `${day(range.from) || 'Start'} to ${day(range.to) || day(opts.now ?? Date.now())}`;
  const bal = (s: number | null) => (s === null ? 'n/a' : `${bsvString(s)} BSV`);
  const body = rows
    .map(
      (r) => `<tr>
<td>${esc(new Date(r.time).toLocaleString())}</td>
<td>${esc(r.label)}${r.asset ? `<br><small>${esc(assetText(r.asset))}</small>` : ''}${r.app ? `<br><small>via ${esc(r.app)}</small>` : ''}${r.appNote ? `<br><small>${esc(r.appNote)}</small>` : ''}${r.purpose ? `<br><small>For: ${esc(r.purpose)}</small>` : ''}</td>
<td>${esc(r.category ?? '')}</td>
<td>${esc(r.direction)}</td>
<td class="n">${bsvString(r.amountSats)}</td>
<td class="n">${r.feeSats || ''}</td>
<td class="n">${esc(usdValue(r))}${r.usdRateIsCurrent ? '*' : ''}</td>
<td class="n">${bsvString(netOf(r))}</td>
<td class="m">${esc(r.counterparty)}</td>
<td class="m"><a href="https://whatsonchain.com/tx/${esc(r.txid)}">${esc(r.txid.slice(0, 16))}…</a></td>
</tr>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Statement ${esc(account)}</title>
<style>
body{font:12px/1.4 -apple-system,system-ui,sans-serif;color:#111;background:#fff;margin:24px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#555;margin:0 0 16px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f4f4f4}.n{text-align:right;white-space:nowrap}.m{font-family:ui-monospace,monospace;font-size:10px;word-break:break-all}
.sum{display:grid;grid-template-columns:repeat(3,auto);gap:4px 24px;margin:0 0 16px;max-width:560px}.sum b{font-weight:600}
@media print{body{margin:10mm}a{color:#111;text-decoration:none}}
</style></head><body>
<h1>bWallet statement</h1>
<p class="sub">${esc(account)} · ${esc(period)} · generated ${esc(new Date(opts.now ?? Date.now()).toLocaleString())}</p>
<p class="sub m">${addresses.map(esc).join('<br>')}</p>
<div class="sum">
<span>Opening balance</span><b>${bal(opts.opening)}</b><span></span>
<span>Total in</span><b>${bsvString(t.inSats)} BSV</b><span>${t.count} transactions</span>
<span>Total out</span><b>${bsvString(-t.outSats)} BSV</b><span></span>
<span>Fees</span><b>${bsvString(-t.feeSats)} BSV</b><span></span>
<span>Net</span><b>${bsvString(t.netSats)} BSV</b><span></span>
<span>Closing balance</span><b>${bal(opts.closing)}</b><span></span>
</div>
<table><thead><tr><th>Date</th><th>Label</th><th>Category</th><th>Dir</th><th class="n">Amount BSV</th><th class="n">Fee sats</th><th class="n">USD</th><th class="n">Net BSV</th><th>Counterparty</th><th>Txid</th></tr></thead>
<tbody>
${body || '<tr><td colspan="10">No transactions in this period.</td></tr>'}
</tbody></table>
<p class="sub">* USD at the current rate (no price for that day). Amounts from the Bitcoin SV blockchain via WhatsOnChain. Balances cover the BSV on this account's addresses. Token and NFT types are worked out from the transactions and the wallet's own records; check them before relying on them. Not tax advice.</p>
${opts.autoPrint ? '<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>' : ''}
</body></html>`;
};
