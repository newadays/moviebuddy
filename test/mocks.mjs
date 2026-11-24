// Stand-ins for Cloudflare KV, TMDB, Muse Ember and Turnstile, so the Worker
// can be tested with no keys and no network.
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

export function makeKV() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      const v = map.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { map.set(key, String(value)); },
    // Like Workers KV: keys in order, a page at a time.
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const all = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const done = start + limit >= all.length;
      return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + limit) };
    },
  };
}

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp' };

export function makeAssets(dir) {
  return {
    async fetch(request) {
      let path = new URL(request.url).pathname;
      if (path === '/') path = '/index.html';
      try {
        const body = await readFile(join(dir, path));
        return new Response(body, { headers: { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' } });
      } catch (err) {
        return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }
    },
  };
}

export const calls = { tmdb: [], ember: [], turnstile: [] };

// mock.ember chooses how the stand-in model behaves:
//   good          one search, then a note, then three valid picks
//   two-searches  searches twice with different genres before answering
//   never-stops   keeps calling tools until the Worker cuts it off
//   bad-args      sends tool arguments that are not JSON
//   no-tools      answers in plain text without ever searching
//   bad-ids       final answer contains an invented film
//   garbage       final answer is not JSON
//   down          the API returns 500
export const mock = { ember: 'good', discoverCount: 20, turnstileOk: true, runtime: 103, recentCount: null };

function movie(id) {
  return { id, title: `Film ${id}`, release_date: '2019-05-01', genre_ids: [53, 80], vote_average: 7.1, poster_path: `/p${id}.jpg`, overview: `Film ${id} is a tense story about a heist that goes wrong. It keeps moving.` };
}

const PROVIDERS = [
  { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg', display_priority: 1 },
  { provider_id: 9, provider_name: 'Amazon Prime Video', logo_path: '/a.jpg', display_priority: 2 },
  { provider_id: 1899, provider_name: 'Max', logo_path: '/m.jpg', display_priority: 3 },
];

function toolCall(name, args) {
  return { role: 'assistant', content: null, tool_calls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] };
}

function emberReply(body) {
  const toolMessages = body.messages.filter((m) => m.role === 'tool');
  const films = toolMessages.flatMap((m) => { try { return JSON.parse(m.content).films || []; } catch (e) { return []; } });
  const brief = JSON.parse(body.messages[1].content);
  const candidates = films.length ? films : (brief.films || []);

  if (body.tools) { // a loop step
    if (mock.ember === 'no-tools') return { role: 'assistant', content: 'How about a comedy?' };
    if (mock.ember === 'bad-args') return toolCall('search_films', '{not json');
    if (mock.ember === 'never-stops') return toolCall('search_films', { genres: ['thriller'], page: toolMessages.length + 1 });
    if (mock.ember === 'two-searches' && toolMessages.length === 1) return toolCall('search_films', { genres: ['comedy', 'crime'], max_minutes: 100, page: 2 });
    if (toolMessages.length === 0) return toolCall('search_films', { genres: ['thriller', 'comedy'], max_minutes: 500 });
    return { role: 'assistant', content: 'I have enough candidates.' };
  }

  // the final answer
  if (mock.ember === 'garbage') return { role: 'assistant', content: 'Sure! Here are some films you might like.' };
  const labels = brief.people.map((p) => p.label);
  const picks = candidates.slice(0, 3).map((c, i) => ({ id: c.id, why: `You wanted something tense, and ${c.title} is a heist story that keeps moving.`, fits: i === 0 ? labels : labels.slice(0, 1) }));
  if (mock.ember === 'bad-ids') { picks[0] = { id: 999999, why: 'Invented.', fits: labels }; picks[1].fits = ['P1', 'P99']; }
  return { role: 'assistant', content: JSON.stringify({ picks }) };
}

export function installFetchMock() {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input);
    const ok = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

    if (url.host === 'api.themoviedb.org') {
      calls.tmdb.push(url.pathname + url.search);
      if (!String(init.headers.Authorization).startsWith('Bearer ')) return new Response('{}', { status: 401 });
      // TMDB's bad spells: the next few requests fail, and some films never load.
      if (mock.tmdbFlaky > 0) { mock.tmdbFlaky -= 1; return new Response('{}', { status: 500 }); }
      const film = url.pathname.match(/^\/3\/movie\/(\d+)$/);
      if (film && mock.brokenFilms && mock.brokenFilms(Number(film[1]))) return new Response('{}', { status: 500 });
      if (url.pathname === '/3/discover/movie') {
        const page = Number(url.searchParams.get('page'));
        // A thin strict search: one page of a few films while 300+ votes are required.
        if (mock.recentCount !== null && Number(url.searchParams.get('vote_count.gte')) >= 300) {
          return ok({ page, total_pages: 1, results: Array.from({ length: mock.recentCount }, (_, i) => movie(900 + i)) });
        }
        const start = 100 + (page - 1) * 20;
        return ok({ page, total_pages: 5, results: Array.from({ length: mock.discoverCount }, (_, i) => movie(start + i + 1)) });
      }
      if (url.pathname === '/3/movie/popular') return ok({ results: [...Array.from({ length: 20 }, (_, i) => movie(i + 1)), { id: 99, title: 'No poster', poster_path: null }] });
      if (url.pathname === '/3/watch/providers/movie') return ok({ results: [...PROVIDERS].reverse() });
      const m = url.pathname.match(/^\/3\/movie\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        return ok({
          ...movie(id), runtime: mock.runtime, genres: [{ id: 53, name: 'Thriller' }],
          'watch/providers': { results: { US: { link: `https://www.themoviedb.org/movie/${id}/watch`, flatrate: [PROVIDERS[0], PROVIDERS[2]] } } },
          videos: { results: [{ site: 'YouTube', type: 'Trailer', key: `yt${id}` }] },
        });
      }
      return new Response('{}', { status: 404 });
    }

    if (url.host === 'api.meta.ai') {
      const body = JSON.parse(init.body);
      calls.ember.push(body);
      if (mock.ember === 'down') return new Response('{}', { status: 500 });
      return ok({ choices: [{ message: emberReply(body), finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 } });
    }

    if (url.host === 'challenges.cloudflare.com') {
      calls.turnstile.push(init.body.get('response'));
      return ok({ success: mock.turnstileOk && init.body.get('response') === 'good-token' });
    }
    throw new Error('unexpected fetch: ' + url);
  };
}
