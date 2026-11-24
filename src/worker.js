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
 *   GET  /api/providers              streaming services, from TMDB
 *   GET  /api/posters                TMDB's popular films: home-page tiles and the waiting screen
 *   GET  /api/wall                   who has used the site lately: first names and places
 *   GET  /api/usage                  this visitor's rounds left today, and the site's budget
 *   POST /api/usage/request          ask for extra rounds (once a day)
 *   GET  /api/admin/trace            every Ember prompt, token count and cost (needs ADMIN_KEY)
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
  return tmdb(env, `/movie/${id}`, { append_to_response: 'watch/providers,videos', language: 'en-US' }, 3600);
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
    return { id: party.id, joined: false, hostName: host ? host.name : '', memberCount: party.members.length, full: party.members.length >= MAX_MEMBERS, started: party.round > 0 };
  }

  const names = Object.fromEntries(party.members.map((m) => [m.mid, m.name]));
  const state = {
    id: party.id,
    joined: true,
    isHost: mid === party.hostMid,
    solo: party.members.length === 1,
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
  trace.costUsd = costUsd(trace);
  const n = party.round + 1;
  party.round = n;
  record.used += 1;
  record.tokens += trace.tokens;
  record.cost = (record.cost || 0) + trace.costUsd;

  // Count the round only now that it succeeded. The round record doubles as
  // the evaluation log: picks, the trace and the checks, kept 30 days.
  await Promise.all([
    env.USAGE.put(roundKey(party.id, n), JSON.stringify({
      n,
      createdAt: new Date().toISOString(),
      memberMids: party.members.map((m) => m.mid),
      groupSize: party.members.length,
      rules: { time: rules.time, kids: rules.kids, services: rules.services.length },
      picks,
      trace,
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
  return json({ party: await partyState(env, party, body.mid) });
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
      if (route === 'GET /api/wall') return await handleWall(env);
      if (route === 'GET /api/usage') return await handleUsage(request, env);
      if (route === 'GET /api/admin/trace') return await handleTrace(request, env);
      if (route === 'POST /api/usage/request') return await handleUsageRequest(request, env);

      const party = url.pathname.match(/^\/api\/party\/([a-z0-9]+)(\/(join|round|votes))?$/);
      if (party) {
        const [, id, , action] = party;
        if (request.method === 'GET' && !action) return await handleGetParty(env, id, url.searchParams.get('mid') || '');
        if (request.method === 'POST' && action === 'join') return await handleJoin(request, env, id);
        if (request.method === 'POST' && action === 'round') return await handleRound(request, env, id);
        if (request.method === 'POST' && action === 'votes') return await handleVotes(request, env, id);
      }
      return json({ error: 'not-found' }, 404);
    } catch (err) {
      console.error(err.stack || err.message);
      return json({ error: 'server' }, 502);
    }
  },
};
