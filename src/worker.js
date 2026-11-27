import { scoreList } from './metrics.js';

/*
 * Movie Buddy: Cloudflare Worker.
 *
 * An agent, built on Muse Ember, that helps a group of friends agree on a film
 * across the streaming services they have between them. One person is a group
 * of one, so there is a single path for solo and group use.
 *
 *   POST /api/party                  start a group (the host's answers)
 *   GET  /api/party/:id?mid=         the group's current state (polled by the page)
 *   POST /api/party/:id/join         a friend adds their answers
 *   POST /api/party/:id/round        host asks the agent for three films  <- costs a round
 *   POST /api/party/:id/votes        one member's yes/no votes on a round
 *   POST /api/party/:id/replace      Just me: swap one result for the next best match (free)
 *   GET  /api/rate-films?genres=     Just me: well-known films to rate, about ten per genre
 *   POST /api/party/:id/share        Just me: a read-only link to this round's three (free)
 *   POST /api/party/:id/feedback     Just me: Would watch / Maybe / Not for me on one result (free)
 *   GET  /api/share/:id              a shared three, for the page at /s/:id
 *   GET  /api/providers              streaming services, from TMDB
 *   GET  /api/posters                TMDB's popular films: home-page tiles and the waiting screen
 *   GET  /api/wall                   who has used the site lately: first names and places
 *   GET  /api/usage                  this visitor's rounds left today, and the site's budget
 *   POST /api/usage/request          ask for extra rounds (once a day)
 *   GET  /api/admin/trace            every Ember prompt, token count and cost (needs ADMIN_KEY)
 *   GET  /api/admin/feedback         every ranked list shown and its labels (needs ADMIN_KEY)
 *   GET  /api/stats                  Data for Nerds: usage and MRR / MAP / NDCG, site-wide
 *
 * The agent chooses what to search for; the Worker enforces what it may not
 * change. Time limit, kid-safety and the group's services are applied to every
 * search in code, whatever the agent asks for.
 *
 * Protection, in the order a request meets it:
 *   1. same-origin check       only this site's own pages may call the API
 *   2. edge rate limit         optional binding, stops floods
 *   3. per-visitor daily limit ROUNDS_PER_DAY (+ EXTRA_ROUNDS on request)
 *   4. total daily cap         DAILY_ROUND_CAP across everyone, so credits last
 *   5. hard dollar ceiling     BUDGET_USD for the whole site, ever. Past it, Ember is never called.
 *   6. human check             Turnstile, once per visitor per day
 * Ember is only called after all six pass. A visitor's round is only counted
 * when it succeeds, but every dollar Ember costs is counted, success or not.
 */

const TMDB = 'https://api.themoviedb.org/3';
const TMDB_IMAGE = 'https://image.tmdb.org/t/p';
const META_CHAT = 'https://api.meta.ai/v1/chat/completions';
const EMBER_MODEL = 'muse-ember-1.0';
const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const REGION = 'US';

const MAX_MEMBERS = 8;
const MAX_TOOL_STEPS = 3; // tool calls the agent may make before it must answer
const MAX_ROUND_TOKENS = 20000; // ceiling for one round, all Ember calls together
const PARTY_TTL = 60 * 60 * 24 * 2; // groups live two days
const LOG_TTL = 60 * 60 * 24 * 30; // rounds and votes are kept 30 days for evaluation
const EVAL_TTL = 60 * 60 * 24 * 365; // ranked lists and their labels: a year, no names
const TWO_DAYS = 60 * 60 * 24 * 2;

// Muse Ember list prices in US dollars per million tokens. Used only to show
// an estimated cost; Meta's dashboard is the source of truth for billing.
const PRICE_PER_MILLION = { input: 0.10, cachedInput: 0.004, output: 0.50 };

function costUsd(u) {
  const fresh = Math.max(0, u.input - u.cached);
  const usd = (fresh * PRICE_PER_MILLION.input + u.cached * PRICE_PER_MILLION.cachedInput + u.output * PRICE_PER_MILLION.output) / 1e6;
  return Math.round(usd * 1e7) / 1e7;
}

function newTrace(variant) {
  return { variant, steps: [], tokens: 0, input: 0, output: 0, cached: 0, calls: 0, estimated: false, fallback: null, log: [] };
}

// Add one Ember call to the round's running totals, and keep the full prompt
// and reply. That log is the prompt/token trace the hackathon asks for.
function addUsage(trace, r) {
  trace.tokens += r.tokens;
  trace.input += r.input;
  trace.output += r.output;
  trace.cached += r.cached;
  trace.calls += 1;
  if (r.estimated) trace.estimated = true;
  trace.log.push({
    at: new Date().toISOString(),
    model: EMBER_MODEL,
    request: r.request,
    response: r.message,
    inputTokens: r.input,
    outputTokens: r.output,
    cachedTokens: r.cached,
    estimated: r.estimated,
    costUsd: costUsd(r),
  });
}

/*
 * The hard dollar ceiling. Going over the hackathon's $10 means
 * disqualification, and Meta's spend alert only sends an email, so the Worker
 * keeps its own running total and refuses to call Ember once it is reached.
 *
 * The total is an estimate at list prices, which errs high because cached
 * input is cheaper. It only knows about calls this Worker made: anything else
 * spent on the same Meta account (Muse Code, tests with curl) is not in it, so
 * set BUDGET_USD to $10 minus whatever you plan to spend elsewhere.
 */
const SPEND_KEY = 'spend:total';
const ROUND_RESERVE_USD = 0.02; // more than the worst round can cost at the token ceiling

function budgetLimit(env) {
  const n = Number(env.BUDGET_USD);
  return Number.isFinite(n) && n >= 0 ? n : 8;
}

async function readSpend(env) {
  return Number(await env.USAGE.get(SPEND_KEY)) || 0;
}

async function addSpend(env, usd) {
  if (!usd) return;
  // Re-read just before writing, to narrow the window in which two rounds
  // finishing together could overwrite each other. KV has no atomic add; the
  // reserve and the high-side estimate cover what slips through.
  const now = await readSpend(env);
  await env.USAGE.put(SPEND_KEY, String(Math.round((now + usd) * 1e7) / 1e7));
}

async function budgetView(env) {
  const spent = await readSpend(env);
  return { spentUsd: Math.round(spent * 1e5) / 1e5, limitUsd: budgetLimit(env) };
}

// TMDB movie genre ids, by the names the agent uses.
const GENRE_IDS = {
  action: 28, adventure: 12, animation: 16, comedy: 35, crime: 80, documentary: 99,
  drama: 18, family: 10751, fantasy: 14, history: 36, horror: 27, music: 10402,
  mystery: 9648, romance: 10749, 'science fiction': 878, thriller: 53, war: 10752, western: 37,
};
const GENRE_NAMES = Object.fromEntries(Object.entries(GENRE_IDS).map(([name, id]) => [id, name]));

// How many genres each person may pick.
const MAX_GENRES = 3;

// Used only by the fallback pipeline, when the agent fails and nobody picked genres.
const MOOD_GENRES = {
  lighter: ['comedy', 'family', 'animation', 'romance'],
  gripped: ['thriller', 'crime', 'mystery', 'action'],
  moved: ['drama', 'romance', 'history'],
  amazed: ['science fiction', 'fantasy', 'adventure'],
};

// The longest film each "time" answer allows, in minutes. Enforced in code.
const RUNTIME_CAP = { short: 90, medium: 135, long: null };
const TIME_ORDER = ['short', 'medium', 'long'];

