// Run with:  npm test     (no keys or network needed)
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { makeKV, makeAssets, installFetchMock, calls, mock } from './mocks.mjs';

installFetchMock();
const SITE = 'https://moviebuddy.example';
let passed = 0;

function env(extra = {}) {
  return { USAGE: makeKV(), ASSETS: makeAssets(new URL('../public', import.meta.url).pathname), TMDB_TOKEN: 't', MODEL_API_KEY: 'm', PICKER: 'agent', ...extra };
}
function req(path, { method = 'GET', body, ip = '1.1.1.1', origin = SITE, cf } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  if (body) headers['Content-Type'] = 'application/json';
  const request = new Request(SITE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (cf) Object.defineProperty(request, 'cf', { value: cf }); // what Cloudflare attaches: city, country
  return request;
}
const call = async (e, path, opts) => { const res = await worker.fetch(req(path, opts), e); return { status: res.status, data: await res.json() }; };
const post = (e, path, body, opts = {}) => call(e, path, { method: 'POST', body, ...opts });

const HOST = 'hosthosthosthost';
const DANA = 'danadanadanadana';
const SAM = 'samsamsamsamsam1';
const hostAnswers = { mood: 'gripped', time: 'long', services: [8] };

async function party(e, extra = {}) {
  const { data } = await post(e, '/api/party', { mid: HOST, name: 'Gbenga', answers: hostAnswers, ...extra });
  return data.party.id;
}
const round = (e, id, extra = {}, opts) => post(e, `/api/party/${id}/round`, { mid: HOST, ...extra }, opts);
const vote = (e, id, mid, n, yes) => post(e, `/api/party/${id}/votes`, { mid, round: n, votes: yes });
const state = (e, id, mid) => call(e, `/api/party/${id}?mid=${mid}`).then((r) => r.data.party);
const tools = () => calls.ember.filter((b) => b.tools).length;

async function test(name, fn) {
  Object.assign(mock, { ember: 'good', discoverCount: 20, turnstileOk: true, runtime: 103, recentCount: null, tmdbFlaky: 0, brokenFilms: null, film: null, thinVotes: 0 });
  calls.tmdb.length = 0; calls.ember.length = 0; calls.turnstile.length = 0;
  await fn(); passed += 1; console.log('ok  ', name);
}

// ---------------------------------------------------------------- the agent

await test('solo round: the agent searches, then answers with three real films', async () => {
  const e = env();
  const id = await party(e);
  const { status, data } = await round(e, id);
  assert.equal(status, 200);
  assert.equal(data.round.variant, 'agent');
  assert.equal(data.round.fallback, null);
  assert.equal(data.round.toolCalls, 1);
  assert.equal(data.round.checks.all_passed, true);
  const p = data.party.picks[0];
  assert.equal(data.party.picks.length, 3);
  assert.equal(p.meta, '2019 · 1h 43m · Thriller');
  assert.equal(p.poster, 'https://image.tmdb.org/t/p/w500/p101.jpg');
  assert.equal(p.byEmber, true);
  assert.deepEqual(p.fitsNames, ['you']);
  assert.deepEqual({ type: p.watch.type, service: p.watch.service, youHave: p.watch.youHave }, { type: 'subscription', service: 'Netflix', youHave: true });
  assert.equal(JSON.stringify(data.party).includes('options'), false, 'the raw service list stays on the server');
  assert.equal(p.trailerUrl, 'https://www.youtube.com/watch?v=yt101');
  assert.equal(calls.ember.length, 3, 'tool step, note, final answer');
  assert.deepEqual({ left: data.usage.left, tokens: data.usage.tokens }, { left: 9, tokens: 3000 });
  // Three calls of 900 tokens in and 100 out, at $0.10 and $0.50 per million.
  assert.equal(data.round.costUsd, 0.00042);
  assert.equal(data.usage.costUsd, 0.00042);
  assert.deepEqual(data.party.cost, { usd: 0.00042, tokens: 3000, calls: 3, searches: 1, estimated: false, agent: true, random: false, taste: false });
});

await test('Meta request format: tools with auto choice, then a schema-only final call', async () => {
  const e = env();
  await round(e, await party(e));
  const [step, , final] = calls.ember;
  assert.equal(step.model, 'muse-ember-1.0');
  assert.equal(step.tool_choice, 'auto');
  assert.equal(step.parallel_tool_calls, false);
  assert.deepEqual(step.tools.map((t) => t.function.name), ['search_films', 'get_film']);
  assert.equal(final.tools, undefined);
  assert.equal(final.response_format.type, 'json_schema');
  const assistant = final.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  const toolMsg = final.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, assistant.tool_calls[0].id, 'tool result answers the call it belongs to');
});

await test('the Worker enforces the rules whatever the agent asks for', async () => {
  const e = env();
  const id = await party(e, { answers: { mood: 'lighter', time: 'short', services: [8, 9] }, kids: true });
  await round(e, id); // the stand-in agent asks for max_minutes 500
  const q = new URL('https://x' + calls.tmdb.find((c) => c.startsWith('/3/discover'))).searchParams;
  assert.equal(q.get('with_runtime.lte'), '90', 'time limit wins over the agent');
  assert.equal(q.get('certification'), 'G|PG', 'exactly G or PG: "PG or lower" would let unrated films in');
  assert.equal(q.get('certification.lte'), null);
  assert.equal(q.get('without_genres'), '27', 'no horror with kids');
  assert.equal(q.get('with_watch_providers'), '8|9');
  assert.equal(q.get('with_genres'), '53|35', 'genres are the agent\'s choice');
});

await test('searches stay recent: last five years, loosened before going older, never classics', async () => {
  const ago = (years) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - years); return d.toISOString().slice(0, 10); };
  const discover = () => calls.tmdb.filter((c) => c.startsWith('/3/discover')).map((c) => new URL('https://x' + c).searchParams);

  // Plenty of recent films: every search stays inside the five-year window.
  const e = env();
  await round(e, await party(e));
  assert.ok(discover().length > 0);
  assert.ok(discover().every((q) => q.get('primary_release_date.gte') === ago(5)));

  // Too few with the strict filters: loosen them, still within five years.
  calls.tmdb.length = 0;
  mock.recentCount = 2;
  const e2 = env();
  await round(e2, await party(e2));
  const queries = discover();
  assert.ok(queries.every((q) => q.has('primary_release_date.gte')), 'no search without a date floor');
  assert.ok(queries.every((q) => q.get('primary_release_date.gte') >= ago(10)), 'never older than ten years');
  assert.ok(queries.some((q) => q.get('primary_release_date.gte') === ago(5) && q.get('vote_count.gte') === '50'), 'loosened, still recent');
});

