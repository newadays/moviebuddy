// The real Worker on a local port, wired to stand-ins for TMDB, Muse Ember and
// Turnstile. Lets you click through the whole site, groups included, with no
// keys and no spend:
//
//   node test/dev-server.mjs            then open http://localhost:8790
//
// Settings can be overridden from the environment, for example
//   ROUNDS_PER_DAY=3 AGENT=off BUDGET_USD=0.05 node test/dev-server.mjs
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';
import { makeKV, makeAssets, installFetchMock } from './mocks.mjs';

installFetchMock();

const env = {
  USAGE: makeKV(),
  ASSETS: makeAssets(fileURLToPath(new URL('../public', import.meta.url))),
  TMDB_TOKEN: 'stand-in',
  MODEL_API_KEY: 'stand-in',
  ADMIN_KEY: process.env.ADMIN_KEY || 'local-admin',
};
for (const name of ['ROUNDS_PER_DAY', 'EXTRA_ROUNDS', 'DAILY_ROUND_CAP', 'BUDGET_USD', 'AGENT']) {
  if (process.env[name]) env[name] = process.env[name];
}

const port = Number(process.env.PORT) || 8790;

createServer(async (incoming, outgoing) => {
  // Turn Node's request into the web Request the Worker expects.
  const body = [];
  for await (const chunk of incoming) body.push(chunk);
  const headers = new Headers(incoming.headers);
  headers.set('CF-Connecting-IP', incoming.socket.remoteAddress || 'local');
  const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
    method: incoming.method,
    headers,
    body: body.length ? Buffer.concat(body) : undefined,
  });

  // Cloudflare attaches the visitor's city and country. Locally, stand in
  // with a few made-up places, one per browser, so the home-page card has
  // something to show.
  const places = [['Austin', 'US'], ['Lagos', 'NG'], ['London', 'GB'], ['Toronto', 'CA']];
  const [city, country] = places[(incoming.headers['user-agent'] || '').length % places.length];
  Object.defineProperty(request, 'cf', { value: { city, country } });

  const response = await worker.fetch(request, env);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => {
  console.log(`Movie Buddy with stand-in services: http://localhost:${port}`);
});