const MOOD_TEXT = { lighter: 'lighter: funny, warm, easy', gripped: 'gripped: tense, twisty', moved: 'moved: emotional', amazed: 'amazed: big, strange, spectacular' };
const TIME_TEXT = { short: 'under 90 minutes', medium: 'about 2 hours', long: 'all evening' };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function setting(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function randomId(length) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function cleanName(value, fallback) {
  const name = String(value || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  return name || fallback;
}

/*
 * The wall: a public list of who has used the site lately, shown on the home
 * page as first name and place ("Dana, Austin, US"). Only people who left the
 * "show me" box ticked are on it.
 *
 * What is kept: the first word of the name they typed (letters only), and the
 * city and country Cloudflare works out from the connection. No IP address,
 * and nothing about what they watched. One record, newest first.
 */
const WALL_KEY = 'wall';
const WALL_SIZE = 24;

// The first word of a name, letters only, so the public card cannot carry
// links, numbers or a full name.
function firstName(value) {
  const word = String(value || '').trim().split(/\s+/)[0] || '';
  const letters = (word.match(/[\p{L}'-]/gu) || []).join('').replace(/^['-]+|['-]+$/g, '').slice(0, 16);
  return letters.length >= 2 ? letters : '';
}

// "Austin, US", or just the country when the city is unknown.
function placeOf(request) {
  const cf = request.cf || {};
  const clean = (v) => String(v || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40);
  return [clean(cf.city), clean(cf.country)].filter(Boolean).join(', ');
}

async function readWall(env) {
  return (await env.USAGE.get(WALL_KEY, 'json')) || { people: 0, places: [], recent: [] };
}

async function addToWall(env, request, mid, name) {
  const first = firstName(name);
  if (!first) return;
  const place = placeOf(request);
  const wall = await readWall(env);
  const seenBefore = wall.recent.some((e) => e.mid === mid);
  if (!seenBefore) wall.people += 1;
  if (place && !wall.places.includes(place) && wall.places.length < 500) wall.places.push(place);
  // mid stays on the server; it only stops one person appearing twice.
  wall.recent = [{ mid, name: first, place, at: new Date().toISOString() }, ...wall.recent.filter((e) => e.mid !== mid)].slice(0, WALL_SIZE);
  await env.USAGE.put(WALL_KEY, JSON.stringify(wall));
}

async function handleWall(env) {
  const wall = await readWall(env);
  return json({
    people: wall.people,
    places: wall.places.length,
    recent: wall.recent.map((e) => ({ name: e.name, place: e.place, at: e.at })),
  }, 200, { 'Cache-Control': 'public, max-age=30' });
}

function cleanAnswers(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  return {
    mood: MOOD_TEXT[a.mood] ? a.mood : 'lighter',
    time: TIME_TEXT[a.time] ? a.time : 'medium',
    // Services are TMDB provider ids, taken from GET /api/providers.
    services: (Array.isArray(a.services) ? a.services : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0 && n < 100000)
      .slice(0, 20),
    // Genres this person is in the mood for: up to three, by the agent's names.
    genres: [...new Set((Array.isArray(a.genres) ? a.genres : []).map((g) => String(g).toLowerCase()))]
      .filter((g) => GENRE_IDS[g])
      .slice(0, MAX_GENRES),
  };
}

function firstSentences(text, max) {
  const clean = String(text || '').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = cut.lastIndexOf('. ');
  return stop > 60 ? cut.slice(0, stop + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

// Visitors are counted by IP address, hashed so no raw address is stored.
// People behind one address (a household, an office) share an allowance.
async function visitorKey(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const bytes = new TextEncoder().encode(`${env.VISITOR_SALT || 'movie-buddy'}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { ip, key: `v:${today()}:${hex}` };
}

async function readRecord(env, key) {
  const stored = await env.USAGE.get(key, 'json');
  return stored || { used: 0, extra: 0, requested: false, tokens: 0, cost: 0, human: false, parties: 0 };
}

async function writeRecord(env, key, record) {
  await env.USAGE.put(key, JSON.stringify(record), { expirationTtl: TWO_DAYS });
}

function usageView(env, record) {
  const perDay = setting(env, 'ROUNDS_PER_DAY', 10);
  const limit = perDay + record.extra;
  return {
    perDay,
    extraRounds: setting(env, 'EXTRA_ROUNDS', 5),
    limit,
    used: record.used,
    left: Math.max(0, limit - record.used),
    tokens: record.tokens,
    costUsd: Math.round((record.cost || 0) * 1e7) / 1e7, // estimated, at list prices
    requested: record.requested,
  };
}

// Only this site's own pages may call the API. Browsers send Origin on POST.
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return request.method === 'GET';
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (err) {
    return false;
  }
}

async function isHuman(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true; // not configured: skip (local development)
  if (!token) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  if (ip && ip !== 'local') body.append('remoteip', ip);
  const res = await fetch(TURNSTILE_VERIFY, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

// ---------------------------------------------------------------------------
// TMDB
// ---------------------------------------------------------------------------

async function tmdb(env, path, params = {}, cacheSeconds = 0) {
  const url = new URL(TMDB + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  const init = { headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, Accept: 'application/json' } };
  if (cacheSeconds) init.cf = { cacheTtl: cacheSeconds, cacheEverything: true };
  // TMDB has spells of failing requests at random (a 500 on a film that loads
  // fine a moment later), so a server error or a dropped connection is tried
  // again before giving up.
  for (let attempt = 1; ; attempt += 1) {
    let res = null;
    try { res = await fetch(url, init); } catch (err) { if (attempt >= TMDB_ATTEMPTS) throw err; }
    if (res && res.ok) return res.json();
    if (res && (res.status < 500 || attempt >= TMDB_ATTEMPTS)) throw new Error(`TMDB ${res.status} on ${path}`);
    await new Promise((done) => setTimeout(done, 150 * attempt));
  }
}
const TMDB_ATTEMPTS = 3;

async function providerList(env) {
  const data = await tmdb(env, '/watch/providers/movie', { watch_region: REGION, language: 'en-US' }, 86400);
  return (data.results || [])
    .sort((a, b) => {
      const pa = (a.display_priorities && a.display_priorities[REGION]) ?? a.display_priority ?? 999;
      const pb = (b.display_priorities && b.display_priorities[REGION]) ?? b.display_priority ?? 999;
      return pa - pb;
    })
    .map((p) => ({ provider_id: p.provider_id, provider_name: p.provider_name, logo_path: p.logo_path }));
}

/*
 * The rules a group imposes on every search. The agent cannot loosen these:
 * the shortest time anyone has, kid-safety, and the services the group has.
 */
function groupRules(party) {
  const times = party.members.map((m) => TIME_ORDER.indexOf(m.answers.time));
  const strictest = TIME_ORDER[Math.min(...times)];
  const services = [...new Set(party.members.flatMap((m) => m.answers.services))];
  // Age group. Kids watching: only films rated G or PG in the US, never horror.
  // Adults only: no family films, unless someone asked for the family genre.
  const familyPicked = party.members.some((m) => (m.answers.genres || []).includes('family'));
  return { runtimeCap: RUNTIME_CAP[strictest], time: strictest, kids: !!party.kids, adultsOnly: !party.kids && !familyPicked, services };
}

// TMDB ranks "NR" (not rated) below G, so "PG or lower" would let unrated
// films of any kind through. Kids get exactly G or PG.
const KIDS_CERTIFICATES = 'G|PG';

function ageFilter(params, rules) {
  const without = params.without_genres ? String(params.without_genres).split(',') : [];
  if (rules.kids) {
    params.certification_country = 'US';
    params.certification = KIDS_CERTIFICATES;
    without.push(String(GENRE_IDS.horror));
  }
  if (rules.adultsOnly) without.push(String(GENRE_IDS.family));
  if (without.length) params.without_genres = [...new Set(without)].join(',');
  return params;
}

// Films come from the last few years: searches cover only films released
// since this many years ago, whatever years the agent asks for. When too few
// match, the search first loosens its other filters (popular instead of top
// rated, fewer votes needed) while staying recent, and only as a last resort
// reaches back further, never beyond OLDEST_YEARS. No film older than that
// ever reaches the agent.
const RECENT_YEARS = 5;
const OLDEST_YEARS = 10;
const RECENT_TOP_UP = 6; // fewer matches than this: loosen the search, recent films first

function yearsAgo(years, now = new Date()) {
  const since = new Date(now);
  since.setUTCFullYear(since.getUTCFullYear() - years);
  return since.toISOString().slice(0, 10);
}

// One TMDB search. `wish` is what the agent (or the fallback) asked for;
// `rules` always wins where the two disagree.
async function searchFilms(env, wish, rules, seen) {
  const params = {
    include_adult: 'false',
    include_video: 'false',
    language: 'en-US',
    sort_by: wish.sort === 'top_rated' ? 'vote_average.desc' : 'popularity.desc',
    'vote_count.gte': wish.sort === 'top_rated' ? 1000 : 300,
    page: Math.min(Math.max(Number(wish.page) || 1, 1), 5),
  };

  const genres = (Array.isArray(wish.genres) ? wish.genres : []).map((g) => GENRE_IDS[String(g).toLowerCase()]).filter(Boolean);
  if (genres.length) params.with_genres = genres.join(wish.match_all_genres ? ',' : '|');
  const avoid = (Array.isArray(wish.avoid_genres) ? wish.avoid_genres : []).map((g) => GENRE_IDS[String(g).toLowerCase()]).filter(Boolean);
  if (avoid.length) params.without_genres = avoid.join(',');

  // Runtime: the agent may ask for shorter, never longer than the group allows.
  const wanted = Number(wish.max_minutes) > 0 ? Number(wish.max_minutes) : null;
  const cap = rules.runtimeCap && wanted ? Math.min(rules.runtimeCap, wanted) : (rules.runtimeCap || wanted);
  if (cap) params['with_runtime.lte'] = cap;
  params['with_runtime.gte'] = Number(wish.min_minutes) > 0 ? Math.min(Number(wish.min_minutes), cap || 999) : 60;

  // Years: within the recent window. The agent may narrow it, not widen it.
  const since = yearsAgo(RECENT_YEARS);
  const from = Number(wish.year_from) > 1900 ? `${Math.floor(wish.year_from)}-01-01` : '';
  const to = Number(wish.year_to) > 1900 ? `${Math.floor(wish.year_to)}-12-31` : '';
  const recent = { 'primary_release_date.gte': from > since ? from : since };
  if (to && to >= recent['primary_release_date.gte']) recent['primary_release_date.lte'] = to;

  ageFilter(params, rules);

  // Services: only films on something the group has, unless that finds too
  // little and the caller explicitly widens the search.
  if (rules.services.length && !wish.any_service) {
    params.with_watch_providers = rules.services.join('|');
    params.watch_region = REGION;
    params.with_watch_monetization_types = 'flatrate';
  }

  // Films the group has already voted on are left out. If that empties a page,
  // read on through the next few so a long session never runs dry.
  const fresh = [];
  const collect = async (query) => {
    for (let extra = 0; extra < 4 && fresh.length < 12; extra += 1) {
      const data = await tmdb(env, '/discover/movie', { ...query, page: query.page + extra });
      const results = data.results || [];
      fresh.push(...results.filter((m) => m.poster_path && !seen.has(String(m.id)) && !fresh.some((f) => f.id === m.id)));
      if (!results.length || query.page + extra >= (data.total_pages || 1)) break;
    }
  };
  await collect({ ...params, ...recent });
  // Too few: stay recent but loosen the rest. Strict "top rated" needs 1,000
  // votes, which few recent films have yet.
  const loose = { ...params, sort_by: 'popularity.desc', 'vote_count.gte': 50, page: 1 };
  if (fresh.length < RECENT_TOP_UP) await collect({ ...loose, ...recent });
  // Still too few for three picks: reach back further, but not to the classics.
  if (fresh.length < 3) await collect({ ...loose, 'primary_release_date.gte': yearsAgo(OLDEST_YEARS) });
  return fresh
    .slice(0, 12)
    .map((m) => ({
      id: m.id,
      title: m.title,
      year: (m.release_date || '').slice(0, 4),
      genres: (m.genre_ids || []).map((g) => GENRE_NAMES[g]).filter(Boolean),
      rating: m.vote_average,
      overview: firstSentences(m.overview, 170),
    }));
}

async function filmDetails(env, id) {
  // Everything any part of the site needs about a film, in one cached call:
  // where to watch, the trailer, and for taste matching its keywords, credits
  // and certificate.
  return tmdb(env, `/movie/${id}`, { append_to_response: 'watch/providers,videos,keywords,credits,release_dates', language: 'en-US' }, 3600);
}

// Where a film can be watched, and which members of the group have that service.
function whereToWatch(details, party) {
  const region = details['watch/providers'] && details['watch/providers'].results && details['watch/providers'].results[REGION];
  if (!region) return null;
  const owners = (providerId) => party.members.filter((m) => m.answers.services.includes(providerId)).map((m) => m.mid);
  const included = region.flatrate || [];
  if (included.length) {
    // Every service that carries the film, with the members who have each one.
    // Each viewer is later shown the service that suits them best.
    const options = included
      .map((p) => ({ service: p.provider_name, logo: p.logo_path ? `${TMDB_IMAGE}/w92${p.logo_path}` : '', have: owners(p.provider_id) }))
      .sort((a, b) => b.have.length - a.have.length);
    return { type: 'subscription', options, url: region.link || '' };
  }
  const paid = [...(region.rent || []), ...(region.buy || [])];
  if (paid.length) {
    const names = [...new Set(paid.map((p) => p.provider_name))].slice(0, 2).join(' or ');
    return { type: 'rent', options: [{ service: names, logo: '', have: [] }], url: region.link || '' };
  }
  return null;
}

function shapePick(details, party, extra) {
  const year = (details.release_date || '').slice(0, 4);
  const runtime = details.runtime ? `${Math.floor(details.runtime / 60)}h ${String(details.runtime % 60).padStart(2, '0')}m` : '';
  const genre = details.genres && details.genres[0] ? details.genres[0].name : '';
  const trailer = ((details.videos && details.videos.results) || []).find((v) => v.site === 'YouTube' && v.type === 'Trailer');
  return {
    id: String(details.id),
    title: details.title,
    meta: [year, runtime, genre].filter(Boolean).join(' · '),
    minutes: details.runtime || null,
    poster: details.poster_path ? `${TMDB_IMAGE}/w500${details.poster_path}` : '',
    why: firstSentences(details.overview, 180),
    fits: [],
    byEmber: false,
    watch: whereToWatch(details, party),
    trailerUrl: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : '',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Muse Ember
// ---------------------------------------------------------------------------

async function ember(env, body) {
  const res = await fetch(META_CHAT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.MODEL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBER_MODEL, ...body }),
  });
  if (!res.ok) throw new Error(`Ember ${res.status}`);
  const data = await res.json();
  const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const u = data.usage || {};
  // Real counts when the API reports them; otherwise a rough estimate from
  // text length, flagged so the page can say so.
  const estimated = !(u.prompt_tokens || u.completion_tokens || u.total_tokens);
  const input = u.prompt_tokens || (estimated ? Math.ceil(JSON.stringify(body).length / 4) : 0);
  const output = u.completion_tokens || (estimated ? Math.ceil(JSON.stringify(message).length / 4) : 0);
  // Cached input, if reported the way OpenAI-compatible APIs usually do. Unconfirmed for Meta.
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  // What was sent, for the trace. Tool definitions are named, not repeated.
  const request = {
    messages: body.messages,
    tools: body.tools ? body.tools.map((t) => t.function.name) : undefined,
    structuredOutput: body.response_format ? body.response_format.json_schema.name : undefined,
  };
  return { message, request, tokens: u.total_tokens || input + output, input, output, cached, estimated };
}

// Kept word-for-word identical on every call so it bills at the cached rate.
const AGENT_SYSTEM = [
  'You are Movie Buddy, an agent that helps a group of friends agree on a film to watch tonight.',
  'You are given each person\'s mood, the genres they picked ("any" if none) and how long they have, plus films the group already rejected or liked.',
  'Search with the genres people picked first. In a group, look for films whose genres cover what several people picked; a film should suit each person\'s genres or mood.',
  'Use the search_films tool to find candidates. Think about what would satisfy the whole group, not just one person:',
  'when moods differ, look for films that bridge them, and search again with different genres if the first results are a poor fit.',
  'Use get_film only when you need more detail on a specific candidate.',
  `You may make at most ${MAX_TOOL_STEPS} tool calls. The time limit, child safety and the group's streaming services are applied to every search automatically.`,
  `Searches cover films released in the last ${RECENT_YEARS} years (up to ${OLDEST_YEARS} only when very few match). Always prefer the most recent films that fit; do not pick an older one for variety.`,
  'Set any_service to true only if searches on the group\'s services return too little.',
  'When you have enough candidates, stop calling tools and reply with a short note; you will then be asked for the final answer.',
  'Never choose a film that did not appear in a tool result.',
].join(' ');

const FINAL_INSTRUCTION = [
  'Now give the final answer. Choose exactly three different films from the tool results above, preferring variety.',
  'For each: "id" exactly as returned; "why": one or two plain sentences, at most 30 words, written to the group as "you",',
  'using only facts from the tool results (no invented plot, cast or awards);',
  '"fits": the labels of the people whose mood it suits, for example ["P1","P3"].',
].join(' ');

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_films',
      description: 'Search films on TMDB. Returns up to 12 films with id, title, year, genres, rating and a short overview. Films the group has already seen are left out.',
      parameters: {
        type: 'object',
        properties: {
          genres: { type: 'array', items: { type: 'string', enum: Object.keys(GENRE_IDS) }, description: 'Genres to include.' },
          match_all_genres: { type: 'boolean', description: 'true: a film must have every listed genre. false (default): any of them.' },
          avoid_genres: { type: 'array', items: { type: 'string', enum: Object.keys(GENRE_IDS) } },
          max_minutes: { type: 'integer', description: 'Longest runtime wanted. Cannot exceed the group\'s time limit.' },
          min_minutes: { type: 'integer' },
          year_from: { type: 'integer', description: `Earliest release year. Searches cover only the last ${RECENT_YEARS} years; an earlier year is ignored.` },
          year_to: { type: 'integer', description: 'Latest release year.' },
          sort: { type: 'string', enum: ['popular', 'top_rated'] },
          page: { type: 'integer', description: '1 to 5. Use a later page for less obvious films.' },
          any_service: { type: 'boolean', description: 'true: ignore the group\'s streaming services. Use only when needed.' },
        },
        required: ['genres'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_film',
      description: 'Get one film\'s runtime, full overview and where it streams.',
      parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  },
];

const FINAL_SCHEMA = {
  name: 'Picks',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['picks'],
    properties: {
      picks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'why', 'fits'],
          properties: {
            id: { type: 'integer' },
            why: { type: 'string' },
            fits: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

// What the agent is told about the group. People are labelled P1, P2...:
// names never leave the Worker.
function groupBrief(party, history) {
  return {
    people: party.members.map((m, i) => ({
      label: `P${i + 1}`,
      mood: MOOD_TEXT[m.answers.mood],
      time: TIME_TEXT[m.answers.time],
      genres: (m.answers.genres || []).length ? m.answers.genres : 'any',
    })),
    kids_watching: !!party.kids,
    rejected: history.rejected,
    liked: history.liked,
  };
}

/*
 * The agent loop. Ember decides what to search for; the Worker runs each tool
 * and records every step in a trace. Meta's API only supports tool_choice
 * "auto", so the final answer is a separate call with no tools and a JSON
 * schema: that is how the Worker makes the agent stop and answer.
 */
async function runAgent(env, party, rules, history, seen, trace) {
  const shown = new Map(); // every film a tool returned this round
  const messages = [
    { role: 'system', content: AGENT_SYSTEM },
    { role: 'user', content: JSON.stringify(groupBrief(party, history)) },
  ];

  let toolCalls = 0;
  while (toolCalls < MAX_TOOL_STEPS && trace.tokens < MAX_ROUND_TOKENS) {
    const started = Date.now();
    const reply = await ember(env, { messages, tools: AGENT_TOOLS, tool_choice: 'auto', parallel_tool_calls: false });
    const { message, tokens } = reply;
    addUsage(trace, reply);
    const call = message.tool_calls && message.tool_calls[0];
    if (!call) {
      trace.steps.push({ kind: 'note', tokens, ms: Date.now() - started });
      messages.push({ role: 'assistant', content: message.content || '' });
      break;
    }

    toolCalls += 1;
    let args = {};
    let result;
    let ok = true;
    try {
      args = JSON.parse(call.function.arguments || '{}');
      if (call.function.name === 'search_films') {
        const films = await searchFilms(env, args, rules, seen);
        films.forEach((f) => shown.set(f.id, f));
        result = { films };
      } else if (call.function.name === 'get_film') {
        const d = await filmDetails(env, Math.floor(Number(args.id)));
        const region = d['watch/providers'] && d['watch/providers'].results && d['watch/providers'].results[REGION];
        result = {
          id: d.id,
          title: d.title,
          minutes: d.runtime,
          overview: firstSentences(d.overview, 400),
          streaming: ((region && region.flatrate) || []).map((p) => p.provider_name),
        };
      } else {
        ok = false;
        result = { error: 'unknown tool' };
      }
    } catch (err) {
      ok = false;
      result = { error: 'tool failed' };
    }
    trace.steps.push({
      kind: 'tool',
      tool: call.function.name,
      args,
      ok,
      results: result.films ? result.films.length : undefined,
      tokens,
      ms: Date.now() - started,
    });
    // Meta requires the assistant message with its tool_calls to be sent back.
    messages.push({ role: 'assistant', content: message.content || null, tool_calls: [call] });
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  }

  if (shown.size < 3) throw new Error('agent found too few films');

  const started = Date.now();
  messages.push({ role: 'user', content: FINAL_INSTRUCTION });
  const reply = await ember(env, { messages, response_format: { type: 'json_schema', json_schema: FINAL_SCHEMA } });
  const { message, tokens } = reply;
  addUsage(trace, reply);
  trace.steps.push({ kind: 'final', tokens, ms: Date.now() - started });

  let picks = [];
  try {
    picks = JSON.parse(message.content).picks || [];
  } catch (err) {
    picks = [];
  }
  return { picks, shown };
}

// The tested one-call pipeline. Runs when the agent is switched off or fails.
async function runPipeline(env, party, rules, history, seen, trace) {
  // The mood most people chose decides the genres.
  const counts = {};
  party.members.forEach((m) => { counts[m.answers.mood] = (counts[m.answers.mood] || 0) + 1; });
  const mood = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const page = 1 + (history.rounds % 5);
  // Genres people picked come first, most picked first; otherwise the mood's.
  const picked = {};
  party.members.forEach((m) => (m.answers.genres || []).forEach((g) => { picked[g] = (picked[g] || 0) + 1; }));
  const genres = Object.keys(picked).length
    ? Object.keys(picked).sort((a, b) => picked[b] - picked[a]).slice(0, 4)
    : MOOD_GENRES[mood];

  let films = await searchFilms(env, { genres, page }, rules, seen);
  if (films.length < 3) films = await searchFilms(env, { genres, any_service: true }, rules, seen);
  if (films.length < 3) films = await searchFilms(env, { genres: [], any_service: true }, rules, seen);
  const shown = new Map(films.map((f) => [f.id, f]));
  trace.steps.push({ kind: 'tool', tool: 'search_films', args: { genres, by: 'pipeline' }, ok: true, results: films.length, tokens: 0 });
  if (films.length < 3) return { picks: [], shown };

  let picks = [];
  try {
    const reply = await ember(env, {
      messages: [
        { role: 'system', content: AGENT_SYSTEM },
        { role: 'user', content: JSON.stringify({ ...groupBrief(party, history), films }) },
        { role: 'user', content: FINAL_INSTRUCTION },
      ],
      response_format: { type: 'json_schema', json_schema: FINAL_SCHEMA },
    });
    addUsage(trace, reply);
    trace.steps.push({ kind: 'final', tokens: reply.tokens });
    picks = JSON.parse(reply.message.content).picks || [];
  } catch (err) {
    picks = []; // Ember is down: the popularity order below still gives three films
  }
  return { picks, shown };
}

/*
 * The random picker (the default). The group's genres, or the mood's if
 * nobody picked any, each get one film: a film released in the last
 * RANDOM_YEARS years, drawn at random from TMDB's matching films rather than
 * taken from the top of a list, so the same few hits do not come back every
 * time. All the rules apply (time limit, kids, services) and each film's real
 * running time is checked. Ember then explains to the group why each film
 * suits them; it cannot swap the films for others.
 */
const RANDOM_YEARS = 2;
const RANDOM_PAGES = 10; // draw from the 200 most popular matches, at most
const RANDOM_TRIES = 6; // draws per film before loosening the search

// The genres the round's films are drawn from, in order, each with the
// labels ("P1", "P3") of the people who picked it. Genres two or more people
// share come first, most shared first. Then everyone takes turns: each
// person's first genre, then each person's second, and so on. Who goes first
// moves along by one each round, so no one (the host included) always leads.
// If nobody picked a genre, the genres come from the group's mood.
function groupGenres(party) {
  const owners = {};
  party.members.forEach((m, i) => (m.answers.genres || []).forEach((g) => { (owners[g] = owners[g] || []).push(`P${i + 1}`); }));
  if (!Object.keys(owners).length) {
    const counts = {};
    party.members.forEach((m) => { counts[m.answers.mood] = (counts[m.answers.mood] || 0) + 1; });
    const mood = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    return [...MOOD_GENRES[mood]].sort(() => Math.random() - 0.5).map((genre) => ({ genre, people: [] }));
  }
  const order = Object.keys(owners).filter((g) => owners[g].length > 1).sort((a, b) => owners[b].length - owners[a].length);
  const choosers = party.members.filter((m) => (m.answers.genres || []).length);
  const first = (party.round || 0) % choosers.length;
  const turns = [...choosers.slice(first), ...choosers.slice(0, first)];
  const deepest = Math.max(...turns.map((m) => m.answers.genres.length));
  for (let depth = 0; depth < deepest; depth += 1) {
    turns.forEach((m) => {
      const g = m.answers.genres[depth];
      if (g && !order.includes(g)) order.push(g);
    });
  }
  return order.map((genre) => ({ genre, people: owners[genre] }));
}

const pickAtRandom = (list) => list[Math.floor(Math.random() * list.length)];

// One film at random for one genre. Loosens step by step if nothing fits:
// any streaming service, then the last RECENT_YEARS years, then any genre.
async function randomFilm(env, genre, rules, avoid, trace) {
  const cap = rules.runtimeCap;
  const attempts = [
    { genre, years: RANDOM_YEARS, services: true },
    { genre, years: RANDOM_YEARS, services: false },
    { genre, years: RECENT_YEARS, services: false },
    { genre: null, years: RANDOM_YEARS, services: false },
  ];
  for (const attempt of attempts) {
    const params = {
      include_adult: 'false',
      include_video: 'false',
      language: 'en-US',
      sort_by: 'popularity.desc',
      // Enough votes and a fair rating, so a random draw is still a decent film.
      'vote_count.gte': 50,
      'vote_average.gte': 5.5,
      'primary_release_date.gte': yearsAgo(attempt.years),
      'primary_release_date.lte': new Date().toISOString().slice(0, 10),
      'with_runtime.gte': 60,
    };
    if (attempt.genre) params.with_genres = GENRE_IDS[attempt.genre];
    if (cap) params['with_runtime.lte'] = cap;
    ageFilter(params, rules);
    if (attempt.services && rules.services.length) {
      params.with_watch_providers = rules.services.join('|');
      params.watch_region = REGION;
      params.with_watch_monetization_types = 'flatrate';
    }
    // TMDB sometimes fails on one request: skip it and try the next, rather
    // than losing the whole round.
    const first = await tmdb(env, '/discover/movie', { ...params, page: 1 }).catch(() => null);
    const pages = Math.min((first && first.total_pages) || 0, RANDOM_PAGES);
    if (!pages) continue;
    for (let i = 0; i < RANDOM_TRIES; i += 1) {
      const page = 1 + Math.floor(Math.random() * pages);
      const data = page === 1 ? first : await tmdb(env, '/discover/movie', { ...params, page }).catch(() => null);
      const pool = ((data && data.results) || []).filter((m) => m.poster_path && !avoid.has(String(m.id)));
      if (!pool.length) continue;
      const film = pickAtRandom(pool);
      avoid.add(String(film.id));
      // TMDB's runtime filter is not always right: check the film itself.
      // Some films' detail pages fail at TMDB; a film we can't load is skipped.
      const details = await filmDetails(env, film.id).catch(() => null);
      if (!details) continue;
      if (cap && details.runtime && details.runtime > cap) continue;
      trace.steps.push({ kind: 'tool', tool: 'search_films', args: { genre: attempt.genre || 'any', years: attempt.years, any_service: !attempt.services, page, by: 'random' }, ok: true, results: pool.length, tokens: 0 });
      return {
        id: film.id,
        title: film.title,
        year: (film.release_date || '').slice(0, 4),
        genres: (film.genre_ids || []).map((g) => GENRE_NAMES[g]).filter(Boolean),
        rating: film.vote_average,
        overview: firstSentences(film.overview, 170),
        picked_for: attempt.genre || 'any',
      };
    }
  }
  return null;
}

const RANDOM_SYSTEM = [
  'You are Movie Buddy, an agent that helps a group of friends agree on a film to watch tonight.',
  'You are given each person\'s mood, the genres they picked ("any" if none) and how long they have, whether kids are watching,',
  'and three films chosen for them, each drawn at random from recent films in one genre ("picked_for")',
  'that particular people asked for ("picked_by", empty if the genre came from the group\'s mood).',
  'Recommend each film the way a friend with good taste would: warm, specific and natural.',
  'If kids_watching is true, the audience is a family with children; if false, it is adults only.',
].join(' ');

const RANDOM_INSTRUCTION = [
  'Recommend all three films, in the order given. For each: "id" exactly as given;',
  '"why": one or two natural sentences, at most 30 words, saying what the film is and why it is worth watching tonight,',
  'using only facts from the film details given (no invented plot, cast or awards).',
  'Write in your own words. Never quote the mood or time descriptions or address people by them:',
  'not "You who want something gripped" or "You wanting gripped drama", but for example',
  '"A tense true-crime documentary that will hold everyone\'s attention for an hour and a half."',
  'Do not use the labels P1, P2 in "why".',
  '"fits": the labels of the people whose genres or mood it suits, for example ["P1","P3"]; always include its picked_by.',
].join(' ');

async function runRandomPicker(env, party, rules, history, seen, trace) {
  const slots = groupGenres(party);
  const avoid = new Set(seen);
  const films = [];
  for (let i = 0; i < 3; i += 1) {
    const slot = slots[i % slots.length];
    const film = await randomFilm(env, slot.genre, rules, avoid, trace);
    // A film found only once the genre was dropped is no one's pick.
    if (film) films.push({ ...film, picked_by: film.picked_for === slot.genre ? slot.people : [] });
  }
  const shown = new Map(films.map((f) => [f.id, f]));
  if (films.length < 3) return { picks: [], shown };

  let picks = [];
  try {
    const reply = await ember(env, {
      messages: [
        { role: 'system', content: RANDOM_SYSTEM },
        { role: 'user', content: JSON.stringify({ ...groupBrief(party, history), films }) },
        { role: 'user', content: RANDOM_INSTRUCTION },
      ],
      response_format: { type: 'json_schema', json_schema: FINAL_SCHEMA },
    });
    addUsage(trace, reply);
    trace.steps.push({ kind: 'final', tokens: reply.tokens });
    picks = JSON.parse(reply.message.content).picks || [];
  } catch (err) {
    picks = []; // Ember is down: the films still stand, with TMDB's own descriptions
  }
  // Keep the order the films were drawn in, whatever order Ember answered in.
  const byId = new Map(picks.map((p) => [Number(p && p.id), p]));
  return { picks: films.map((f) => byId.get(f.id)).filter(Boolean), shown };
}

// ---------------------------------------------------------------------------
// Just me: rate films, then recommend from what you liked
// ---------------------------------------------------------------------------
//
// Content-based filtering. The person rates well-known films from the genres
// they picked. Each film is described by its TMDB attributes: genres,
// keywords, director, lead cast and decade. A like adds those attributes'
// weights to a taste profile and a dislike takes them away. Recent films on
// the person's own services are scored against that profile, the best ten
// go to Ember, and Ember chooses the three to show and says why.

const RATE_PER_GENRE = 10; // films to rate fetched per genre: three to rate, the rest for "Haven't seen it"
const RATE_VOTE_STEPS = [2000, 300, 50]; // votes a film to rate needs: well known first, lower for thin genres
const RATE_PAGES = 3; // TMDB's most-voted pages a pool is drawn from
const TASTE_WEIGHTS = { g: 1, k: 1.5, d: 2, c: 1, e: 0.5 }; // genre, keyword, director, cast, decade
const TASTE_DETAILS = 32; // candidates looked at closely (keywords, credits, services): 6 searches + 32 + Ember stays under 50 requests
const TASTE_SHORTLIST = 10; // best matches Ember chooses from
const TASTE_RESERVE = 15; // next best, kept for "Not for me" on a result

const decadeOf = (date) => (/^\d{4}/.test(date || '') ? Math.floor(Number(date.slice(0, 4)) / 10) * 10 : null);

// The film's US certificate (G, PG, PG-13, R...), or '' if it has none.
function usCertificate(details) {
  const us = ((details.release_dates && details.release_dates.results) || []).find((r) => r.iso_3166_1 === 'US');
  const found = ((us && us.release_dates) || []).find((d) => d.certification);
  return found ? found.certification : '';
}

// The attributes taste is measured on.
function filmFeatures(details) {
  const crew = (details.credits && details.credits.crew) || [];
  const cast = (details.credits && details.credits.cast) || [];
  return {
    g: (details.genres ? details.genres.map((g) => g.id) : details.genre_ids || []).slice(0, 8),
    k: ((details.keywords && details.keywords.keywords) || []).map((k) => k.id).slice(0, 12),
    d: crew.filter((p) => p.job === 'Director').map((p) => p.id).slice(0, 2),
    c: cast.slice(0, 3).map((p) => p.id),
    e: decadeOf(details.release_date),
  };
}

function featureKeys(f) {
  const keys = [];
  ['g', 'k', 'd', 'c'].forEach((type) => (f[type] || []).forEach((id) => keys.push(`${type}:${id}`)));
  if (f.e) keys.push(`e:${f.e}`);
  return keys;
}

// Likes add each attribute's weight, dislikes take it away.
function tasteProfile(ratings) {
  const profile = new Map();
  ratings.forEach((r) => {
    const sign = r.rating === 'like' ? 1 : -1;
    featureKeys(r.f).forEach((key) => profile.set(key, (profile.get(key) || 0) + sign * TASTE_WEIGHTS[key[0]]));
  });
  return profile;
}

// How closely a film matches the profile. Dividing by the square root of the
// number of attributes stops films with long keyword lists winning on size.
function tasteScore(profile, f) {
  const keys = featureKeys(f);
  if (!keys.length) return 0;
  return keys.reduce((sum, key) => sum + (profile.get(key) || 0), 0) / Math.sqrt(keys.length);
}

// The liked film that contributes most to a candidate's score: the one
// sharing the most (and the weightiest) attributes with it.
function becauseOf(liked, f) {
  const keys = new Set(featureKeys(f));
  let best = null;
  let bestScore = 0;
  liked.forEach((r) => {
    const shared = featureKeys(r.f).filter((key) => keys.has(key));
    const score = shared.reduce((sum, key) => sum + TASTE_WEIGHTS[key[0]], 0);
    if (score > bestScore) { best = r; bestScore = score; }
  });
  return best;
}

function cleanTaste(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const ints = (list, max) => (Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 1e9).slice(0, max);
  const ratings = (Array.isArray(t.ratings) ? t.ratings : []).slice(0, 60).map((r) => {
    const f = (r && r.f) || {};
    return {
      filmId: Number(r && r.filmId),
      title: String((r && r.title) || '').slice(0, 80),
      genre: GENRE_IDS[r && r.genre] ? r.genre : '',
      rating: r && r.rating === 'like' ? 'like' : 'dislike',
      f: { g: ints(f.g, 8), k: ints(f.k, 12), d: ints(f.d, 2), c: ints(f.c, 3), e: Number.isInteger(f.e) && f.e >= 1900 && f.e < 2100 ? f.e : null },
    };
  }).filter((r) => Number.isInteger(r.filmId) && r.filmId > 0);
  return { ratings, unseen: ints(t.unseen, 300), dismissed: ints(t.dismissed, 100) };
}

// What a film to rate looks like on the page.
function rateCard(details, genre) {
  const runtime = details.runtime ? `${Math.floor(details.runtime / 60)}h ${String(details.runtime % 60).padStart(2, '0')}m` : '';
  return {
    id: details.id,
    title: details.title,
    year: (details.release_date || '').slice(0, 4),
    runtime,
    certification: usCertificate(details),
    poster: details.poster_path ? `${TMDB_IMAGE}/w342${details.poster_path}` : '',
    overview: firstSentences(details.overview, 140),
    genre,
    f: filmFeatures(details),
  };
}

const shuffled = (list) => list.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

// GET /api/rate-films?genres=thriller,comedy&exclude=1,2
// About ten well-known films per genre, no film in two genres, genres in the
// order given. Free: it does not use a round.
async function handleRateFilms(env, url) {
  const genres = [...new Set(String(url.searchParams.get('genres') || '').split(',').map((g) => g.trim().toLowerCase()))]
    .filter((g) => GENRE_IDS[g]).slice(0, MAX_GENRES);
  if (!genres.length) return json({ error: 'bad-request' }, 400);
  // Kids watching: only films rated G or PG to rate, never horror.
  const kids = url.searchParams.get('kids') === '1';
  const used = new Set(String(url.searchParams.get('exclude') || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 300));

  const picked = [];
  for (const genre of genres) {
    const found = [];
    const take = (data) => shuffled(((data && data.results) || []).filter((m) => m.poster_path && !used.has(m.id))).forEach((m) => {
      if (found.length < RATE_PER_GENRE && !used.has(m.id)) { used.add(m.id); found.push(m); }
    });
    // The best-known films first. Some genres (documentary, western) have
    // few films with that many votes, so the bar is lowered until the genre
    // has enough. Then pages are read from a random start, moving on past
    // films already shown. At most five searches a genre.
    const search = (votes, page) => tmdb(env, '/discover/movie', ageFilter({
      with_genres: GENRE_IDS[genre], sort_by: 'vote_count.desc', 'vote_count.gte': votes,
      include_adult: 'false', include_video: 'false', language: 'en-US', page,
    }, { kids }), 86400).catch(() => null);
    let calls = 0;
    let votes = RATE_VOTE_STEPS[0];
    let first = null;
    for (const step of RATE_VOTE_STEPS) {
      votes = step;
      first = await search(step, 1);
      calls += 1;
      if (((first && first.total_results) || 0) >= 60) break;
    }
    const pages = Math.min((first && first.total_pages) || 0, 10);
    let page = pages > 1 ? 1 + Math.floor(Math.random() * Math.min(pages, RATE_PAGES)) : 1;
    for (let tried = 0; tried < pages && found.length < RATE_PER_GENRE && calls < 5; tried += 1) {
      take(page === 1 ? first : (calls += 1, await search(votes, page)));
      page = (page % pages) + 1;
    }
    found.forEach((m) => picked.push({ genre, m }));
  }

  // Runtime, certificate, keywords and credits for each film. A film whose
  // details fail still shows, from the search result alone.
  const cards = await Promise.all(picked.map(async ({ genre, m }) => {
    const details = await filmDetails(env, m.id).catch(() => null);
    return rateCard(details || m, genre);
  }));
  const films = Object.fromEntries(genres.map((g) => [g, cards.filter((c) => c.genre === g)]));
  return json({ films }, 200, { 'Cache-Control': 'no-store' });
}

// One solo person's rules: services and age group. Time is not asked any more.
function tasteRules(party) {
  return { ...groupRules(party), runtimeCap: null, time: 'any' };
}

// Pick the best films in order while keeping variety: no more than two from
// one genre when two or more genres were picked.
function takeVaried(ranked, count, genreCount, already = []) {
  const cap = genreCount >= 2 ? 2 : Infinity;
  const out = [];
  const tally = {};
  already.forEach((c) => { tally[c.genre] = (tally[c.genre] || 0) + 1; });
  for (const c of ranked) {
    if (out.length === count) break;
    if ((tally[c.genre] || 0) >= cap) continue;
    tally[c.genre] = (tally[c.genre] || 0) + 1;
    out.push(c);
  }
  return out;
}

const TASTE_SYSTEM = [
  'You are Movie Buddy, an agent that recommends films to one person from films they told you they liked and did not like.',
  'You are given those films, whether kids are watching, and a shortlist of recent films on their own streaming services.',
  'Each shortlisted film has a match score (higher is closer to their taste) and the liked film it is most like ("because_you_liked").',
  'Recommend the way a friend with good taste would: warm, specific and natural.',
].join(' ');

const TASTE_INSTRUCTION = [
  'Choose the three films from the shortlist this person is most likely to enjoy tonight.',
  'Favour higher match scores, but choose three that differ from each other rather than three of the same kind.',
  'For each: "id" exactly as given; "why": one natural sentence, at most 25 words, saying what the film is and why it suits them,',
  'using only facts from the details given (no invented plot, cast or awards), and never mentioning the match score;',
  '"fits": an empty list.',
].join(' ');

/*
 * The taste round. Returns up to three picks (fewer only when fewer films
 * match), the reserve for replacing one, and what Ember was told.
 */
async function runTastePicker(env, party, rules, taste, seen, trace) {
  const me = party.members[0];
  const genres = (me.answers.genres || []).length ? me.answers.genres : [...new Set(taste.ratings.map((r) => r.genre).filter(Boolean))];
  const liked = taste.ratings.filter((r) => r.rating === 'like');
  const profile = tasteProfile(taste.ratings);
  const exclude = new Set([...taste.ratings.map((r) => r.filmId), ...taste.unseen, ...taste.dismissed, ...[...seen].map(Number)]);

  // 1. Candidates: recent films in each picked genre on the person's services.
  const found = new Map();
  for (const genre of genres) {
    for (let page = 1; page <= 2; page += 1) {
      const params = ageFilter({
        with_genres: GENRE_IDS[genre], sort_by: 'popularity.desc', 'vote_count.gte': 50, 'vote_average.gte': 5.5,
        'primary_release_date.gte': yearsAgo(RECENT_YEARS), 'primary_release_date.lte': new Date().toISOString().slice(0, 10),
        include_adult: 'false', include_video: 'false', language: 'en-US', page,
      }, rules);
      if (rules.services.length) {
        params.with_watch_providers = rules.services.join('|');
        params.watch_region = REGION;
        params.with_watch_monetization_types = 'flatrate';
      }
      const data = await tmdb(env, '/discover/movie', params, 3600).catch(() => null);
      const results = (data && data.results) || [];
      trace.steps.push({ kind: 'tool', tool: 'search_films', args: { genre, page, by: 'taste' }, ok: !!data, results: results.length, tokens: 0 });
      results.forEach((m) => { if (m.poster_path && !exclude.has(m.id) && !found.has(m.id)) found.set(m.id, { m, genre }); });
      if (!data || page >= (data.total_pages || 0)) break;
    }
  }

  // 2. A quick score from what the search returned, to choose which to look at closely.
  const popularity = (m) => Math.log10(1 + (m.vote_count || 0)) * 0.1;
  // The closer look is shared between the genres in turn, so every picked
  // genre has candidates for the variety rule to draw on.
  const byGenre = genres.map((g) => [...found.values()].filter((c) => c.genre === g)
    .map((c) => ({ ...c, quick: (liked.length ? tasteScore(profile, filmFeatures(c.m)) : 0) + popularity(c.m) }))
    .sort((a, b) => b.quick - a.quick));
  const quick = [];
  for (let i = 0; quick.length < TASTE_DETAILS && byGenre.some((list) => i < list.length); i += 1) {
    byGenre.forEach((list) => { if (list[i] && quick.length < TASTE_DETAILS) quick.push(list[i]); });
  }

  // 3. Full details, the services and age checks, and the real score.
  const detailed = await Promise.all(quick.map(async (c) => ({ ...c, details: await filmDetails(env, c.m.id).catch(() => null) })));
  const ranked = [];
  detailed.forEach(({ m, genre, details }) => {
    if (!details) return;
    const region = details['watch/providers'] && details['watch/providers'].results && details['watch/providers'].results[REGION];
    const flatrate = (region && region.flatrate) || [];
    if (rules.services.length && !flatrate.some((p) => rules.services.includes(p.provider_id))) return; // not on their services
    if (rules.kids && !['G', 'PG'].includes(usCertificate(details))) return;
    if (rules.adultsOnly && (details.genres || []).some((g) => g.id === GENRE_IDS.family)) return;
    const f = filmFeatures(details);
    const because = liked.length ? becauseOf(liked, f) : null;
    ranked.push({
      id: m.id, genre, details, f,
      score: liked.length ? tasteScore(profile, f) + popularity(m) : popularity(m) + (m.popularity || 0) / 1000,
      becauseId: because ? because.filmId : null,
      becauseTitle: because ? because.title : '',
      popularIn: liked.length ? '' : genre,
    });
  });
  ranked.sort((a, b) => b.score - a.score);
  ranked.forEach((c, i) => { c.rank = i + 1; }); // the ranker's own order, kept for evaluation
  if (!ranked.length) return { picks: [], reserve: [], fromEmber: 0, invented: 0, rankedIds: [] };

  // 4. Ember chooses three from the ten best matches.
  const shortlist = ranked.slice(0, TASTE_SHORTLIST);
  const byId = new Map(ranked.map((c) => [c.id, c]));
  let chosen = [];
  let invented = 0;
  try {
    const brief = {
      liked: liked.map((r) => r.title).filter(Boolean),
      not_for_me: taste.ratings.filter((r) => r.rating === 'dislike').map((r) => r.title).filter(Boolean),
      kids_watching: rules.kids,
      shortlist: shortlist.map((c) => ({
        id: c.id,
        title: c.details.title,
        year: (c.details.release_date || '').slice(0, 4),
        genres: (c.details.genres || []).map((g) => g.name),
        overview: firstSentences(c.details.overview, 200),
        match: Math.round(c.score * 100) / 100,
        because_you_liked: c.becauseTitle || null,
      })),
    };
    const reply = await ember(env, {
      messages: [
        { role: 'system', content: TASTE_SYSTEM },
        { role: 'user', content: JSON.stringify(brief) },
        { role: 'user', content: TASTE_INSTRUCTION },
      ],
      response_format: { type: 'json_schema', json_schema: FINAL_SCHEMA },
    });
    addUsage(trace, reply);
    trace.steps.push({ kind: 'final', tokens: reply.tokens });
    const answer = JSON.parse(reply.message.content).picks || [];
    const allowed = new Set(shortlist.map((c) => c.id));
    for (const p of answer) {
      const id = Number(p && p.id);
      if (!allowed.has(id)) { invented += 1; continue; }
      const why = typeof p.why === 'string' ? p.why.trim().slice(0, 240) : '';
      if (!why || chosen.some((c) => c.id === id)) continue;
      chosen.push({ ...byId.get(id), why });
    }
    // Ember's choices still follow the variety rule.
    chosen = takeVaried(chosen, 3, genres.length);
  } catch (err) {
    console.error(`taste picker: Ember failed: ${err.message}`);
    trace.fallback = String(err.message).slice(0, 80);
    chosen = [];
  }
  const fromEmber = chosen.length;
  // Fewer than three from Ember: top up with the best matches.
  const rest = ranked.filter((c) => !chosen.some((x) => x.id === c.id));
  chosen = [...chosen, ...takeVaried(rest, 3 - chosen.length, genres.length, chosen)];
  // Variety gives way rather than show fewer than three.
  if (chosen.length < 3) chosen = [...chosen, ...ranked.filter((c) => !chosen.some((x) => x.id === c.id)).slice(0, 3 - chosen.length)];
  const reserve = ranked.filter((c) => !chosen.some((x) => x.id === c.id)).slice(0, TASTE_RESERVE)
    .map((c) => ({ id: c.id, genre: c.genre, becauseId: c.becauseId, becauseTitle: c.becauseTitle, popularIn: c.popularIn, rank: c.rank, score: c.score }));
  return { picks: chosen, reserve, fromEmber, invented, rankedIds: ranked.slice(0, TASTE_SHORTLIST).map((c) => c.id) };
}

// The extra fields a taste pick carries for the results card.
function tasteExtra(c, details, rules) {
  const region = details['watch/providers'] && details['watch/providers'].results && details['watch/providers'].results[REGION];
  const flatrate = (region && region.flatrate) || [];
  const own = flatrate.find((p) => rules.services.includes(p.provider_id)) || flatrate[0];
  return {
    becauseId: c.becauseId ? String(c.becauseId) : '',
    becauseTitle: c.becauseTitle || '',
    popularIn: c.popularIn || '',
    primaryGenre: c.genre,
    backdrop: details.backdrop_path ? `${TMDB_IMAGE}/w780${details.backdrop_path}` : '',
    service: own ? { name: own.provider_name, logo: own.logo_path ? `${TMDB_IMAGE}/w92${own.logo_path}` : '' } : null,
    watchUrl: (region && region.link) || '',
    certification: usCertificate(details),
  };
}

// Never trust model output blindly: keep only films a tool actually returned,
// and top up from the search results if fewer than three survive.
function validatePicks(emberPicks, shown, labels) {
  const chosen = [];
  let invented = 0;
  for (const p of emberPicks) {
    const id = Number(p && p.id);
    if (!shown.has(id)) { invented += 1; continue; }
    if (chosen.some((c) => c.id === id)) continue;
    const why = typeof p.why === 'string' ? p.why.trim().slice(0, 240) : '';
    const fits = Array.isArray(p.fits) ? [...new Set(p.fits.filter((f) => labels.includes(f)))] : [];
    if (why) chosen.push({ id, why, fits });
    if (chosen.length === 3) break;
  }
  const fromEmber = chosen.length;
  for (const film of shown.values()) {
    if (chosen.length === 3) break;
    if (!chosen.some((c) => c.id === film.id)) chosen.push({ id: film.id, why: '', fits: [] });
  }
  return { chosen, fromEmber, invented };
}

/*
 * Did the agent follow its instructions? Each check is plain code run on the
 * trace, on every round. Stored with the round so pass rates can be compared
 * between versions.
 */
function instructionChecks(trace, validation, picks, rules) {
  const tools = trace.steps.filter((s) => s.kind === 'tool');
  const words = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;
  const checks = {
    searched_before_answering: tools.some((s) => s.tool === 'search_films' && s.ok),
    within_step_limit: tools.length <= MAX_TOOL_STEPS,
    tool_calls_valid: tools.every((s) => s.ok),
    no_invented_films: validation.invented === 0,
    three_picks_from_ember: validation.fromEmber === 3,
    reasons_short: picks.filter((p) => p.byEmber).every((p) => words(p.why) <= 30),
    within_time_limit: picks.every((p) => !rules.runtimeCap || !p.minutes || p.minutes <= rules.runtimeCap),
    within_token_ceiling: trace.tokens <= MAX_ROUND_TOKENS,
  };
  return { ...checks, all_passed: Object.values(checks).every(Boolean) };
}

// ---------------------------------------------------------------------------
// Groups ("parties")
// ---------------------------------------------------------------------------

const partyKey = (id) => `p:${id}`;
const roundKey = (id, n) => `p:${id}:r:${n}`;
const votesKey = (id, n, mid) => `p:${id}:r:${n}:v:${mid}`;
const validId = (value, length) => typeof value === 'string' && new RegExp(`^[a-z0-9]{${length}}$`).test(value);

async function loadParty(env, id) {
  return validId(id, 10) ? env.USAGE.get(partyKey(id), 'json') : null;
}

async function saveParty(env, party) {
  await env.USAGE.put(partyKey(party.id), JSON.stringify(party), { expirationTtl: PARTY_TTL });
}

// Everything the group voted on so far: what to skip and what Ember should know.
async function partyHistory(env, party) {
  const seen = new Set();
  const rejected = [];
  const liked = [];
  for (let n = 1; n <= party.round; n += 1) {
    const round = await env.USAGE.get(roundKey(party.id, n), 'json');
    if (!round) continue;
    const titles = Object.fromEntries(round.picks.map((p) => [p.id, p.title]));
    round.picks.forEach((p) => seen.add(p.id));
    const all = await Promise.all(party.members.map((m) => env.USAGE.get(votesKey(party.id, n, m.mid), 'json')));
    all.filter(Boolean).forEach((entry) => entry.votes.forEach((v) => {
      if (!titles[v.id]) return;
      if (v.vote === 'yes') liked.push(titles[v.id]);
      else rejected.push({ title: titles[v.id], reason: v.reason || '' });
    }));
  }
  return { seen, rejected: rejected.slice(-15), liked: [...new Set(liked)].slice(-10), rounds: party.round };
}

// One viewer's line on where to watch: a service they have themselves if
// there is one, otherwise the one most of the group has.
function watchFor(watch, mid, names) {
  const option = watch.options.find((o) => o.have.includes(mid)) || watch.options[0];
  return {
    type: watch.type,
    service: option.service,
    logo: option.logo,
    youHave: option.have.includes(mid),
    haveNames: option.have.filter((m) => m !== mid).map((m) => names[m]).filter(Boolean),
    url: watch.url,
  };
}

// What one member is allowed to see of the group right now.
async function partyState(env, party, mid) {
  const me = party.members.find((m) => m.mid === mid);
  if (!me) {
    // Not a member yet: just enough to show the join screen.
    const host = party.members.find((m) => m.mid === party.hostMid);
    return { id: party.id, joined: false, hostName: host ? host.name : '', kids: !!party.kids, memberCount: party.members.length, full: party.members.length >= MAX_MEMBERS, started: party.round > 0 };
  }

  const names = Object.fromEntries(party.members.map((m) => [m.mid, m.name]));
  const state = {
    id: party.id,
    joined: true,
    isHost: mid === party.hostMid,
    solo: party.members.length === 1,
    justMe: party.solo === true, // the rate-to-recommend flow
    round: party.round,
    members: party.members.map((m) => ({ name: m.name, isYou: m.mid === mid, isHost: m.mid === party.hostMid, voted: false })),
    picks: [],
    yourVotes: null,
    allVoted: false,
    results: null,
  };
  if (!party.round) return state;

  const round = await env.USAGE.get(roundKey(party.id, party.round), 'json');
  if (!round) return state;
  // Only people who were in the group when the round started take part in it.
  const voters = party.members.filter((m) => round.memberMids.includes(m.mid));
  const all = await Promise.all(voters.map((m) => env.USAGE.get(votesKey(party.id, party.round, m.mid), 'json')));
  const byMid = Object.fromEntries(voters.map((m, i) => [m.mid, all[i]]));

  state.members.forEach((m, i) => { m.voted = !!byMid[party.members[i].mid]; m.inRound = round.memberMids.includes(party.members[i].mid); });
  state.inRound = round.memberMids.includes(mid);
  // What this round cost, shown to everyone in the group.
  const t = round.trace || {};
  state.cost = {
    usd: t.costUsd || 0,
    tokens: t.tokens || 0,
    calls: t.calls || 0,
    searches: (t.steps || []).filter((s) => s.kind === 'tool' && s.tool === 'search_films').length,
    estimated: !!t.estimated,
    agent: t.variant === 'agent' && !t.fallback,
    random: t.variant === 'random',
    taste: t.variant === 'taste',
  };
  state.yourVotes = byMid[mid] ? byMid[mid].votes : null;
  state.allVoted = voters.every((m) => byMid[m.mid]);
  state.picks = round.picks.map((p) => ({
    ...p,
    fitsNames: p.fits.map((m) => (m === mid ? 'you' : names[m])).filter(Boolean),
    // Whose genre the film was drawn for, "you" first.
    pickedByNames: [...(p.pickedBy || [])].sort((a, b) => (b === mid) - (a === mid)).map((m) => (m === mid ? 'you' : names[m])).filter(Boolean),
    pickedBy: undefined,
    watch: p.watch && watchFor(p.watch, mid, names),
    fits: undefined,
  }));

  // Other people's votes are revealed only once you have voted yourself.
  if (state.yourVotes || !state.inRound) {
    state.results = round.picks.map((p) => {
      const yes = voters.filter((m) => byMid[m.mid] && byMid[m.mid].votes.some((v) => v.id === p.id && v.vote === 'yes'));
      return { id: p.id, yes: yes.length, of: voters.length, everyone: state.allVoted && yes.length === voters.length };
    });
  }
  return state;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleCreateParty(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !validId(body.mid, 16)) return json({ error: 'bad-request' }, 400);

  // A light cap so nobody can fill storage with empty groups.
  const { key } = await visitorKey(request, env);
  const record = await readRecord(env, key);
  if ((record.parties || 0) >= 30) return json({ error: 'slow-down' }, 429);
  record.parties = (record.parties || 0) + 1;

  const party = {
    id: randomId(10),
    createdAt: new Date().toISOString(),
    hostMid: body.mid,
    kids: body.kids === true,
    // "Just me": nobody else can join, and rounds come from the films rated.
    solo: body.solo === true,
    round: 0,
    members: [{ mid: body.mid, name: cleanName(body.name, 'Host'), answers: cleanAnswers(body.answers) }],
  };
  await Promise.all([
    saveParty(env, party),
    writeRecord(env, key, record),
    body.showOnWall === true ? addToWall(env, request, body.mid, body.name) : null,
  ]);
  return json({ party: await partyState(env, party, body.mid) });
}

async function handleGetParty(env, id, mid) {
  const party = await loadParty(env, id);
  if (!party) return json({ error: 'not-found' }, 404);
  return json({ party: await partyState(env, party, mid) });
}

async function handleJoin(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !validId(body.mid, 16)) return json({ error: 'bad-request' }, 400);
  const party = await loadParty(env, id);
  if (!party) return json({ error: 'not-found' }, 404);

  const existing = party.members.find((m) => m.mid === body.mid);
  if (party.solo && !existing) return json({ error: 'full' }, 409);
  if (existing) {
    existing.answers = cleanAnswers(body.answers);
    existing.name = cleanName(body.name, existing.name);
  } else {
    if (party.members.length >= MAX_MEMBERS) return json({ error: 'full' }, 409);
    party.members.push({ mid: body.mid, name: cleanName(body.name, `Guest ${party.members.length}`), answers: cleanAnswers(body.answers) });
  }
  await Promise.all([
    saveParty(env, party),
    body.showOnWall === true ? addToWall(env, request, body.mid, body.name) : null,
  ]);
  return json({ party: await partyState(env, party, body.mid) });
}

async function handleRound(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'bad-request' }, 400);
  const party = await loadParty(env, id);
  if (!party) return json({ error: 'not-found' }, 404);
  if (body.mid !== party.hostMid) return json({ error: 'host-only' }, 403);

  const { ip, key } = await visitorKey(request, env);
  const record = await readRecord(env, key);

  // 3. per-visitor limit (a group round is charged to the host)
  if (usageView(env, record).left < 1) return json({ error: 'limit', usage: usageView(env, record) }, 429);

  // 4. total daily cap
  const globalKey = `g:${today()}`;
  const globalUsed = Number(await env.USAGE.get(globalKey)) || 0;
  if (globalUsed >= setting(env, 'DAILY_ROUND_CAP', 400)) return json({ error: 'busy', usage: usageView(env, record) }, 429);

  // 5. hard dollar ceiling for the whole site
  if ((await readSpend(env)) + ROUND_RESERVE_USD >= budgetLimit(env)) {
    return json({ error: 'budget', usage: usageView(env, record), budget: await budgetView(env) }, 429);
  }

  // 6. human check, once per visitor per day
  if (!record.human) {
    if (!(await isHuman(env, body.turnstileToken, ip))) return json({ error: 'human-check' }, 403);
    record.human = true;
  }

  // Just me, with films rated: the taste round.
  if (party.solo && body.taste) return tasteRound(env, party, cleanTaste(body.taste), { body, key, record, globalKey, globalUsed });

  const rules = groupRules(party);
  const history = await partyHistory(env, party);
  const labels = party.members.map((_, i) => `P${i + 1}`);

  // PICKER "random" (the default): three random recent films from the
  // group's genres, explained by Ember. PICKER "agent": the search agent,
  // with the pipeline as its safety net. The trace is filled in as the round
  // runs, so a failed attempt still shows its steps and the tokens it spent.
  const randomOn = (env.PICKER || 'random') === 'random';
  const agentOn = !randomOn && env.AGENT !== 'off';
  const trace = newTrace(randomOn ? 'random' : agentOn ? 'agent' : 'pipeline');
  let outcome = null;
  try {
    if (randomOn) {
      outcome = await runRandomPicker(env, party, rules, history, history.seen, trace);
    } else if (agentOn) {
      try {
        outcome = await runAgent(env, party, rules, history, history.seen, trace);
      } catch (err) {
        console.error(`agent failed: ${err.message}`);
        trace.fallback = String(err.message).slice(0, 80);
      }
    }
    if (!randomOn && (!outcome || validatePicks(outcome.picks, outcome.shown, labels).fromEmber === 0)) {
      if (agentOn && !trace.fallback) trace.fallback = 'agent returned no usable picks';
      outcome = await runPipeline(env, party, rules, history, history.seen, trace);
    }
  } catch (err) {
    await recordFailedRound(env, trace, 'error'); // money already spent still counts
    throw err;
  }
  if (outcome.shown.size < 3) {
    await recordFailedRound(env, trace, 'no-matches');
    return json({ error: 'no-matches', usage: usageView(env, record) }, 404);
  }

  const validation = validatePicks(outcome.picks, outcome.shown, labels);
  const labelToMid = Object.fromEntries(party.members.map((m, i) => [`P${i + 1}`, m.mid]));
  const picks = await Promise.all(validation.chosen.map(async (c) => shapePick(
    await filmDetails(env, c.id),
    party,
    {
      ...(c.why ? { why: c.why, fits: c.fits.map((label) => labelToMid[label]), byEmber: true } : {}),
      // The random picker says which of the group's genres each film was drawn for.
      ...(outcome.shown.get(c.id) && outcome.shown.get(c.id).picked_for ? {
        pickedFor: outcome.shown.get(c.id).picked_for,
        pickedBy: (outcome.shown.get(c.id).picked_by || []).map((label) => labelToMid[label]).filter(Boolean),
      } : {}),
    },
  )));

  trace.checks = instructionChecks(trace, validation, picks, rules);
  return saveRound(env, party, picks, trace, { time: rules.time, kids: rules.kids, services: rules.services.length }, {}, { body, key, record, globalKey, globalUsed });
}

// Count a round that succeeded and keep its record. The round record doubles
// as the evaluation log: picks, the trace and the checks, kept 30 days.
async function saveRound(env, party, picks, trace, ruleSummary, extraRecord, { body, key, record, globalKey, globalUsed, ranking }) {
  trace.costUsd = costUsd(trace);
  const n = party.round + 1;
  party.round = n;
  record.used += 1;
  record.tokens += trace.tokens;
  record.cost = (record.cost || 0) + trace.costUsd;

  const flow = ruleSummary.taste ? 'taste' : 'group';
  // Counted before the round is written, so a first-ever read of the totals
  // (which counts the rounds already kept) does not count this one twice.
  await bumpStats(env, (s) => { s.rounds[flow] += 1; s.recs[flow].lists += 1; });

  await Promise.all([
    env.USAGE.put(evalKey(party.id, n), JSON.stringify(evalRecord(party, picks, trace, ruleSummary, ranking)), { expirationTtl: EVAL_TTL }),
    env.USAGE.put(roundKey(party.id, n), JSON.stringify({
      n,
      createdAt: new Date().toISOString(),
      memberMids: party.members.map((m) => m.mid),
      groupSize: party.members.length,
      rules: ruleSummary,
      picks,
      trace,
      ...extraRecord,
    }), { expirationTtl: LOG_TTL }),
    saveParty(env, party),
    writeRecord(env, key, record),
    env.USAGE.put(globalKey, String(globalUsed + 1), { expirationTtl: TWO_DAYS }),
    addSpend(env, trace.costUsd),
  ]);

  return json({
    party: await partyState(env, party, body.mid),
    usage: usageView(env, record),
    budget: await budgetView(env),
    round: { tokens: trace.tokens, costUsd: trace.costUsd, variant: trace.variant, fallback: trace.fallback, toolCalls: trace.steps.filter((s) => s.kind === 'tool').length, checks: trace.checks },
  });
}

// Just me: recommend from the films this person rated.
async function tasteRound(env, party, taste, ctx) {
  const rules = tasteRules(party);
  const history = await partyHistory(env, party);
  const trace = newTrace('taste');
  let outcome;
  try {
    outcome = await runTastePicker(env, party, rules, taste, history.seen, trace);
  } catch (err) {
    await recordFailedRound(env, trace, 'error');
    throw err;
  }
  if (!outcome.picks.length) {
    await recordFailedRound(env, trace, 'no-matches');
    return json({ error: 'no-matches', usage: usageView(env, ctx.record) }, 404);
  }
  const picks = outcome.picks.map((c) => shapePick(c.details, party, {
    ...(c.why ? { why: c.why, byEmber: true } : {}),
    ...tasteExtra(c, c.details, rules),
  }));
  trace.checks = instructionChecks(trace, { invented: outcome.invented, fromEmber: outcome.fromEmber }, picks, rules);
  const liked = taste.ratings.filter((r) => r.rating === 'like').length;
  return saveRound(env, party, picks, trace,
    { kids: rules.kids, adultsOnly: rules.adultsOnly, services: rules.services.length, taste: true },
    { taste: { liked, disliked: taste.ratings.length - liked, unseen: taste.unseen.length, genres: party.members[0].answers.genres }, reserve: outcome.reserve, dismissed: [] },
    { ...ctx, ranking: { ranks: Object.fromEntries(outcome.picks.map((c) => [String(c.id), { rank: c.rank, score: c.score }])), ranked: outcome.rankedIds } });
}

// POST /api/party/:id/replace  { mid, round, filmId }
// "Not for me" on one result: that card is swapped for the next best match.
// Free: no round is used and Ember is not called.
async function handleReplace(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'bad-request' }, 400);
  const party = await loadParty(env, id);
  if (!party) return json({ error: 'not-found' }, 404);
  if (!party.solo || body.mid !== party.hostMid) return json({ error: 'solo-only' }, 403);
  const n = Number(body.round);
  if (n !== party.round || n < 1) return json({ error: 'bad-round' }, 400);
  const round = await env.USAGE.get(roundKey(party.id, n), 'json');
  if (!round || !round.reserve) return json({ error: 'bad-round' }, 400);
  const at = round.picks.findIndex((p) => p.id === String(body.filmId));
  if (at < 0) return json({ error: 'not-in-round' }, 404);

  const rules = tasteRules(party);
  const others = round.picks.filter((_, i) => i !== at).map((p) => ({ genre: p.primaryGenre }));
  const genreCount = (party.members[0].answers.genres || []).length;
  round.dismissed = [...(round.dismissed || []), round.picks[at].id];
  let replacement = null;
  let taken = null;
  while (!replacement) {
    const [next] = takeVaried(round.reserve, 1, genreCount, others);
    if (!next) break;
    round.reserve = round.reserve.filter((c) => c.id !== next.id);
    const details = await filmDetails(env, next.id).catch(() => null);
    if (details) {
      replacement = shapePick(details, party, tasteExtra(next, details, rules));
      taken = next;
    }
  }
  if (!replacement) {
    await env.USAGE.put(roundKey(party.id, n), JSON.stringify(round), { expirationTtl: LOG_TTL });
    // Nothing to swap in, but "Not for me" is still a grade of 0 for this film.
    await labelTaste(env, party.id, n, round.picks[at].id, 0);
    return json({ error: 'no-more' }, 404);
  }
  const dismissedId = round.picks[at].id;
  round.picks[at] = replacement;
  delete round.shareId; // the three changed: the next share is a new snapshot
  await env.USAGE.put(roundKey(party.id, n), JSON.stringify(round), { expirationTtl: LOG_TTL });
  // "Not for me" is a grade of 0, and the swap is kept with the new film's place in the ranking.
  await labelTaste(env, party.id, n, dismissedId, 0, (fb) => {
    fb.swaps.push({ pos: at + 1, from: dismissedId, to: replacement.id, rank: taken.rank || null, score: taken.score == null ? null : taken.score });
  });
  await bumpStats(env, (s) => { s.swaps += 1; });
  return json({ party: await partyState(env, party, body.mid) });
}

// A round that produced nothing may still have cost money. Count it against
// the budget and keep its prompts, so the trace has no gaps.
async function recordFailedRound(env, trace, reason) {
  trace.costUsd = costUsd(trace);
  if (!trace.log.length) return;
  await Promise.all([
    addSpend(env, trace.costUsd),
    env.USAGE.put(`fail:${new Date().toISOString()}:${randomId(6)}`, JSON.stringify({ at: new Date().toISOString(), reason, trace }), { expirationTtl: LOG_TTL }),
  ]);
}

async function handleVotes(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.votes)) return json({ error: 'bad-request' }, 400);
  const party = await loadParty(env, id);
  if (!party) return json({ error: 'not-found' }, 404);
  if (!party.members.some((m) => m.mid === body.mid)) return json({ error: 'not-a-member' }, 403);
  const n = Number(body.round);
  if (!Number.isInteger(n) || n < 1 || n > party.round) return json({ error: 'bad-round' }, 400);

  const votes = body.votes.slice(0, 3).map((v) => ({
    id: String(v.id || '').slice(0, 12),
    vote: v.vote === 'yes' ? 'yes' : 'no',
    reason: String(v.reason || '').slice(0, 40),
  }));
  await env.USAGE.put(votesKey(party.id, n, body.mid), JSON.stringify({ at: new Date().toISOString(), votes }), { expirationTtl: LOG_TTL });
  // For evaluation: yes = 1, no = 0, under the member's position (P1, P2...), not their id.
  const member = `P${party.members.findIndex((m) => m.mid === body.mid) + 1}`;
  await labelGroup(env, party.id, n, member, Object.fromEntries(votes.map((v) => [v.id, v.vote === 'yes' ? 1 : 0])));
  return json({ party: await partyState(env, party, body.mid) });
}

// ---------------------------------------------------------------------------
// Evaluation: every ranked list shown, with its labels, for MRR, MAP and NDCG
// ---------------------------------------------------------------------------
//
//   eval:<party>:<n>          the list as shown: films in order, and for Just me
//                             each film's place and score in the ranker's list
//   eval:<party>:<n>:fb       Just me: grades (2 Would watch, 1 Maybe, 0 Not
//                             for me), swaps and watch clicks
//   eval:<party>:<n>:v:P<i>   groups: one member's yes (1) / no (0) votes
//
// Kept a year. No ids, names or places: members are P1, P2...
// scripts/export-feedback.mjs downloads them and computes the full report;
// the running totals below feed the footer.

const evalKey = (id, n, suffix = '') => `eval:${id}:${n}${suffix}`;
const STATS_KEY = 'stats';
const RELEVANT_AT = { taste: 2, group: 1 }; // Would watch; a yes vote

function evalRecord(party, picks, trace, rules, ranking) {
  const ranks = (ranking && ranking.ranks) || {};
  return {
    v: 1,
    at: new Date().toISOString(),
    flow: rules.taste ? 'taste' : (trace.variant || 'group'),
    groupSize: party.members.length,
    kids: !!rules.kids,
    adultsOnly: !!rules.adultsOnly,
    genres: [...new Set(party.members.flatMap((m) => m.answers.genres || []))],
    shown: picks.map((p, i) => ({
      pos: i + 1,
      id: p.id,
      title: p.title,
      genre: p.primaryGenre || p.pickedFor || '',
      rank: ranks[p.id] ? ranks[p.id].rank : null,
      score: ranks[p.id] && typeof ranks[p.id].score === 'number' ? Math.round(ranks[p.id].score * 1000) / 1000 : null,
      byEmber: !!p.byEmber,
      because: p.becauseTitle || (p.popularIn ? `popular in ${p.popularIn}` : ''),
    })),
    ranked: (ranking && ranking.ranked) || [],
  };
}

// The list's grades in the order shown, or null until every film has one.
function gradesOf(shown, labels) {
  const grades = shown.map((f) => (labels[f.id] == null ? null : (typeof labels[f.id] === 'object' ? labels[f.id].grade : labels[f.id])));
  return grades.every((g) => g != null) ? grades : null;
}

function emptyStats() {
  const recs = () => ({ lists: 0, rated: 0, rr: 0, ap: 0, ndcg: 0 });
  return { since: new Date().toISOString(), rounds: { taste: 0, group: 0 }, shares: 0, swaps: 0, clicks: 0, recs: { taste: recs(), group: recs() } };
}

// The totals, created the first time from the rounds already kept.
async function readStats(env) {
  const stats = await env.USAGE.get(STATS_KEY, 'json');
  if (stats) return stats;
  const seeded = emptyStats();
  let cursor;
  const names = [];
  do {
    const page = await env.USAGE.list({ prefix: 'p:', cursor, limit: 1000 });
    names.push(...page.keys.map((k) => k.name).filter((name) => /^p:[a-z0-9]+:r:\d+$/.test(name)));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const rounds = await Promise.all(names.slice(0, 500).map((name) => env.USAGE.get(name, 'json').catch(() => null)));
  rounds.filter(Boolean).forEach((r) => {
    const flow = r.rules && r.rules.taste ? 'taste' : 'group';
    seeded.rounds[flow] += 1;
    if (r.createdAt && r.createdAt < seeded.since) seeded.since = r.createdAt;
  });
  return seeded;
}

// KV has no atomic add: re-read just before writing, as addSpend does. Two
// writes at the same instant can lose one count; the export recomputes exactly.
async function bumpStats(env, change) {
  const stats = await readStats(env);
  change(stats);
  await env.USAGE.put(STATS_KEY, JSON.stringify(stats));
}

// Move a list's contribution from its old score to its new one, so a changed
// grade never counts a list twice.
function moveScore(recs, before, after) {
  if (before) { recs.rated -= 1; recs.rr -= before.rr; recs.ap -= before.ap; recs.ndcg -= before.ndcg; }
  if (after) { recs.rated += 1; recs.rr += after.rr; recs.ap += after.ap; recs.ndcg += after.ndcg; }
}

// Just me: one grade (0, 1, 2) for one film, plus any change to the record.
async function labelTaste(env, partyId, n, filmId, grade, change) {
  const list = await env.USAGE.get(evalKey(partyId, n), 'json');
  if (!list) return null;
  const fb = (await env.USAGE.get(evalKey(partyId, n, ':fb'), 'json')) || { labels: {}, swaps: [], clicks: [], score: null };
  if (grade != null) fb.labels[filmId] = { grade, at: new Date().toISOString() };
  if (change) change(fb);
  const before = fb.score;
  const grades = gradesOf(list.shown, fb.labels);
  fb.score = grades ? scoreList(grades, RELEVANT_AT.taste) : null;
  await env.USAGE.put(evalKey(partyId, n, ':fb'), JSON.stringify(fb), { expirationTtl: EVAL_TTL });
  if (JSON.stringify(before) !== JSON.stringify(fb.score)) await bumpStats(env, (s) => moveScore(s.recs.taste, before, fb.score));
  return fb;
}

// Groups: one member's votes on one round.
async function labelGroup(env, partyId, n, member, labels) {
  const list = await env.USAGE.get(evalKey(partyId, n), 'json');
  if (!list) return;
  const key = evalKey(partyId, n, `:v:${member}`);
  const old = await env.USAGE.get(key, 'json');
  const grades = gradesOf(list.shown, labels);
  const score = grades ? scoreList(grades, RELEVANT_AT.group) : null;
  await env.USAGE.put(key, JSON.stringify({ at: new Date().toISOString(), labels, score }), { expirationTtl: EVAL_TTL });
  const before = old ? old.score : null;
  if (JSON.stringify(before) !== JSON.stringify(score)) await bumpStats(env, (s) => moveScore(s.recs.group, before, score));
}

// POST /api/party/:id/feedback  { mid, round, filmId, grade: 0 | 1 | 2 | "click" }
// Just me: how good one result is. Free: no round, no Ember.
async function handleFeedback(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'bad-request' }, 400);
  const click = body.grade === 'click';
  if (!click && ![0, 1, 2].includes(body.grade)) return json({ error: 'bad-grade' }, 400);
  const party = await loadParty(env, id);
  if (!party) return json({ error: 'not-found' }, 404);
  if (!party.solo || body.mid !== party.hostMid) return json({ error: 'solo-only' }, 403);
  const n = Number(body.round);
  if (!Number.isInteger(n) || n < 1 || n > party.round) return json({ error: 'bad-round' }, 400);
  const list = await env.USAGE.get(evalKey(party.id, n), 'json');
  if (!list) return json({ error: 'bad-round' }, 400);
  const filmId = String(body.filmId || '');
  const fb = (await env.USAGE.get(evalKey(party.id, n, ':fb'), 'json')) || { swaps: [] };
  const known = list.shown.some((f) => f.id === filmId) || (fb.swaps || []).some((x) => x.to === filmId);
  if (!known) return json({ error: 'not-in-round' }, 404);

  if (click) {
    let fresh = false;
    await labelTaste(env, party.id, n, filmId, null, (record) => {
      if (!record.clicks.includes(filmId)) { record.clicks.push(filmId); fresh = true; }
    });
    if (fresh) await bumpStats(env, (s) => { s.clicks += 1; });
  } else {
    await labelTaste(env, party.id, n, filmId, body.grade);
  }
  return json({ ok: true });
}

// GET /api/stats  Data for Nerds: site-wide usage and how good the picks are.
async function handleStats(env) {
  const [stats, wall, budget] = await Promise.all([readStats(env), readWall(env), budgetView(env)]);
  const mean = (r) => (r.rated ? {
    rated: r.rated,
    mrr: Math.round((r.rr / r.rated) * 1000) / 1000,
    map: Math.round((r.ap / r.rated) * 1000) / 1000,
    ndcg: Math.round((r.ndcg / r.rated) * 1000) / 1000,
  } : { rated: 0, mrr: null, map: null, ndcg: null });
  return json({
    since: stats.since,
    usage: { people: wall.people, rounds: stats.rounds, shares: stats.shares, swaps: stats.swaps, clicks: stats.clicks, spentUsd: budget.spentUsd, limitUsd: budget.limitUsd },
    recommendations: { taste: { lists: stats.recs.taste.lists, ...mean(stats.recs.taste) }, group: { lists: stats.recs.group.lists, ...mean(stats.recs.group) } },
  }, 200, { 'Cache-Control': 'public, max-age=60' });
}

// GET /api/admin/feedback  every eval record, a page at a time (needs ADMIN_KEY).
async function handleAdminFeedback(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_KEY || auth !== `Bearer ${env.ADMIN_KEY}`) return json({ error: 'not-found' }, 404);
  const url = new URL(request.url);
  const listing = await env.USAGE.list({ prefix: 'eval:', cursor: url.searchParams.get('cursor') || undefined, limit: 200 });
  const values = await Promise.all(listing.keys.map((k) => env.USAGE.get(k.name, 'json')));
  return json({
    records: listing.keys.map((k, i) => ({ key: k.name, value: values[i] })).filter((r) => r.value),
    nextCursor: listing.list_complete ? null : listing.cursor,
  });
}


// ---------------------------------------------------------------------------
// Sharing (Just me): a read-only snapshot of one round's three films
// ---------------------------------------------------------------------------

const shareKey = (id) => `share:${id}`;
const MAX_SHARES_PER_DAY = 30;

// POST /api/party/:id/share  { mid, round }
// Free: no round, no Ember. Keeps only what the shared page shows: the
// sharer's first name, their genres and the three films.
async function handleShare(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'bad-request' }, 400);
  const party = await loadParty(env, id);
  if (!party) return json({ error: 'not-found' }, 404);
  if (!party.solo || body.mid !== party.hostMid) return json({ error: 'solo-only' }, 403);
  const n = Number(body.round);
  if (!Number.isInteger(n) || n < 1 || n > party.round) return json({ error: 'bad-round' }, 400);
  const round = await env.USAGE.get(roundKey(party.id, n), 'json');
  if (!round) return json({ error: 'bad-round' }, 400);
  if (round.shareId) return json({ id: round.shareId, url: `/s/${round.shareId}` });

  const { key } = await visitorKey(request, env);
  const record = await readRecord(env, key);
  if ((record.shares || 0) >= MAX_SHARES_PER_DAY) return json({ error: 'slow-down' }, 429);
  record.shares = (record.shares || 0) + 1;

  const me = party.members[0];
  const shareId = randomId(8);
  const snapshot = {
    name: firstName(me.name),
    genres: (me.answers.genres || []).slice(0, MAX_GENRES),
    createdAt: new Date().toISOString(),
    picks: round.picks.slice(0, 3).map((p) => ({
      title: p.title, meta: p.meta, minutes: p.minutes, backdrop: p.backdrop || '', poster: p.poster || '',
      primaryGenre: p.primaryGenre || '', becauseTitle: p.becauseTitle || '', popularIn: p.popularIn || '',
      why: p.byEmber ? p.why : '', service: p.service || null, watchUrl: p.watchUrl || '',
    })),
  };
  round.shareId = shareId;
  await Promise.all([
    env.USAGE.put(shareKey(shareId), JSON.stringify(snapshot), { expirationTtl: LOG_TTL }),
    env.USAGE.put(roundKey(party.id, n), JSON.stringify(round), { expirationTtl: LOG_TTL }),
    writeRecord(env, key, record),
  ]);
  await bumpStats(env, (s) => { s.shares += 1; });
  return json({ id: shareId, url: `/s/${shareId}` });
}