await test('names and services never reach Ember; people are P1, P2', async () => {
  const e = env();
  const id = await party(e);
  await post(e, `/api/party/${id}/join`, { mid: DANA, name: 'Dana', answers: { mood: 'lighter', time: 'medium', services: [1899] } });
  await round(e, id);
  const sent = JSON.stringify(calls.ember);
  assert.ok(!sent.includes('Gbenga') && !sent.includes('Dana'));
  assert.deepEqual(JSON.parse(calls.ember[0].messages[1].content).people.map((p) => p.label), ['P1', 'P2']);
});

await test('each person\'s genres reach the agent, and the fallback searches with them', async () => {
  const e = env();
  const id = await party(e, { answers: { ...hostAnswers, genres: ['comedy', 'science fiction'] } });
  await post(e, `/api/party/${id}/join`, { mid: DANA, name: 'Dana', answers: { mood: 'lighter', time: 'medium', services: [8] } });
  await round(e, id);
  const people = JSON.parse(calls.ember[0].messages[1].content).people;
  assert.deepEqual(people.map((p) => p.genres), [['comedy', 'science fiction'], 'any']);
  assert.ok(calls.ember[0].messages[0].content.includes('genres people picked'));

  calls.tmdb.length = 0;
  const off = env({ AGENT: 'off' });
  await round(off, await party(off, { answers: { ...hostAnswers, genres: ['horror', 'comedy'] } }));
  const q = new URL('https://x' + calls.tmdb.find((c) => c.startsWith('/3/discover'))).searchParams;
  assert.equal(q.get('with_genres'), '27|35', 'picked genres, not the mood\'s');
});

// ---------------------------------------------------------------- the random picker (default)

await test('random picker: one recent film per picked genre, explained by Ember', async () => {
  const twoYearsAgo = (() => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 2); return d.toISOString().slice(0, 10); })();
  const e = env({ PICKER: 'random' });
  const id = await party(e, { answers: { ...hostAnswers, genres: ['comedy', 'horror', 'drama'] } });
  const { status, data } = await round(e, id);
  assert.equal(status, 200);
  assert.deepEqual(data.party.picks.map((p) => p.pickedFor), ['comedy', 'horror', 'drama']);
  assert.ok(data.party.picks.every((p) => p.byEmber && p.why));
  const discover = calls.tmdb.filter((c) => c.startsWith('/3/discover')).map((c) => new URL('https://x' + c).searchParams);
  assert.deepEqual([...new Set(discover.map((q) => q.get('with_genres')))], ['35', '27', '18'], 'one genre per film');
  assert.ok(discover.every((q) => q.get('primary_release_date.gte') === twoYearsAgo), 'last two years');
  assert.equal(calls.ember.length, 1, 'one Ember call to explain, no tool loop');
  assert.ok(!calls.ember[0].tools);
  assert.equal(data.party.cost.random, true);
  assert.equal(new Set(data.party.picks.map((p) => p.id)).size, 3, 'three different films');
});

await test('random picker: no genres picked uses the mood; one genre fills all three', async () => {
  const e = env({ PICKER: 'random' });
  const { data } = await round(e, await party(e, { answers: { ...hostAnswers, genres: ['comedy'] } }));
  assert.deepEqual(data.party.picks.map((p) => p.pickedFor), ['comedy', 'comedy', 'comedy']);
  const e2 = env({ PICKER: 'random' });
  const mood = await round(e2, await party(e2, { answers: { ...hostAnswers, mood: 'gripped', genres: [] } }));
  assert.ok(mood.data.party.picks.every((p) => ['thriller', 'crime', 'mystery', 'action'].includes(p.pickedFor)));
});

await test('random picker: everyone takes turns, the host does not get every genre', async () => {
  const e = env({ PICKER: 'random' });
  const id = await party(e, { answers: { ...hostAnswers, genres: ['family', 'documentary', 'history'] } });
  await post(e, `/api/party/${id}/join`, { mid: DANA, name: 'Dana', answers: { ...hostAnswers, genres: ['romance', 'thriller', 'drama'] } });
  const first = await round(e, id);
  assert.deepEqual(first.data.party.picks.map((p) => p.pickedFor), ['family', 'romance', 'documentary']);
  assert.deepEqual(first.data.party.picks.map((p) => p.pickedByNames), [['you'], ['Dana'], ['you']]);
  const brief = JSON.parse(calls.ember[0].messages[1].content);
  assert.deepEqual(brief.films.map((f) => f.picked_by), [['P1'], ['P2'], ['P1']]);
  assert.match(calls.ember[0].messages[2].content, /Never quote the mood/);
  const danas = await state(e, id, DANA);
  assert.deepEqual(danas.picks.map((p) => p.pickedByNames), [['Gbenga'], ['you'], ['Gbenga']]);
  // The next round, Dana goes first.
  const second = await round(e, id);
  assert.deepEqual(second.data.party.picks.map((p) => p.pickedFor), ['romance', 'family', 'thriller']);
});

await test('random picker: a genre two people share comes first, picked for both', async () => {
  const e = env({ PICKER: 'random' });
  const id = await party(e, { answers: { ...hostAnswers, genres: ['comedy', 'drama'] } });
  await post(e, `/api/party/${id}/join`, { mid: DANA, name: 'Dana', answers: { ...hostAnswers, genres: ['horror', 'drama'] } });
  const { data } = await round(e, id);
  assert.deepEqual(data.party.picks.map((p) => p.pickedFor), ['drama', 'comedy', 'horror']);
  assert.deepEqual(data.party.picks[0].pickedByNames, ['you', 'Dana']);
});

await test('age group: kids get only G or PG and no horror; adults get no family films unless asked', async () => {
  const discover = () => calls.tmdb.filter((c) => c.startsWith('/3/discover')).map((c) => new URL('https://x' + c).searchParams);
  const kids = env({ PICKER: 'random' });
  await round(kids, await party(kids, { answers: { ...hostAnswers, genres: ['comedy'] }, kids: true }));
  assert.ok(discover().every((q) => q.get('certification') === 'G|PG' && q.get('certification_country') === 'US' && q.get('without_genres') === '27'));
  calls.tmdb.length = 0;
  const adults = env({ PICKER: 'random' });
  await round(adults, await party(adults, { answers: { ...hostAnswers, genres: ['comedy'] } }));
  assert.ok(discover().every((q) => q.get('without_genres') === '10751' && !q.get('certification')));
  calls.tmdb.length = 0;
  const asked = env({ PICKER: 'random' });
  await round(asked, await party(asked, { answers: { ...hostAnswers, genres: ['family'] } }));
  assert.ok(discover().every((q) => !q.get('without_genres')), 'someone asked for family films');
});

