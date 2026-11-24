# Movie Buddy

An agent, built on Muse Ember, that helps a group of friends agree on a film
across the streaming services they have between them.

One person sends a link. Everyone adds their mood, how long they have and their
services. The agent searches TMDB for films that fit the group, each person
votes in private, and the page shows where everyone agrees. One person alone is
a group of one, so there is a single path.

```
public/          the site (HTML, CSS, JavaScript, no build step)
src/worker.js    the API: the agent, groups, TMDB, limits, budget, trace
scripts/         export of the prompt/token trace
wrangler.jsonc   Cloudflare configuration
test/            tests and a local server that need no keys
```

## Hackathon disclosure

Built for the Meta Muse Ember Hackathon (build window Nov 23 to Dec 2, 2026).

- Before the window, on Nov 20, the idea was explored and a throwaway
  prototype was made. None of that prototype's files are in this repository.
- Every file here was written on or after Nov 23, inside the build window.
  The design and screen flow worked out in the prototype were re-implemented.
- No film artwork is stored in this repository. Posters are loaded from TMDB
  at run time under TMDB's terms; sample mode uses invented titles with no
  images.

[EDIT BEFORE SUBMITTING: say here which tools you built with, in your own
words, and check the two statements above against your git history.]

## Try it with no keys

```
npm test         # 29 tests against stand-in services
npm run local    # the whole site on http://localhost:8790
```

Open the local site in two browser windows to try a group. Opening
`public/index.html` straight from disk also works: with no server it switches
to sample mode (solo only, three invented stand-in titles) and says so at the
top.

## Deploy

You need a Cloudflare account, a Meta Model API key and a TMDB "API Read
Access Token" (the long one, not the short v3 key).

```
npm install
npx wrangler login

# 1. Storage for groups and usage counters. Paste the id it prints into wrangler.jsonc.
npx wrangler kv namespace create USAGE

# 2. Keys. Each command prompts for the value; nothing is written to disk.
npx wrangler secret put MODEL_API_KEY
npx wrangler secret put TMDB_TOKEN
npx wrangler secret put VISITOR_SALT      # any long random string
npx wrangler secret put ADMIN_KEY         # another one; unlocks the trace export

# 3. Ship it.
npx wrangler deploy
```

Wrangler prints the site's address when it finishes.

For local development with real keys, copy `.dev.vars.example` to `.dev.vars`,
fill it in, and run `npm run dev`.

## Turn on the human check (recommended before sharing the link)

1. In the Cloudflare dashboard, open Turnstile and add a widget for your site's
   address. You get a site key and a secret key.
2. `npx wrangler secret put TURNSTILE_SECRET` and paste the secret key.
3. Put the site key in `TURNSTILE_SITE_KEY` at the top of `public/app.js`.
4. `npx wrangler deploy`.

Do both steps 2 and 3 together. With only the secret set, every round is
refused; with only the site key set, the check is shown but not enforced.

## How a round works

Everyone answers four questions: mood, genres (up to three, or skip), how long
they have, and their streaming services. The host also says whether kids are
watching.

By default (`PICKER` is `"random"` in `wrangler.jsonc`):

1. The Worker takes the genres people picked, taking turns: a genre two or
   more people share comes first, then each person's first genre, then each
   person's second, and so on. Who goes first moves along each round, so the
   host does not always lead. If nobody picked any, it uses genres that suit
   the group's mood.
2. For each of three slots it draws one film **at random** from TMDB's 200 most
   popular matches in that genre released in the **last two years**, with at
   least 50 votes and a rating of 5.5 or more. So the same few hits do not come
   back every time.