async function loadShare(env, id) {
  return validId(id, 8) ? env.USAGE.get(shareKey(id), 'json') : null;
}

// GET /api/share/:id
async function handleGetShare(env, id) {
  const share = await loadShare(env, id);
  if (!share) return json({ error: 'gone' }, 404);
  return json({ share }, 200, { 'Cache-Control': 'public, max-age=300' });
}

const escHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// GET /s/:id  the site's page, with link-preview tags for chat apps.
async function handleSharePage(request, env, id) {
  const page = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), { headers: request.headers }));
  const share = await loadShare(env, id).catch(() => null);
  // The page links its files relatively (styles.css, app.js): resolve them from the root.
  const html = (await page.text()).replace('<head>', '<head>\n  <base href="/">');
  if (!share) return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const who = share.name ? `${share.name}'s` : 'My';
  const titles = share.picks.map((p) => p.title).join(', ');
  const image = (share.picks.find((p) => p.backdrop) || {}).backdrop || '';
  const tags = [
    ['og:title', `${who} three for tonight: ${titles}`],
    ['og:description', `Picked by Movie Buddy from the films ${share.name || 'they'} liked. Get your own three in about a minute.`],
    ['og:type', 'website'],
    ['og:url', new URL(`/s/${id}`, request.url).href],
    ...(image ? [['og:image', image]] : []),
  ].map(([property, content]) => `<meta property="${property}" content="${escHtml(content)}">`);
  tags.push(`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`);
  return new Response(html.replace('</head>', `${tags.join('\n  ')}\n</head>`), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

async function handleProviders(env) {
  const list = await providerList(env);
  return json(list.slice(0, 12), 200, { 'Cache-Control': 'public, max-age=86400' });
}

// TMDB's current popular films in the US, for the home page's tiles and the
// waiting screen, straight from
// TMDB. Only the image paths are passed on; the browser loads the pictures
// from TMDB itself, so no artwork is stored in this project.
async function handlePosters(env) {
  const data = await tmdb(env, '/movie/popular', { language: 'en-US', region: REGION }, 21600);
  const posters = (data.results || [])
    .filter((m) => m.poster_path && !m.adult)
    .slice(0, 14)
    .map((m) => ({
      title: m.title,
      poster: `${TMDB_IMAGE}/w342${m.poster_path}`,
      // Wide still for the landscape tiles on the home page.
      backdrop: m.backdrop_path ? `${TMDB_IMAGE}/w780${m.backdrop_path}` : '',
      id: m.id,
    }));
  // The first three are the home page's film tiles, which show details on
  // hover or tap: the same facts a swipe card shows. A failed lookup just
  // leaves that tile without them.
  const noGroup = { members: [] };
  const details = await Promise.allSettled(posters.slice(0, 3).map((p) => filmDetails(env, p.id)));
  details.forEach((result, i) => {
    if (result.status !== 'fulfilled' || !result.value || !result.value.id) return;
    const pick = shapePick(result.value, noGroup);
    const watch = pick.watch
      ? `${pick.watch.type === 'rent' ? 'Rent or buy on' : 'Included with'} ${pick.watch.options.map((o) => o.service).slice(0, 3).join(', ')}`
      : '';
    posters[i].details = {
      meta: pick.meta,
      about: pick.why,
      rating: result.value.vote_average ? Math.round(result.value.vote_average * 10) / 10 : null,
      watch,
      trailerUrl: pick.trailerUrl,
    };
  });
  posters.forEach((p) => { delete p.id; });
  // TMDB's answer is kept for six hours on the server (above); browsers only
  // keep this list ten minutes, so changes to it reach visitors quickly.
  return json(posters, 200, { 'Cache-Control': 'public, max-age=600' });
}

async function handleUsage(request, env) {
  const { key } = await visitorKey(request, env);
  return json({ usage: usageView(env, await readRecord(env, key)), budget: await budgetView(env) });
}

/*
 * The prompt/token trace: every Ember call this site has made, with the full
 * prompt, the reply, token counts and cost. Private: needs the ADMIN_KEY
 * secret as a bearer token. Paged, because a Worker can only read so many
 * records per request; `scripts/export-trace.mjs` follows the pages.
 */
async function handleTrace(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_KEY || auth !== `Bearer ${env.ADMIN_KEY}`) return json({ error: 'not-found' }, 404);

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') === 'failed' ? 'failed' : 'rounds';
  const listing = await env.USAGE.list({ prefix: kind === 'failed' ? 'fail:' : 'p:', cursor: url.searchParams.get('cursor') || undefined, limit: 200 });
  // Round records are p:<group>:r:<n>. Groups and votes share the prefix.
  const names = listing.keys.map((k) => k.name).filter((name) => kind === 'failed' || /^p:[a-z0-9]+:r:\d+$/.test(name));
  const records = await Promise.all(names.map((name) => env.USAGE.get(name, 'json')));

  const rounds = records.filter(Boolean).map((r, i) => {
    const t = r.trace || {};
    return {
      key: names[i],
      at: r.createdAt || r.at,
      outcome: kind === 'failed' ? r.reason : 'served',
      variant: t.variant,
      fallback: t.fallback,
      groupSize: r.groupSize,
      inputTokens: t.input || 0,
      outputTokens: t.output || 0,
      cachedTokens: t.cached || 0,
      costUsd: t.costUsd || 0,
      checks: t.checks,
      calls: t.log || [],
    };
  });
  return json({
    kind,
    model: EMBER_MODEL,
    pricePerMillionUsd: PRICE_PER_MILLION,
    budget: await budgetView(env),
    rounds,
    nextCursor: listing.list_complete ? null : listing.cursor,
  });
}