await test('random picker: films over the time limit are never shown, even if TMDB lets them through', async () => {
  const e = env({ PICKER: 'random' });
  mock.runtime = 140; // TMDB's runtime filter passed them, but the films run long
  const { status } = await round(e, await party(e, { answers: { ...hostAnswers, time: 'medium', genres: ['comedy'] } }));
  assert.equal(status, 404);
  assert.equal(calls.ember.length, 0, 'nothing to explain, nothing spent');
});

await test('random picker: Ember down still shows the three films with TMDB descriptions', async () => {
  const e = env({ PICKER: 'random' });
  mock.ember = 'down';
  const { status, data } = await round(e, await party(e, { answers: { ...hostAnswers, genres: ['drama'] } }));
  assert.equal(status, 200);
  assert.equal(data.party.picks.length, 3);
  assert.ok(data.party.picks.every((p) => p.why && !p.byEmber));
});

await test('random picker: films TMDB cannot load are skipped and failed requests are retried', async () => {
  const e = env({ PICKER: 'random' });
  mock.brokenFilms = (id) => id % 2 === 0; // half the films never load
  const id = await party(e, { answers: { ...hostAnswers, genres: ['comedy'] } });
  mock.tmdbFlaky = 2; // and the next two requests fail
  const { status, data } = await round(e, id);
  assert.equal(status, 200);
  assert.equal(data.party.picks.length, 3);
  assert.ok(data.party.picks.every((p) => Number(p.id) % 2 === 1));
});

await test('agent that searches twice: both searches are in the trace', async () => {
  mock.ember = 'two-searches';
  const e = env();
  const id = await party(e);
  const { data } = await round(e, id);
  assert.equal(data.round.toolCalls, 2);
  const stored = JSON.parse(e.USAGE.map.get(`p:${id}:r:1`));
  const searches = stored.trace.steps.filter((s) => s.tool === 'search_films');
  assert.deepEqual(searches.map((s) => s.args.genres), [['thriller', 'comedy'], ['comedy', 'crime']]);
  assert.ok(searches.every((s) => s.results === 12 && s.tokens === 1000));
});

await test('agent that never stops is cut off after three tool calls and still answers', async () => {
  mock.ember = 'never-stops';
  const e = env();
  const { data } = await round(e, await party(e));
  assert.equal(tools(), 3);
  assert.equal(data.round.toolCalls, 3);
  assert.equal(data.party.picks.length, 3);
  assert.equal(data.round.checks.within_step_limit, true);
});

await test('agent failures fall back to the pipeline and say why', async () => {
  for (const [mode, reason] of [['no-tools', /too few films/], ['bad-args', /too few films/]]) {
    mock.ember = mode;
    const e = env();
    const { status, data } = await round(e, await party(e));
    assert.equal(status, 200, mode);
    assert.match(data.round.fallback, reason, mode);
    assert.equal(data.party.picks.length, 3, mode);
    if (mode === 'bad-args') assert.equal(data.round.checks.tool_calls_valid, false);
  }
});

await test('invented films are dropped and the check records it', async () => {
  mock.ember = 'bad-ids';
  const e = env();
  const { data } = await round(e, await party(e));
  assert.ok(data.party.picks.every((p) => Number(p.id) < 200));
  assert.equal(data.party.picks.length, 3);
  assert.equal(data.round.checks.no_invented_films, false);
  assert.equal(data.round.checks.all_passed, false);
});

await test('non-JSON answers or an Ember outage still give three films', async () => {
  for (const mode of ['garbage', 'down']) {
    mock.ember = mode;
    const e = env();
    const { status, data } = await round(e, await party(e));
    assert.equal(status, 200, mode);
    assert.equal(data.party.picks.length, 3, mode);
    assert.ok(data.party.picks.every((p) => p.byEmber === false && p.why.length > 0), mode);
    if (mode === 'down') assert.equal(data.party.cost.usd, 0, 'an outage costs nothing');
  }
});

await test('every member sees what the round cost; friends pay nothing', async () => {
  const e = env();
  const id = await party(e);
  await post(e, `/api/party/${id}/join`, { mid: DANA, name: 'Dana', answers: hostAnswers }, { ip: '9.9.9.9' });
  await round(e, id);
  assert.equal((await state(e, id, DANA)).cost.usd, 0.00042);
  const danaUsage = (await call(e, '/api/usage', { ip: '9.9.9.9' })).data.usage;
  assert.deepEqual({ used: danaUsage.used, costUsd: danaUsage.costUsd }, { used: 0, costUsd: 0 });
});

await test('films over the time limit fail the check', async () => {
  mock.runtime = 170;
  const e = env();
  const id = await party(e, { answers: { mood: 'gripped', time: 'short', services: [] } });
  const { data } = await round(e, id);
  assert.equal(data.round.checks.within_time_limit, false);
});

await test('AGENT=off runs the pipeline only: one Ember call', async () => {
  const e = env({ AGENT: 'off' });
  const { data } = await round(e, await party(e));
  assert.equal(data.round.variant, 'pipeline');
  assert.deepEqual({ usd: data.party.cost.usd, calls: data.party.cost.calls, agent: data.party.cost.agent }, { usd: 0.00014, calls: 1, agent: false });
  assert.equal(calls.ember.length, 1);
  assert.equal(data.party.picks.length, 3);
});

// ---------------------------------------------------------------- groups