3. Every rule is applied in code: the shortest time anyone has (90 minutes,
   about 2 hours or all evening; each film's real running time is checked),
   the age group, and the group's services. If a genre finds nothing, the draw
   loosens step by step: any service, then five years, then any genre.
   - **Kids watching:** only films rated exactly G or PG in the US, never
     horror. ("PG or lower" is not used: TMDB ranks unrated films below G.)
   - **Adults only:** no family films, unless someone picked the family genre.
4. One Ember call recommends the three films to the group: what each is, why
   it is worth watching, and whose genres or mood it fits. Ember cannot swap
   the films. If Ember is down, TMDB's own descriptions are shown.

Each card says whose genre it was drawn for ("Your thriller pick", "Segun's
drama pick", "A comedy pick for you and Segun").

Set `PICKER` to `"agent"` to use the search agent described below instead.

### The search agent (`PICKER: "agent"`)

1. The host asks for a round. The Worker gathers every member's answers and
   what the group already voted on.
2. **The agent loop.** Ember is given two tools and decides what to do:
   - `search_films`: a TMDB search with genres, runtime, years and sort order
     that Ember chooses.
   - `get_film`: one title's runtime, description and services.
   It may make at most three tool calls. The Worker runs each call.
3. **The final answer.** Meta's API only supports `tool_choice: "auto"`, so the
   Worker ends the loop with a separate call that has no tools and a JSON
   schema. Ember returns three film ids, a reason for each, and who each suits.
4. The Worker keeps only films a tool actually returned, loads poster, runtime,
   trailer and where-to-watch from TMDB, and stores the round.

Searches cover films from the last five years, loosened before reaching back
up to ten.

## Tracing and checks

Every round is stored for 30 days with its trace: each tool call, its
arguments, how many films came back, tokens and time, and whether the fallback
ran. Each member's votes are stored beside it. Together they are the
evaluation log.

Eight instruction checks run in code on every round and are stored with it:
searched before answering, within the step limit, valid tool calls, no invented
films, three picks from Ember, reasons of 30 words or fewer, within the time
limit, within the token ceiling.

`npm run trace` exports them along with the prompts.

## Cost per round

Every round's cost is worked out from the token counts Meta reports, at Muse
Ember's list prices, and shown to the whole group under the cards and the
result. The usage screen shows the visitor's total for the day.

The prices are constants at the top of `src/worker.js` (`PRICE_PER_MILLION`).
It is an estimate, not a bill: cached input is priced at the cached rate only
if Meta reports cached tokens in the `usage.prompt_tokens_details` field, which
is unconfirmed. Compare against Meta's dashboard after the first real rounds.

## The waiting screen

While the agent works, a strip of TMDB's current popular films (US) drifts
past, and the first three appear on the home page with their details.
`GET /api/posters` asks TMDB's `/movie/popular` for the list and passes on
image links; the browser loads the pictures from TMDB. No artwork is stored in
this project. Until the list arrives, or if TMDB fails, the home page shows no
films rather than placeholders.

## Who is using it

The home page shows a count and a small card that cycles through recent
visitors: first name, city and country, and how long ago.

- Everyone is asked for a first name. A ticked box on that screen says the
  name and city will be shown on the home page; unticking it keeps them off.
- Kept: the first word of the name (letters only) and the city and country
  Cloudflare derives from the connection. No IP address, nothing about films.
- The newest 24 people are shown. `GET /api/wall` serves the list.
- There is no filter for rude names. To clear the list, delete the `wall` key:
  `npx wrangler kv key delete wall --binding USAGE --remote`

## The $10 budget

Going over $10 disqualifies an entry, usage during judging counts, and Meta's
spend alert only sends an email. So the Worker enforces its own ceiling:

- `BUDGET_USD` in `wrangler.jsonc` (default `8.00`) is the most the whole site
  may ever spend on Muse Ember. Before each round the Worker checks its running
  total, and once the ceiling is reached Ember is never called again.
- Money spent on rounds that fail is counted too.
- The usage screen shows the total spent and the ceiling to every visitor.

What the ceiling does not know: anything spent on the same Meta account
outside this site, such as Muse Code or tests with curl. Lower `BUDGET_USD` by
that amount. The total is an estimate at list prices and is kept in a store
with no atomic counter, so leave a margin; do not set it to 10.

## Proof of usage

The submission needs a prompt/token trace and a Usage-page screenshot.

```
ADMIN_KEY=... npm run trace -- https://your-site.workers.dev
```

writes `trace.json`: every Ember call the site made, with the full prompt, the
reply, token counts and estimated cost, plus totals. Rounds are kept 30 days.
People appear in prompts only as P1, P2; there are no names in the trace.

For the screenshot, open Meta's Usage page, set Nov 23 to Dec 2 and filter to
Muse Ember.

## Limits

Set in `wrangler.jsonc` under `vars`:

| Setting | Default | Meaning |
|---|---|---|
| `ROUNDS_PER_DAY` | 10 | rounds each visitor may start per day |
| `EXTRA_ROUNDS` | 5 | granted once a day when a visitor asks |
| `DAILY_ROUND_CAP` | 400 | rounds for all visitors together per day |

A group's round is charged to the host. Joining and voting are free. A group
holds at most 8 people and lasts two days.

A round request passes six checks before Ember is called: same-site origin,
the edge rate limit, the host's daily limit, the total daily cap, the dollar
ceiling, and the human check. A visitor's round is only counted when it
succeeds.

Visitors are counted by a hash of their IP address, so people behind one
address share an allowance.

## Before you rely on it

- The Worker has been tested against stand-ins, not the live TMDB, Meta or
  Cloudflare services. Run one real round after deploying and check the logs
  with `npx wrangler tail`.
- Groups are stored in Workers KV, which is eventually consistent and has no
  locking. Two friends joining in the same instant can overwrite each other;
  votes are stored per person and are safe. The free plan allows 1,000 writes
  a day, and a three-person round uses about seven. For heavier use, move
  groups to a Durable Object or D1.
- The page learns about changes by asking every four seconds. Friends see a
  new round within a few seconds, not instantly.
- A round with the agent is two to four Ember calls. Measure real tokens per
  round before trusting any cost estimate.
- Films only, United States only. "All your services" means the services TMDB
  and JustWatch list for the US.
- Keep the TMDB and JustWatch credits in the footer; TMDB requires both.