async function handleUsageRequest(request, env) {
  const body = await request.json().catch(() => ({}));
  const { key } = await visitorKey(request, env);
  const record = await readRecord(env, key);
  if (record.requested) return json({ granted: false, usage: usageView(env, record) });
  record.requested = true;
  record.extra += setting(env, 'EXTRA_ROUNDS', 5);
  record.note = String((body && body.note) || '').slice(0, 200); // what they were looking for
  await writeRecord(env, key, record);
  return json({ granted: true, extra: setting(env, 'EXTRA_ROUNDS', 5), usage: usageView(env, record) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Everything that is not the API is the static site.
    // A shared three: the page, with link-preview tags.
    const shared = url.pathname.match(/^\/s\/([a-z0-9]{8})\/?$/);
    if (shared && request.method === 'GET') return handleSharePage(request, env, shared[1]);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    // 1. same-origin check
    if (!sameOrigin(request)) return json({ error: 'forbidden' }, 403);

    // 2. edge rate limit (only if the binding is configured)
    if (env.API_LIMIT) {
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const { success } = await env.API_LIMIT.limit({ key: ip });
      if (!success) return json({ error: 'slow-down' }, 429);
    }

    try {
      const route = `${request.method} ${url.pathname}`;
      if (route === 'POST /api/party') return await handleCreateParty(request, env);
      if (route === 'GET /api/providers') return await handleProviders(env);
      if (route === 'GET /api/posters') return await handlePosters(env);
      if (route === 'GET /api/rate-films') return await handleRateFilms(env, url);
      const shareGet = url.pathname.match(/^\/api\/share\/([a-z0-9]{8})$/);
      if (shareGet && request.method === 'GET') return await handleGetShare(env, shareGet[1]);
      if (route === 'GET /api/wall') return await handleWall(env);
      if (route === 'GET /api/usage') return await handleUsage(request, env);
      if (route === 'GET /api/admin/trace') return await handleTrace(request, env);
      if (route === 'GET /api/admin/feedback') return await handleAdminFeedback(request, env);
      if (route === 'GET /api/stats') return await handleStats(env);
      if (route === 'POST /api/usage/request') return await handleUsageRequest(request, env);

      const party = url.pathname.match(/^\/api\/party\/([a-z0-9]+)(\/(join|round|votes|replace|share|feedback))?$/);
      if (party) {
        const [, id, , action] = party;
        if (request.method === 'GET' && !action) return await handleGetParty(env, id, url.searchParams.get('mid') || '');
        if (request.method === 'POST' && action === 'join') return await handleJoin(request, env, id);
        if (request.method === 'POST' && action === 'round') return await handleRound(request, env, id);
        if (request.method === 'POST' && action === 'votes') return await handleVotes(request, env, id);
        if (request.method === 'POST' && action === 'replace') return await handleReplace(request, env, id);
        if (request.method === 'POST' && action === 'share') return await handleShare(request, env, id);
        if (request.method === 'POST' && action === 'feedback') return await handleFeedback(request, env, id);
      }
      return json({ error: 'not-found' }, 404);
    } catch (err) {
      console.error(err.stack || err.message);
      return json({ error: 'server' }, 502);
    }
  },
};