await test('a group: join, shared picks, hidden votes, then the match', async () => {
  const e = env();
  const id = await party(e);
  let s = await state(e, id, DANA);
  assert.deepEqual({ joined: s.joined, hostName: s.hostName, memberCount: s.memberCount, kids: s.kids }, { joined: false, hostName: 'Gbenga', memberCount: 1, kids: false });
  // A guest invited to a family-safe group is told so before answering.
  assert.equal((await state(e, await party(e, { kids: true }), DANA)).kids, true);

  await post(e, `/api/party/${id}/join`, { mid: DANA, name: 'Dana', answers: { mood: 'lighter', time: 'medium', services: [1899] } });
  await post(e, `/api/party/${id}/join`, { mid: SAM, name: 'Sam', answers: { mood: 'gripped', time: 'long', services: [] } });
  assert.equal((await round(e, id, { mid: DANA })).status, 403, 'only the host starts a round');
  const r = await round(e, id);
  assert.equal(r.status, 200);

  s = await state(e, id, DANA);
  assert.deepEqual(s.members.map((m) => [m.name, m.isYou, m.isHost]), [['Gbenga', false, true], ['Dana', true, false], ['Sam', false, false]]);
  assert.deepEqual(s.picks.map((p) => p.id), ['101', '102', '103']);
  assert.deepEqual(s.picks[0].fitsNames, ['Gbenga', 'you', 'Sam']);
  assert.deepEqual(s.picks[1].fitsNames, ['Gbenga']);
  // The film is on Netflix (Gbenga has it) and Max (Dana has it). Each person
  // is shown a service of their own; Sam, with none, sees who does have one.
  const watch = (st) => ({ service: st.picks[0].watch.service, youHave: st.picks[0].watch.youHave, haveNames: st.picks[0].watch.haveNames });
  assert.deepEqual(watch(s), { service: 'Max', youHave: true, haveNames: [] });
  assert.deepEqual(watch(await state(e, id, HOST)), { service: 'Netflix', youHave: true, haveNames: [] });
  assert.deepEqual(watch(await state(e, id, SAM)), { service: 'Netflix', youHave: false, haveNames: ['Gbenga'] });
  assert.equal(s.results, null, 'no peeking before you vote');
  assert.equal(JSON.stringify(s).includes(HOST), false, 'member ids are never sent to other members');

  const yes = (ids) => ['101', '102', '103'].map((p) => ({ id: p, vote: ids.includes(p) ? 'yes' : 'no', reason: ids.includes(p) ? '' : 'seen' }));
  await vote(e, id, HOST, 1, yes(['101', '102']));
  s = (await vote(e, id, DANA, 1, yes(['101', '103']))).data.party;
  assert.equal(s.allVoted, false);
  assert.deepEqual(s.members.map((m) => m.voted), [true, true, false]);
  assert.deepEqual(s.results.map((x) => [x.id, x.yes, x.everyone]), [['101', 2, false], ['102', 1, false], ['103', 1, false]]);

  s = (await vote(e, id, SAM, 1, yes(['101']))).data.party;
  assert.equal(s.allVoted, true);
  assert.deepEqual(s.results.map((x) => [x.id, x.yes, x.of, x.everyone]), [['101', 3, 3, true], ['102', 1, 3, false], ['103', 1, 3, false]]);
});

await test('the group\'s strictest time limit and combined services apply', async () => {
  const e = env();
  const id = await party(e, { answers: { mood: 'gripped', time: 'long', services: [8] } });
  await post(e, `/api/party/${id}/join`, { mid: DANA, name: 'Dana', answers: { mood: 'lighter', time: 'short', services: [1899] } });
  await round(e, id);
  const q = new URL('https://x' + calls.tmdb.find((c) => c.startsWith('/3/discover'))).searchParams;
  assert.equal(q.get('with_runtime.lte'), '90');
  assert.equal(q.get('with_watch_providers'), '8|1899');
});

await test('a second round skips seen films and tells Ember what was rejected', async () => {
  const e = env();
  const id = await party(e);
  await round(e, id);
  await vote(e, id, HOST, 1, [{ id: '101', vote: 'no', reason: 'too-long' }, { id: '102', vote: 'yes' }, { id: '103', vote: 'no', reason: 'seen' }]);
  calls.ember.length = 0;
  const { data } = await round(e, id);
  assert.equal(data.party.round, 2);
  assert.deepEqual(data.party.picks.map((p) => p.id), ['104', '105', '106']);
  const brief = JSON.parse(calls.ember[0].messages[1].content);
  assert.deepEqual(brief.rejected, [{ title: 'Film 101', reason: 'too-long' }, { title: 'Film 103', reason: 'seen' }]);
  assert.deepEqual(brief.liked, ['Film 102']);
  assert.equal(data.party.yourVotes, null, 'new round starts unvoted');
});

await test('someone who joins mid-round waits for the next one', async () => {
  const e = env();
  const id = await party(e);
  await round(e, id);
  await post(e, `/api/party/${id}/join`, { mid: DANA, name: 'Dana', answers: hostAnswers });
  const s = await state(e, id, DANA);
  assert.equal(s.inRound, false);
  const host = (await vote(e, id, HOST, 1, [{ id: '101', vote: 'yes' }])).data.party;
  assert.equal(host.allVoted, true, 'the latecomer does not block the round');
});

await test('group size cap, bad ids and unknown groups', async () => {
  const e = env();
  const id = await party(e);
  for (let i = 0; i < 7; i += 1) await post(e, `/api/party/${id}/join`, { mid: `member${i}`.padEnd(16, 'x'), name: `M${i}`, answers: hostAnswers });
  assert.equal((await post(e, `/api/party/${id}/join`, { mid: 'overflowoverflow', name: 'Extra', answers: hostAnswers })).status, 409);
  assert.equal((await post(e, '/api/party', { mid: 'short', answers: hostAnswers })).status, 400);
  assert.equal((await call(e, '/api/party/zzzzzzzzzz?mid=x')).status, 404);
  assert.equal((await vote(e, id, 'strangerstranger', 1, [])).status, 403);
  const names = await post(e, '/api/party', { mid: HOST, name: '  <b>Very long name that goes on</b>  ', answers: { mood: 'nope', time: 9, services: ['x', 8, -1], genres: ['Comedy', 'nonsense', 'comedy', 'drama', 'horror', 'war'] } });
  const stored = JSON.parse(e.USAGE.map.get(`p:${names.data.party.id}`));
  assert.equal(stored.members[0].name, 'bVery long name that');
  assert.deepEqual(stored.members[0].answers, { mood: 'lighter', time: 'medium', services: [8], genres: ['comedy', 'drama', 'horror'] });
});

// ---------------------------------------------------------------- limits and guards

await test('per-visitor limit: round 11 is refused without calling Ember', async () => {
  const e = env();
  const id = await party(e);
  for (let i = 0; i < 10; i += 1) assert.equal((await round(e, id)).status, 200);
  calls.ember.length = 0;
  const { status, data } = await round(e, id);
  assert.equal(status, 429);
  assert.equal(data.error, 'limit');
  assert.equal(calls.ember.length, 0);
});

