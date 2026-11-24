// Download the prompt/token trace for the hackathon submission.
//
//   ADMIN_KEY=... node scripts/export-trace.mjs https://your-site.workers.dev
//
// Writes trace.json: every Muse Ember call the site has made, with the full
// prompt, the reply, token counts and cost, plus totals. Rounds are kept for
// 30 days, so run this before the submission deadline.
import { writeFile } from 'node:fs/promises';

const site = (process.argv[2] || '').replace(/\/$/, '');
const key = process.env.ADMIN_KEY;
if (!site || !key) {
  console.error('Usage: ADMIN_KEY=... node scripts/export-trace.mjs https://your-site.workers.dev');
  process.exit(1);
}

// The Worker returns the trace a page at a time; follow the cursor to the end.
async function fetchAll(kind) {
  const rounds = [];
  let cursor = '';
  let last;
  do {
    const url = `${site}/api/admin/trace?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`${res.status} from ${url}. Is ADMIN_KEY set on the Worker and correct here?`);
    last = await res.json();
    rounds.push(...last.rounds);
    cursor = last.nextCursor;
  } while (cursor);
  return { rounds, last };
}

const served = await fetchAll('rounds');
const failed = await fetchAll('failed');
const all = [...served.rounds, ...failed.rounds].sort((a, b) => String(a.at).localeCompare(String(b.at)));

const sum = (field) => all.reduce((total, r) => total + (r[field] || 0), 0);
const totals = {
  roundsServed: served.rounds.length,
  roundsFailed: failed.rounds.length,
  emberCalls: all.reduce((total, r) => total + r.calls.length, 0),
  inputTokens: sum('inputTokens'),
  outputTokens: sum('outputTokens'),
  cachedTokens: sum('cachedTokens'),
  // Estimated at list prices from reported token counts. Meta's Usage page is the bill.
  estimatedCostUsd: Math.round(sum('costUsd') * 1e5) / 1e5,
};

await writeFile('trace.json', JSON.stringify({
  exportedAt: new Date().toISOString(),
  site,
  model: served.last.model,
  pricePerMillionUsd: served.last.pricePerMillionUsd,
  budget: served.last.budget,
  totals,
  rounds: all,
}, null, 2));

console.log('Wrote trace.json');
console.table(totals);
