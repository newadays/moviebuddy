// Ranking metrics for one list of recommendations, shared by the Worker (the
// live totals in the footer) and scripts/export-feedback.mjs (the full
// report), so both always use the same formulas.
//
// A list is the films in the order they were shown, each with a grade:
//   Just me: 2 = Would watch, 1 = Maybe, 0 = Not for me
//   groups:  1 = voted yes,   0 = voted no
// A film counts as relevant (for MRR and MAP) when its grade reaches
// `relevantAt`: 2 for Just me, 1 for groups.

// 1 / the position of the first relevant film; 0 when none is relevant.
export function reciprocalRank(grades, relevantAt) {
  const at = grades.findIndex((g) => g >= relevantAt);
  return at < 0 ? 0 : 1 / (at + 1);
}

// Average precision over the list: the precision at each relevant film,
// averaged over the relevant films. 0 when none is relevant.
export function averagePrecision(grades, relevantAt) {
  let hits = 0;
  let sum = 0;
  grades.forEach((g, i) => {
    if (g >= relevantAt) {
      hits += 1;
      sum += hits / (i + 1);
    }
  });
  return hits ? sum / hits : 0;
}

// Normalised discounted cumulative gain at k, with graded gains 2^g - 1 and
// the log2(position + 1) discount. The ideal is the same grades, best first.
// 0 when every grade is 0.
export function ndcg(grades, k = grades.length) {
  const dcg = (list) => list.slice(0, k).reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...grades].sort((a, b) => b - a));
  return ideal ? dcg(grades) / ideal : 0;
}

// All three for one fully graded list.
export function scoreList(grades, relevantAt) {
  return {
    rr: reciprocalRank(grades, relevantAt),
    ap: averagePrecision(grades, relevantAt),
    ndcg: ndcg(grades),
  };
}

// Mean of each metric over many lists.
export function summarise(scores) {
  const n = scores.length;
  const mean = (field) => (n ? scores.reduce((sum, s) => sum + s[field], 0) / n : null);
  return { lists: n, mrr: mean('rr'), map: mean('ap'), ndcg: mean('ndcg') };
}