await test('request more: five extra rounds, once, with the note kept', async () => {
  const e = env();
  const id = await party(e);
  for (let i = 0; i < 10; i += 1) await round(e, id);
  let r = await post(e, '/api/usage/request', { note: 'rainy sunday' });
  assert.deepEqual({ granted: r.data.granted, left: r.data.usage.left, limit: r.data.usage.limit }, { granted: true, left: 5, limit: 15 });
  assert.equal((await round(e, id)).status, 200);
  r = await post(e, '/api/usage/request', {});
  assert.equal(r.data.granted, false);
  const stored = [...e.USAGE.map.entries()].find(([k]) => k.startsWith('v:'));
  assert.ok(!stored[0].includes('1.1.1.1'), 'raw IP is not stored');
  assert.equal(JSON.parse(stored[1]).note, 'rainy sunday');
});

await test('total daily cap stops everyone', async () => {
  const e = env({ DAILY_ROUND_CAP: '1' });
  assert.equal((await round(e, await party(e))).status, 200);
  const other = await post(e, '/api/party', { mid: DANA, answers: hostAnswers }, { ip: '3.3.3.3' });
  const r = await post(e, `/api/party/${other.data.party.id}/round`, { mid: DANA }, { ip: '3.3.3.3' });
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'busy');
});

await test('human check: required once, then remembered for the day', async () => {
  const e = env({ TURNSTILE_SECRET: 's' });
  const id = await party(e);
  assert.equal((await round(e, id)).status, 403);
  assert.equal((await round(e, id, { turnstileToken: 'bad' })).status, 403);
  assert.equal(calls.ember.length, 0, 'no Ember call before the check passes');
  assert.equal((await round(e, id, { turnstileToken: 'good-token' })).status, 200);
  assert.equal((await round(e, id)).status, 200);
  assert.equal(calls.turnstile.length, 2);
});

await test('hard dollar ceiling: once the budget is reached, Ember is never called again', async () => {
  // Each stand-in round costs $0.00042. Budget $0.0209 minus the $0.02 reserve leaves room for three.
  const e = env({ BUDGET_USD: '0.0209', ROUNDS_PER_DAY: '50' });
  const id = await party(e);
  for (let i = 0; i < 3; i += 1) assert.equal((await round(e, id)).status, 200, `round ${i + 1}`);
  calls.ember.length = 0;
  const { status, data } = await round(e, id);
  assert.equal(status, 429);
  assert.equal(data.error, 'budget');
  assert.equal(calls.ember.length, 0);
  assert.deepEqual(data.budget, { spentUsd: 0.00126, limitUsd: 0.0209 });
  const other = await post(e, '/api/party', { mid: DANA, answers: hostAnswers }, { ip: '7.7.7.7' });
  assert.equal((await post(e, `/api/party/${other.data.party.id}/round`, { mid: DANA }, { ip: '7.7.7.7' })).data.error, 'budget', 'the ceiling is for the whole site');
  assert.equal((await call(e, '/api/usage')).data.budget.spentUsd, 0.00126);
});

await test('money spent on a round that fails still counts against the budget', async () => {
  // The agent searches (and is billed), finds nothing, and the fallback finds nothing either.
  mock.discoverCount = 0;
  const e = env();
  const { status } = await round(e, await party(e));
  assert.equal(status, 404);
  assert.ok(calls.ember.length >= 1);
  const spent = (await call(e, '/api/usage')).data.budget.spentUsd;
  assert.equal(spent, Math.round(calls.ember.length * 0.00014 * 1e5) / 1e5);
  assert.equal([...e.USAGE.map.keys()].filter((k) => k.startsWith('fail:')).length, 1, 'its prompts are kept for the trace');
});

await test('the prompt/token trace exports every Ember call, behind the admin key', async () => {
  const e = env({ ADMIN_KEY: 'secret' });
  const id = await party(e);
  await post(e, `/api/party/${id}/join`, { mid: DANA, name: 'Dana', answers: hostAnswers });
  await round(e, id);
  await round(e, id);
  const get = (path, key) => worker.fetch(new Request(SITE + path, { headers: key ? { Authorization: `Bearer ${key}` } : {} }), e);
  assert.equal((await get('/api/admin/trace')).status, 404);
  assert.equal((await get('/api/admin/trace', 'wrong')).status, 404);
  assert.equal((await worker.fetch(new Request(SITE + '/api/admin/trace', { headers: { Authorization: 'Bearer x' } }), env())).status, 404, 'off when no key is set');

  const data = await (await get('/api/admin/trace', 'secret')).json();
  assert.equal(data.rounds.length, 2);
  assert.equal(data.nextCursor, null);
  const first = data.rounds[0];
  assert.deepEqual({ outcome: first.outcome, variant: first.variant, groupSize: first.groupSize, costUsd: first.costUsd, calls: first.calls.length }, { outcome: 'served', variant: 'agent', groupSize: 2, costUsd: 0.00042, calls: 3 });
  const c = first.calls[0];
  assert.equal(c.model, 'muse-ember-1.0');
  assert.equal(c.request.messages[0].role, 'system');
  assert.deepEqual(c.request.tools, ['search_films', 'get_film']);
  assert.equal(c.response.tool_calls[0].function.name, 'search_films');
  assert.deepEqual({ inputTokens: c.inputTokens, outputTokens: c.outputTokens, costUsd: c.costUsd }, { inputTokens: 900, outputTokens: 100, costUsd: 0.00014 });
  assert.equal(first.calls[2].request.structuredOutput, 'Picks');
  assert.ok(!JSON.stringify(data).includes('Gbenga') && !JSON.stringify(data).includes('Dana'), 'no names in the trace');
  assert.equal(data.budget.spentUsd, 0.00084);
  // Members never receive the prompts.
  assert.ok(!JSON.stringify(await state(e, id, DANA)).includes('"log"'));
});

