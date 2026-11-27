// Download every recommendation list shown and its labels, and measure how
// good the recommendations are.
//
//   ADMIN_KEY=... npm run feedback -- https://moviebuddy.workhelio.com
//
// Writes feedback.jsonl, one labelled list per line:
//   Just me: one round, graded 2 (Would watch), 1 (Maybe), 0 (Not for me)
//   groups:  one member's yes (1) / no (0) votes on one round
// and prints MRR, MAP@3 and NDCG@3 for each flow. The formulas are the ones
// the site uses for the footer (src/metrics.js); this recomputes them exactly
// from the raw labels, so it is the number to trust.
import { writeFile } from 'node:fs/promises';
import { scoreList, summarise, ndcg } from '../src/metrics.js';

const site = (process.argv[2] || '').replace(/\/$/, '');
const key = process.env.ADMIN_KEY;
if (!site || !key) {
  console.error('Usage: ADMIN_KEY=... npm run feedback -- https://moviebuddy.workhelio.com');
  process.exit(1);
}

// The Worker returns the records a page at a time; follow the cursor to the end.
const records = [];
let cursor = '';
do {
  const url = `${site}/api/admin/feedback${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${res.status} from ${url}. Is ADMIN_KEY set on the Worker and correct here?`);
  const page = await res.json();
  records.push(...page.records);
  cursor = page.nextCursor;
} while (cursor);

function buildLists(all) {
  // Group the records by round: eval:<party>:<n>[:fb | :v:P<i>]
  const rounds = new Map();
  for (const { key: name, value } of all) {
    const [, party, n, ...rest] = name.split(':');
    const id = `${party}:${n}`;
    if (!rounds.has(id)) rounds.set(id, { id, list: null, fb: null, votes: {} });
    const round = rounds.get(id);
    if (!rest.length) round.list = value;
    else if (rest[0] === 'fb') round.fb = value;
    else if (rest[0] === 'v') round.votes[rest[1]] = value;
  }

  const lists = [];
  for (const round of rounds.values()) {
    if (!round.list) continue;
    const { list } = round;
    const base = { round: round.id, at: list.at, flow: list.flow, kids: list.kids, groupSize: list.groupSize, genres: list.genres };
    if (list.flow === 'taste') {
      const labels = (round.fb && round.fb.labels) || {};
      const grades = list.shown.map((f) => (labels[f.id] ? labels[f.id].grade : null));
      const swaps = (round.fb && round.fb.swaps) || [];
      lists.push({
        ...base,
        who: 'P1',
        films: list.shown.map((f, i) => ({ ...f, grade: grades[i] })),
        grades,
        complete: grades.every((g) => g != null),
        ranked: list.ranked,
        swaps: swaps.map((s) => ({ ...s, grade: labels[s.to] ? labels[s.to].grade : null })),
        clicks: (round.fb && round.fb.clicks) || [],
      });
    } else {
      for (const [who, v] of Object.entries(round.votes)) {
        const grades = list.shown.map((f) => (v.labels[f.id] == null ? null : v.labels[f.id]));
        lists.push({ ...base, who, films: list.shown.map((f, i) => ({ ...f, grade: grades[i] })), grades, complete: grades.every((g) => g != null) });
      }
    }
  }
  return lists;
}

const lists = buildLists(records);
await writeFile('feedback.jsonl', lists.map((l) => JSON.stringify(l)).join('\n') + (lists.length ? '\n' : ''));

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const f3 = (x) => (x == null ? '—' : x.toFixed(3));

function report(name, flow, relevantAt) {
  const all = lists.filter((l) => (flow === 'taste' ? l.flow === 'taste' : l.flow !== 'taste'));
  const done = all.filter((l) => l.complete);
  const shown = summarise(done.map((l) => scoreList(l.grades, relevantAt)));
  console.log(`\n${name}`);
  console.log(`  lists ${all.length}, fully labelled ${done.length}`);
  const grades = done.flatMap((l) => l.grades);
  const levels = flow === 'taste' ? [[2, 'Would watch'], [1, 'Maybe'], [0, 'Not for me']] : [[1, 'yes'], [0, 'no']];
  console.log(`  grades: ${levels.map(([g, label]) => `${label} ${pct(grades.filter((x) => x === g).length, grades.length)}`).join(', ')}`);
  console.log(`  order shown:   MRR ${f3(shown.mrr)}  MAP@3 ${f3(shown.map)}  NDCG@3 ${f3(shown.ndcg)}`);
  if (flow === 'taste' && done.length) {
    // The same three films in the ranker's own order: does Ember's reordering help?
    const byRanker = done.map((l) => [...l.films].sort((a, b) => (a.rank || 99) - (b.rank || 99)).map((f) => f.grade));
    const ranker = byRanker.reduce((sum, g) => sum + ndcg(g), 0) / byRanker.length;
    console.log(`  ranker order:  NDCG@3 ${f3(ranker)}  (the same films sorted by taste score)`);
    const swaps = all.flatMap((l) => l.swaps).filter((s) => s.grade != null);
    console.log(`  swaps graded ${swaps.length}, rated Would watch ${pct(swaps.filter((s) => s.grade === 2).length, swaps.length)}`);
    console.log(`  watch clicks per list ${all.length ? (all.reduce((n, l) => n + l.clicks.length, 0) / all.length).toFixed(2) : '—'}`);
  }
}

console.log(`${records.length} records, ${lists.length} labelled lists. Wrote feedback.jsonl`);
report('Just me (relevant = Would watch)', 'taste', 2);
report('Groups (relevant = yes vote)', 'group', 1);