await test('the wall: first names and places of people who agreed to be shown', async () => {
  const e = env();
  const wall = () => call(e, '/api/wall').then((r) => r.data);
  assert.deepEqual(await wall(), { people: 0, places: 0, recent: [] });

  const austin = { city: 'Austin', country: 'US' };
  const { data } = await post(e, '/api/party', { mid: HOST, name: 'Gbenga Awodokun', answers: hostAnswers, showOnWall: true }, { cf: austin });
  const id = data.party.id;
  await post(e, `/api/party/${id}/join`, { mid: DANA, name: 'dana99 <b>', answers: hostAnswers, showOnWall: true }, { cf: { city: 'Lagos', country: 'NG' } });
  await post(e, `/api/party/${id}/join`, { mid: SAM, name: 'Sam', answers: hostAnswers }, { cf: austin }); // box unticked
  await post(e, `/api/party/${id}/join`, { mid: 'x1x1x1x1x1x1x1x1', name: '12345', answers: hostAnswers, showOnWall: true }, { cf: austin }); // no usable name

  let w = await wall();
  assert.equal(w.people, 2);
  assert.equal(w.places, 2);
  assert.deepEqual(w.recent.map((r) => [r.name, r.place]), [['dana', 'Lagos, NG'], ['Gbenga', 'Austin, US']], 'newest first, first word only, letters only');
  assert.ok(!JSON.stringify(w).includes(DANA) && !JSON.stringify(w).includes('Sam'), 'no ids, and nobody who opted out');

  // The same person again moves to the front without being counted twice.
  await post(e, '/api/party', { mid: HOST, name: 'Gbenga', answers: hostAnswers, showOnWall: true }, { cf: { country: 'GB' } });
  w = await wall();
  assert.deepEqual({ people: w.people, places: w.places, first: w.recent[0].place, shown: w.recent.length }, { people: 2, places: 3, first: 'GB', shown: 2 });
});

await test('waiting-screen posters come from TMDB as links, never as stored files', async () => {
  const { status, data } = await call(env(), '/api/posters');
  assert.equal(status, 200);
  assert.equal(data.length, 14);
  assert.ok(data.every((p) => p.title && p.poster.startsWith('https://image.tmdb.org/t/p/w342/')));
  assert.ok(calls.tmdb[0].startsWith('/3/movie/popular?'));
  // The first three are the home page's tiles and carry their details.
  assert.ok(data.slice(0, 3).every((p) => p.details && p.details.meta.startsWith('2019') && p.details.about));
  assert.equal(data[0].details.watch, 'Included with Netflix, Max');
  assert.ok(data[0].details.trailerUrl.startsWith('https://www.youtube.com/'));
  assert.ok(data.slice(3).every((p) => !p.details && !('id' in p)));
});

await test('requests from other sites are refused', async () => {
  const e = env();
  const id = await party(e);
  assert.equal((await round(e, id, {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await round(e, id, {}, { origin: null })).status, 403);
});

await test('nothing matches: clear error and no round spent', async () => {
  mock.discoverCount = 0;
  const e = env();
  const { status, data } = await round(e, await party(e));
  assert.equal(status, 404);
  assert.equal(data.error, 'no-matches');
  assert.equal(data.usage.left, 10);
});

await test('providers come from TMDB in priority order; the site itself is served', async () => {
  const e = env();
  const list = (await call(e, '/api/providers')).data;
  assert.deepEqual(list.map((p) => p.provider_name), ['Netflix', 'Amazon Prime Video', 'Max']);
  const page = await worker.fetch(req('/'), e);
  assert.match(await page.text(), /Movie Buddy/);
  assert.equal((await call(e, '/api/nope')).status, 404);
});

// ---------------------------------------------------------------- Just me: rate films, then recommend

// A solo party and a taste round. Ratings carry the film's attributes (f),
// as the page sends them back from /api/rate-films.
async function soloParty(e, extra = {}) {
  const { data } = await post(e, '/api/party', { mid: HOST, name: 'Gbenga', answers: { genres: ['thriller'], services: [8] }, solo: true, ...extra });
  return data.party.id;
}
const rated = (filmId, rating, f, title = `Rated ${filmId}`) => ({ filmId, title, genre: 'thriller', rating, f: { g: [53], k: [], d: [], c: [], e: null, ...f } });
const tasteRound = (e, id, taste) => round(e, id, { taste: { ratings: [], unseen: [], dismissed: [], ...taste } });
const subrequests = () => calls.tmdb.length + calls.ember.length;

await test('rate-films: about ten well-known films per genre, none twice, with what taste needs', async () => {
  const e = env();
  const { status, data } = await call(e, '/api/rate-films?genres=thriller,comedy');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(data.films), ['thriller', 'comedy'], 'genres in the order picked');
  const all = [...data.films.thriller, ...data.films.comedy];
  assert.equal(data.films.thriller.length, 10);
  assert.equal(data.films.comedy.length, 10);
  assert.equal(new Set(all.map((f) => f.id)).size, 20, 'no film in two genres');
  const f = all[0];
  for (const field of ['id', 'title', 'year', 'runtime', 'certification', 'poster', 'overview', 'genre']) assert.ok(f[field], field);
  assert.ok(f.f.k.length && f.f.d.length && f.f.c.length && f.f.g.length && f.f.e);
  const q = new URL('https://x' + calls.tmdb.find((c) => c.startsWith('/3/discover'))).searchParams;
  assert.equal(q.get('sort_by'), 'vote_count.desc', 'well known: most voted');
  assert.ok(subrequests() < 50, `subrequests ${subrequests()}`);
  assert.equal((await call(e, '/api/rate-films?genres=nope')).status, 400);
});

await test('rate-films: with kids watching, only films rated G or PG and never horror; adults are not limited', async () => {
  const e = env();
  await call(e, '/api/rate-films?genres=comedy&kids=1');
  const kid = calls.tmdb.filter((c) => c.startsWith('/3/discover')).map((c) => new URL('https://x' + c).searchParams);
  assert.ok(kid.length);
  for (const q of kid) {
    assert.equal(q.get('certification'), 'G|PG');
    assert.equal(q.get('certification_country'), 'US');
    assert.ok(q.get('without_genres').split(',').includes('27'), 'no horror');
  }
  calls.tmdb.length = 0;
  await call(e, '/api/rate-films?genres=comedy');
  const adult = calls.tmdb.filter((c) => c.startsWith('/3/discover')).map((c) => new URL('https://x' + c).searchParams);
  assert.ok(adult.every((q) => !q.get('certification') && !q.get('without_genres')), 'adults rate any well-known film');
});

await test('rate-films: a thin genre (few well-known films) lowers the vote bar; rating more moves past films shown', async () => {
  const e = env();
  mock.thinVotes = 2000; // like documentaries: one film with 2000+ votes
  const { data } = await call(e, '/api/rate-films?genres=documentary');
  assert.equal(data.films.documentary.length, 10);
  const bars = calls.tmdb.filter((c) => c.startsWith('/3/discover')).map((c) => new URL('https://x' + c).searchParams.get('vote_count.gte'));
  assert.deepEqual([...new Set(bars)], ['2000', '300']);
  calls.tmdb.length = 0;
  mock.thinVotes = 0;
  const shown = data.films.documentary.map((f) => f.id);
  const more = await call(e, `/api/rate-films?genres=documentary&exclude=${shown.join(',')}`);
  assert.equal(more.data.films.documentary.length, 10);
  assert.ok(more.data.films.documentary.every((f) => !shown.includes(f.id)));
  assert.ok(calls.tmdb.filter((c) => c.startsWith('/3/discover')).length <= 5);
});

await test('taste round: liked attributes pull a film up, disliked ones push it down, with the reason', async () => {
  const e = env();
  // Film 115 shares the liked film's director and a keyword; 116 shares the disliked film's.
  mock.film = (id) => (id === 115 ? { credits: { crew: [{ id: 777, job: 'Director' }], cast: [] }, keywords: { keywords: [{ id: 55 }] } }
    : id === 116 ? { credits: { crew: [{ id: 888, job: 'Director' }], cast: [] }, keywords: { keywords: [{ id: 66 }] } } : {});
  const id = await soloParty(e);
  const { status, data } = await tasteRound(e, id, { ratings: [
    rated(900, 'like', { d: [777], k: [55] }, 'Liked A'),
    rated(901, 'like', { k: [12345] }, 'Liked B'),
    rated(902, 'dislike', { d: [888], k: [66] }, 'Disliked C'),
  ] });
  assert.equal(status, 200);
  const picks = data.party.picks;
  assert.equal(data.party.justMe, true);
  assert.equal(picks.length, 3);
  assert.equal(picks[0].id, '115');
  assert.equal(picks[0].becauseId, '900');
  assert.equal(picks[0].becauseTitle, 'Liked A');
  assert.ok(!picks.some((p) => p.id === '116'), 'look-alike of a disliked film is not shown');
  assert.ok(picks.every((p) => p.byEmber && p.why && p.backdrop && p.service.name === 'Netflix' && p.watchUrl && p.primaryGenre === 'thriller'));
  const brief = JSON.parse(calls.ember[0].messages[1].content);
  assert.ok(brief.shortlist.length <= 10);
  assert.deepEqual(brief.liked, ['Liked A', 'Liked B']);
  assert.deepEqual(brief.not_for_me, ['Disliked C']);
  assert.equal(calls.ember.length, 1);
  assert.ok(!calls.ember[0].tools);
  assert.equal(data.party.cost.taste, true);
  assert.ok(subrequests() < 50, `subrequests ${subrequests()}`);
  const stored = JSON.parse(e.USAGE.map.get(`p:${id}:r:1`));
  assert.equal(stored.rules.taste, true);
  assert.equal(stored.taste.liked, 2);
  assert.ok(stored.reserve.length > 0);
});

await test('taste round: films rated, swapped away or dismissed are never recommended', async () => {
  const e = env();
  const id = await soloParty(e);
  const { data } = await tasteRound(e, id, { ratings: [rated(101, 'like', { k: [5101] })], unseen: [102, 103], dismissed: [104] });
  const brief = JSON.parse(calls.ember[0].messages[1].content);
  const offered = brief.shortlist.map((c) => c.id);
  [101, 102, 103, 104].forEach((n) => assert.ok(!offered.includes(n), `${n} offered`));
  assert.ok(data.party.picks.every((p) => !['101', '102', '103', '104'].includes(p.id)));
});

await test('taste round: only films on your services; kids get G or PG only; adults no family films', async () => {
  const e = env();
  // Even films are on a service the person does not have; 111 is rated G.
  mock.film = (id) => ({
    ...(id % 2 === 0 ? { 'watch/providers': { results: { US: { flatrate: [{ provider_id: 337, provider_name: 'Disney Plus' }] } } } } : {}),
    ...(id === 111 || id === 113 ? { release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: id === 111 ? 'G' : 'PG' }] }] } } : {}),
  });
  const adults = await tasteRound(e, await soloParty(e), { ratings: [rated(900, 'like', {})] });
  assert.ok(adults.data.party.picks.every((p) => Number(p.id) % 2 === 1), 'all on Netflix');
  const discover = calls.tmdb.filter((c) => c.startsWith('/3/discover')).map((c) => new URL('https://x' + c).searchParams);
  assert.ok(discover.every((q) => q.get('without_genres') === '10751' && q.get('with_watch_providers') === '8' && !q.get('with_runtime.lte')));
  calls.tmdb.length = 0;
  const kids = await tasteRound(e, await soloParty(e, { kids: true }), { ratings: [rated(900, 'like', {})] });
  assert.deepEqual(kids.data.party.picks.map((p) => p.id).sort(), ['111', '113'], 'only the G and PG films, fewer than three');
  assert.ok(calls.tmdb.filter((c) => c.startsWith('/3/discover')).every((c) => new URL('https://x' + c).searchParams.get('certification') === 'G|PG'));
});

await test('taste round: two genres picked, no more than two picks from one genre', async () => {
  const e = env();
  const id = await soloParty(e, { answers: { genres: ['thriller', 'comedy'], services: [8] } });
  const { data } = await tasteRound(e, id, { ratings: [rated(900, 'like', { k: [5101, 5102, 5103, 5104] })] });
  const genres = data.party.picks.map((p) => p.primaryGenre);
  assert.equal(genres.length, 3);
  assert.ok(genres.filter((g) => g === 'thriller').length <= 2 && genres.includes('comedy'), genres.join());
});

await test('taste round: Ember cannot invent films, and Ember down still gives the three best matches', async () => {
  const e = env();
  mock.ember = 'bad-ids';
  const { data } = await tasteRound(e, await soloParty(e), { ratings: [rated(900, 'like', {})] });
  assert.equal(data.party.picks.length, 3);
  assert.ok(!data.party.picks.some((p) => p.id === '999999'));
  assert.equal(data.round.checks.no_invented_films, false);
  mock.ember = 'down';
  const down = await tasteRound(e, await soloParty(e), { ratings: [rated(900, 'like', {})] });
  assert.equal(down.status, 200);
  assert.equal(down.data.party.picks.length, 3);
  assert.ok(down.data.party.picks.every((p) => !p.byEmber && p.becauseTitle));
});

await test('taste round: nothing liked gives popular picks, labelled as such', async () => {
  const e = env();
  const { data } = await tasteRound(e, await soloParty(e), { ratings: [rated(900, 'dislike', {}), rated(901, 'dislike', {})] });
  assert.equal(data.party.picks.length, 3);
  assert.ok(data.party.picks.every((p) => p.popularIn === 'thriller' && !p.becauseTitle));
});

await test('replace: "Not for me" swaps only that card, free, until the matches run out', async () => {
  const e = env();
  mock.discoverCount = 3; // few matches: three picks and a short reserve
  const id = await soloParty(e);
  const first = await tasteRound(e, id, { ratings: [rated(900, 'like', {})] });
  const before = first.data.party.picks.map((p) => p.id);
  const used = first.data.usage.used;
  calls.ember.length = 0;
  const swapped = await post(e, `/api/party/${id}/replace`, { mid: HOST, round: 1, filmId: before[1] });
  assert.equal(swapped.status, 200);
  const after = swapped.data.party.picks.map((p) => p.id);
  assert.equal(after[0], before[0]);
  assert.equal(after[2], before[2]);
  assert.notEqual(after[1], before[1]);
  assert.ok(swapped.data.party.picks[1].becauseTitle);
  assert.equal(calls.ember.length, 0, 'no Ember call');
  assert.equal((await call(e, '/api/usage')).data.usage.used, used, 'no round used');
  let status = 200;
  for (let i = 0; i < 10 && status === 200; i += 1) {
    ({ status } = await post(e, `/api/party/${id}/replace`, { mid: HOST, round: 1, filmId: (await state(e, id, HOST)).picks[0].id }));
  }
  assert.equal(status, 404, 'no-more once the reserve is used up');
  assert.equal((await post(e, `/api/party/${await party(e)}/replace`, { mid: HOST, round: 1, filmId: '1' })).status, 403, 'groups cannot replace');
});

await test('Just me: no mood or time is needed, no runtime cap applies, and nobody can join', async () => {
  const e = env();
  mock.runtime = 200;
  const id = await soloParty(e);
  const { status, data } = await tasteRound(e, id, { ratings: [rated(900, 'like', {})] });
  assert.equal(status, 200);
  assert.equal(data.party.picks.length, 3, 'long films are fine: time is not asked');
  assert.equal((await post(e, `/api/party/${id}/join`, { mid: DANA, name: 'Dana', answers: hostAnswers })).status, 409);
});

// ---------------------------------------------------------------- Just me: sharing

await test('share: a read-only snapshot of the three, free, with no personal details beyond a first name', async () => {
  const e = env();
  const id = await soloParty(e, { name: 'Gbenga Ade' });
  const first = await tasteRound(e, id, { ratings: [rated(900, 'like', {}, 'Liked A')] });
  const used = first.data.usage.used;
  calls.ember.length = 0;
  const made = await post(e, `/api/party/${id}/share`, { mid: HOST, round: 1 });
  assert.equal(made.status, 200);
  assert.match(made.data.url, /^\/s\/[a-z0-9]{8}$/);
  const again = await post(e, `/api/party/${id}/share`, { mid: HOST, round: 1 });
  assert.equal(again.data.id, made.data.id, 'same round, same link');
  const { status, data } = await call(e, `/api/share/${made.data.id}`);
  assert.equal(status, 200);
  assert.equal(data.share.name, 'Gbenga');
  assert.deepEqual(data.share.genres, ['thriller']);
  assert.equal(data.share.picks.length, 3);
  assert.ok(data.share.picks.every((p) => p.title && p.becauseTitle === 'Liked A' && p.watchUrl && p.backdrop));
  const text = JSON.stringify(data.share);
  assert.ok(!text.includes(HOST) && !text.includes('place') && !text.includes('mid'), 'no ids or places');
  assert.equal(calls.ember.length, 0);
  assert.equal((await call(e, '/api/usage')).data.usage.used, used, 'no round used');
  assert.equal((await call(e, '/api/share/zzzzzzzz')).status, 404);
});

await test('share: only the owner of a Just me round, and a swap makes a new snapshot', async () => {
  const e = env();
  const id = await soloParty(e);
  await tasteRound(e, id, { ratings: [rated(900, 'like', {})] });
  assert.equal((await post(e, `/api/party/${id}/share`, { mid: DANA, round: 1 })).status, 403);
  assert.equal((await post(e, `/api/party/${id}/share`, { mid: HOST, round: 2 })).status, 400);
  const group = await party(e);
  await round(e, group);
  assert.equal((await post(e, `/api/party/${group}/share`, { mid: HOST, round: 1 })).status, 403);
  const before = (await post(e, `/api/party/${id}/share`, { mid: HOST, round: 1 })).data.id;
  const picks = (await state(e, id, HOST)).picks;
  await post(e, `/api/party/${id}/replace`, { mid: HOST, round: 1, filmId: picks[0].id });
  const after = (await post(e, `/api/party/${id}/share`, { mid: HOST, round: 1 })).data.id;
  assert.notEqual(after, before);
  const titles = (await call(e, `/api/share/${after}`)).data.share.picks.map((p) => p.title);
  assert.ok(!titles.includes(picks[0].title), 'the swapped-out film is not in the new snapshot');
});

await test('share page: /s/<id> is the site with link-preview tags; an unknown id is the plain page', async () => {
  const e = env();
  const id = await soloParty(e, { name: 'Dana "<b>"' });
  await tasteRound(e, id, { ratings: [rated(900, 'like', {})] });
  const shareId = (await post(e, `/api/party/${id}/share`, { mid: HOST, round: 1 })).data.id;
  const page = await worker.fetch(req(`/s/${shareId}`), e);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<base href="\/">/);
  assert.match(html, /<meta property="og:title" content="Dana&#39;s three for tonight: Film \d+, Film \d+, Film \d+">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/image\.tmdb\.org\/t\/p\/w780\/b\d+\.jpg">/);
  assert.match(html, /summary_large_image/);
  assert.match(html, /<script src="app\.js"><\/script>/);
  const plain = await (await worker.fetch(req('/s/abcdefgh'), e)).text();
  assert.ok(!plain.includes('og:title'));
  assert.match(plain, /Movie Buddy/);
});

await test('share: at most 30 new links a day from one visitor', async () => {
  const e = env();
  const id = await soloParty(e);
  await tasteRound(e, id, { ratings: [rated(900, 'like', {})] });
  const key = [...e.USAGE.map.keys()].find((k) => k.startsWith('v:'));
  const record = JSON.parse(e.USAGE.map.get(key));
  e.USAGE.map.set(key, JSON.stringify({ ...record, shares: 30 }));
  assert.equal((await post(e, `/api/party/${id}/share`, { mid: HOST, round: 1 })).status, 429);
});

console.log(`\n${passed} tests passed`);
