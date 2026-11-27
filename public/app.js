/*
 * Movie Buddy: the page script. Plain JavaScript, no build step.
 *
 * An agent that helps a group of friends agree on a film. One person is a
 * group of one, so solo and group use share one path:
 *
 *   home -> your answers -> (invite friends) -> the agent picks three
 *        -> everyone swipes -> where you agree -> tonight's film
 *
 * The page talks to the Worker in src/worker.js through /api. The Worker holds
 * the keys, runs the agent, stores the group and enforces the usage limits.
 *
 * If no server answers (opening index.html straight from disk, or a static
 * preview), the page falls back to SAMPLE MODE: solo only, three built-in
 * titles, a counter kept in the browser, and a visible notice.
 */

// Turnstile site key (public, safe to ship). Leave empty to skip the human
// check, which is what you want until TURNSTILE_SECRET is set on the Worker.
const TURNSTILE_SITE_KEY = '';

// The address friends should open. Leave empty to use wherever this page is
// hosted; set it if the site is embedded somewhere with a different address.
const SITE_URL = '';

const API_BASE = '/api';
const POLL_MS = 4000; // how often a waiting screen checks on the group

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const MOODS = [
  { id: 'lighter', label: 'Lighter' },
  { id: 'gripped', label: 'Gripped' },
  { id: 'moved', label: 'Moved' },
  { id: 'amazed', label: 'Amazed' },
];

// Genres a person can pick (up to MAX_GENRES), by the names the agent uses.
// Listed so the ones that suit each mood come first.
const GENRES = [
  { id: 'comedy', label: 'Comedy' }, { id: 'action', label: 'Action' }, { id: 'thriller', label: 'Thriller' },
  { id: 'drama', label: 'Drama' }, { id: 'romance', label: 'Romance' }, { id: 'science fiction', label: 'Sci-fi' },
  { id: 'horror', label: 'Horror' }, { id: 'animation', label: 'Animation' }, { id: 'adventure', label: 'Adventure' },
  { id: 'crime', label: 'Crime' }, { id: 'mystery', label: 'Mystery' }, { id: 'fantasy', label: 'Fantasy' },
  { id: 'family', label: 'Family' }, { id: 'documentary', label: 'Documentary' }, { id: 'history', label: 'History' },
  { id: 'music', label: 'Music' }, { id: 'war', label: 'War' }, { id: 'western', label: 'Western' },
];
const MAX_GENRES = 3;

// Just me: rate films, then recommend from what you liked.
// The order of these steps is one list, so the kids question can move.
const SOLO_STEPS = ['genres', 'rate', 'services', 'kids'];
const RATE_PER_GENRE = 3; // films rated from each picked genre, per batch
const MAX_SWAPS = 6; // "Haven't seen it" per genre before you rate what is shown

const ICON_UP = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0 4-7a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.3 21H7"/></svg>';
const ICON_DOWN = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(180 12 12)"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0 4-7a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.3 21H7"/></g></svg>';
const ICON_CHECK = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const GENRE_LABEL = Object.fromEntries(GENRES.map((g) => [g.id, g.label.toLowerCase()]));
const GENRE_NAME = Object.fromEntries(GENRES.map((g) => [g.id, g.label]));
const MOOD_FIRST = {
  lighter: ['comedy', 'romance', 'animation', 'family', 'adventure'],
  gripped: ['thriller', 'crime', 'mystery', 'action', 'horror'],
  moved: ['drama', 'romance', 'history', 'documentary', 'music'],
  amazed: ['science fiction', 'fantasy', 'adventure', 'animation', 'action'],
};

const TIMES = [
  { id: 'short', label: 'Under 90 minutes' },
  { id: 'medium', label: 'About 2 hours' },
  { id: 'long', label: 'All evening' },
];

// Shown until the real list arrives from TMDB (GET /api/providers), and in
// sample mode. The ids are TMDB provider ids; confirm them against that list.
let services = [
  { id: 8, label: 'Netflix', logo: '' },
  { id: 9, label: 'Prime Video', logo: '' },
  { id: 337, label: 'Disney+', logo: '' },
  { id: 1899, label: 'Max', logo: '' },
  { id: 15, label: 'Hulu', logo: '' },
  { id: 350, label: 'Apple TV+', logo: '' },
];

const REASONS = [
  { id: 'seen', label: 'Seen it' },
  { id: 'not-tonight', label: 'Not tonight' },
  { id: 'too-long', label: 'Too long' },
  { id: 'not-my-thing', label: 'Not my kind of thing' },
];

// Sample mode only: invented stand-ins with no artwork, so the page can be
// tried with no server. The live site gets its films and posters from TMDB
// and its reasons from Muse Ember.
const SAMPLE_PICKS = [
  {
    id: 's1', title: 'Sample film one', meta: 'Sample · Thriller', poster: '',
    why: 'A stand-in so you can try the cards without a server. On the live site this is a real film chosen by the agent.',
    byEmber: false, fitsNames: [], trailerUrl: '',
    watch: { type: 'subscription', service: 'Netflix', providerId: 8, url: '' },
  },
  {
    id: 's2', title: 'Sample film two', meta: 'Sample · Comedy', poster: '',
    why: 'Another stand-in. Swipe right if you would watch it, left if not, to see how voting works.',
    byEmber: false, fitsNames: [], trailerUrl: '',
    watch: { type: 'subscription', service: 'Prime Video', providerId: 9, url: '' },
  },
  {
    id: 's3', title: 'Sample film three', meta: 'Sample · Adventure', poster: '',
    why: 'A third stand-in, shown as a film that no subscription carries, to demonstrate the rent-or-buy label.',
    byEmber: false, fitsNames: [], trailerUrl: '',
    watch: { type: 'rent', service: 'a digital store', url: '' },
  },
];

// ---------------------------------------------------------------------------
// Talking to the Worker
// ---------------------------------------------------------------------------

let sampleMode = false; // true once we learn there is no server behind this page
let remoteUsage = null; // the server's count of this visitor's rounds
let posters = []; // [{ title, poster, backdrop, details? }] TMDB's popular films: home tiles, waiting screen
let wall = null; // { people, places, recent: [{ name, place, at }] } from the server
// When each visitor row's fade began (ms), keyed by what the row says, so a
// re-render continues a fade instead of restarting it, and a finished row
// stays faded until its data changes.
const fadeStarts = new Map();
let remoteBudget = null; // what the whole site has spent on Muse Ember, and its ceiling

// Resolves to { status, data }; throws only when there is no Worker at all
// (network failure, or a reply that is not JSON).
async function api(path, body) {
  const options = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined;
  const res = await fetch(API_BASE + path, options);
  const type = res.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) throw new Error('no-server');
  const data = await res.json();
  if (data && data.usage) remoteUsage = data.usage;
  if (data && data.budget) remoteBudget = data.budget;
  return { status: res.status, data };
}

// Turnstile: a token proving a person is here. Asked for once; the Worker
// remembers a verified visitor for the day.
let humanVerified = false;

function humanToken() {
  if (!TURNSTILE_SITE_KEY || humanVerified) return Promise.resolve('');
  return new Promise((resolve) => {
    const finish = (token) => resolve(token || '');
    const timer = setTimeout(() => finish(''), 15000);
    const show = () => {
      const box = document.getElementById('human-check');
      if (!box) return finish('');
      box.innerHTML = '';
      window.turnstile.render(box, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token) => { clearTimeout(timer); finish(token); },
        'error-callback': () => { clearTimeout(timer); finish(''); },
      });
    };
    if (window.turnstile) return show();
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = show;
    script.onerror = () => { clearTimeout(timer); finish(''); };
    document.head.appendChild(script);
  });
}

// Streaming services and their logos come from TMDB, so nobody has to source
// or redraw them. If the call fails the built-in six stay.
async function loadServices() {
  if (sampleMode) return;
  try {
    const { data } = await api('/providers');
    if (Array.isArray(data) && data.length) {
      services = data.map((p) => ({
        id: p.provider_id,
        label: p.provider_name,
        logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : '',
      }));
    }
  } catch (err) {
    /* keep the defaults */
  }
}

// Posters shown while the agent works. They are loaded from TMDB when the
// page opens, so they are already in the browser by the time they are needed.
async function loadPosters() {
  if (sampleMode) return;
  try {
    // The version tag gets past any copy a browser kept from before the
    // list changed shape; bump it whenever /api/posters does.
    const { status, data } = await api('/posters?v=3');
    if (status !== 200 || !Array.isArray(data)) return;
    posters = data;
    posters.forEach((p) => { new Image().src = p.poster; });
    posters.slice(0, 3).forEach((p) => { if (p.backdrop) new Image().src = p.backdrop; });
  } catch (err) {
    /* the waiting screen works without them */
  }
}

// ---------------------------------------------------------------------------
// Usage allowance
//
// The Worker counts rounds and sends the numbers back with every reply. The
// browser copy below is used only in sample mode, where nothing is at stake.
// ---------------------------------------------------------------------------

const ROUNDS_PER_DAY = 10;
const EXTRA_ROUNDS = 5;
const TOKENS_PER_ROUND = 3000;
const USAGE_KEY = 'moviebuddy.usage';

const today = () => new Date().toISOString().slice(0, 10);
const freshUsage = () => ({ day: today(), used: 0, extra: 0, requested: false, tokens: 0 });

function readStore(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value === null ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    /* storage can be blocked; the page works without it */
  }
}

let localUsage = readStore(USAGE_KEY, null);
if (!localUsage || localUsage.day !== today()) localUsage = freshUsage();

function usageNow() {
  if (remoteUsage && !sampleMode) return remoteUsage;
  if (localUsage.day !== today()) localUsage = freshUsage();
  const limit = ROUNDS_PER_DAY + localUsage.extra;
  return {
    perDay: ROUNDS_PER_DAY, extraRounds: EXTRA_ROUNDS, limit,
    used: localUsage.used, left: Math.max(0, limit - localUsage.used),
    tokens: localUsage.tokens, requested: localUsage.requested,
  };
}

async function requestMore(note) {
  if (!sampleMode) {
    try {
      const { data } = await api('/usage/request', { note });
      return { granted: !!data.granted, extra: data.extra };
    } catch (err) {
      sampleMode = true;
    }
  }
  if (localUsage.requested) return { granted: false };
  localUsage.requested = true;
  localUsage.extra += EXTRA_ROUNDS;
  writeStore(USAGE_KEY, localUsage);
  return { granted: true, extra: EXTRA_ROUNDS };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const SAVED_KEY = 'moviebuddy.saved'; // titles saved for later, this browser only
const PARTY_KEY = 'moviebuddy.party'; // which group this browser belongs to
const PROFILE_KEY = 'moviebuddy.profile'; // who uses this browser: { id, name, showMe }
let saved = readStore(SAVED_KEY, []);

// The person on this device. Kept in the browser so a returning visitor is
// not asked their name again and is counted once, not once per visit.
let profile = readStore(PROFILE_KEY, null) || {};
if (!/^[a-z0-9]{16}$/.test(profile.id || '')) {
  profile = { id: newId(16), name: '', showMe: true };
  writeStore(PROFILE_KEY, profile);
}

const state = {
  // home | name | mood | time | services | kids | lobby | loading | deck |
  // reason | results | tonight | usage | gone
  screen: 'home',
  mode: 'solo', // solo | host | guest
  name: profile.name || '',
  showMe: profile.showMe !== false, // show first name and city on the home page
  askName: !profile.name, // false once this device has given a name
  answers: { mood: '', genres: [], time: '', services: [] },
  kids: false,
  partyId: '',
  mid: '',
  party: null, // the group as the server last described it
  roundShown: 0, // the round this browser is swiping on or has finished
  index: 0,
  votes: [], // this person's votes on the current round, in progress
  chosenId: null,
  share: null, // { url, text, note } while a share panel is open
  notice: '', // one-off message shown at the top of the next screen
  usageFrom: 'home',
  usageNote: '',
  hostName: '',
  makeOwn: false, // home page: the "Pick your own" choices are open
  filmOpen: -1, // home page: which film tile has its details open (tap or click)
  taste: null, // Just me: the films to rate and the ratings given (see newTaste)
  shared: null, // a shared three opened from /s/<id>: { id, share } or { id, gone: true }
};

// Just me: everything the rating step keeps.
function newTaste() {
  return {
    pools: {}, // genre -> films fetched to rate, in order
    slots: [], // [{ genre, film, rating: 'like' | 'dislike' | null }] in the order shown
    at: 0, // the slot being rated
    swaps: {}, // genre -> "Haven't seen it" used
    unseen: [], // films swapped away: never recommended back as new
    dismissed: [], // results marked "Not for me"
    noLikes: 0, // batches rated with nothing liked
    more: false, // rating more from the results: go straight to a new round
    loading: false,
    error: '',
    message: '',
  };
}
state.taste = newTaste();

function newId(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function reset(screen, keepAddress) {
  stopPolling();
  Object.assign(state, {
    screen, mode: 'solo', answers: { mood: '', genres: [], time: '', services: [] }, kids: false,
    partyId: '', mid: '', party: null, roundShown: 0, index: 0, votes: [],
    chosenId: null, share: null, hostName: '', askName: !profile.name, makeOwn: false, filmOpen: -1,
    taste: newTaste(),
  });
  if (location.hash && !keepAddress) history.replaceState(null, '', location.pathname + location.search);
  // Leaving a shared page: back to the site's own address, so a reload does not reopen it.
  if (/^\/s\//.test(location.pathname)) history.replaceState(null, '', '/');
}

// The questions each kind of visitor is asked, in order.
function steps() {
  // The name is asked once per device. Sample mode has no server to send it to.
  const name = state.askName && !(sampleMode && state.mode === 'solo') ? ['name'] : [];
  if (state.mode === 'solo') return [...name, ...SOLO_STEPS];
  const kids = state.mode === 'guest' ? [] : ['kids'];
  return [...name, 'mood', 'genres', 'time', 'services', ...kids];
}

// Just me: a round from the films rated (not the group's random picker).
const justMe = () => !!state.party && !!state.party.justMe;

const picks = () => (state.party ? state.party.picks : []);
const currentPick = () => picks()[state.index];
const isGroup = () => !!state.party && !state.party.solo;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const app = document.getElementById('app');
const startOverButton = document.getElementById('start-over');
const meterButton = document.getElementById('meter');

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// "Dana", "Dana and Sam", "Dana, Sam and Lee"
// Whose genre a film was drawn for: "Your thriller pick", "Segun's drama
// pick", "A comedy pick for you and Segun", or for the group's mood.
function pickLabel(pick) {
  if (pick.pickedFor === 'any') return 'A recent surprise';
  const genre = (GENRE_LABEL[pick.pickedFor] || pick.pickedFor).toLowerCase();
  const by = pick.pickedByNames || [];
  if (!by.length) return isGroup() ? `A ${genre} pick for the group's mood` : `A ${genre} pick for your mood`;
  if (by.length === 1) return by[0] === 'you' ? `Your ${genre} pick` : `${by[0]}'s ${genre} pick`;
  return `A ${genre} pick for ${listNames(by)}`;
}

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function inviteLink() {
  return `${SITE_URL || (location.origin + location.pathname)}#party-${state.partyId}`;
}

// A film's poster, or a plain titled block when there is none.
function posterHtml(pick, alt) {
  if (pick.poster) return `<img src="${esc(pick.poster)}" alt="${esc(alt)}" draggable="false">`;
  return `<div class="poster-blank"${alt ? ` role="img" aria-label="${esc(alt)}"` : ' aria-hidden="true"'}><span>${esc(pick.title)}</span></div>`;
}

// One plain sentence on where to watch, and who in the group has that service.
function watchInfo(pick) {
  const w = pick.watch;
  if (!w) return { headline: 'Where to watch is not known yet', note: '' };
  if (w.type === 'rent') return { headline: `Rent or buy on ${w.service}`, note: 'Not included with any subscription yet.' };

  const youHave = w.providerId ? state.answers.services.includes(w.providerId) : !!w.youHave;
  const others = w.haveNames || [];
  let note;
  if (youHave && others.length) note = `You and ${listNames(others)} have this.`;
  else if (youHave) note = 'You have this.';
  else if (others.length) note = `${listNames(others)} ${others.length > 1 ? 'have' : 'has'} this.`;
  else note = isGroup() ? 'Nobody in the group has this.' : 'Not one of the services you chose.';
  return { headline: `Included with ${w.service}`, note };
}

// The "why, where, and where it came from" block shown with every pick.
function detailsBlock(pick) {
  const watch = watchInfo(pick);
  const fits = pick.fitsNames || [];
  const fitsLine = isGroup() && fits.length
    ? `<span class="small"><strong>Suits:</strong> ${esc(listNames(fits))}</span>`
    : '';
  const source = sampleMode
    ? 'An invented sample. On the live site, films come from TMDB and streaming availability from JustWatch.'
    : pick.byEmber
    ? 'Title and poster from TMDB. Streaming availability from JustWatch. Chosen and explained by the Movie Buddy agent, built on Muse Ember.'
    : 'Title, poster and description from TMDB. Streaming availability from JustWatch.';
  return `
    <div class="detail">
      <span class="label">${pick.byEmber ? 'Why this pick' : 'About this title'}</span>
      <p>${esc(pick.why)}</p>
      ${fitsLine}
    </div>
    <div class="detail">
      <span class="label">Where to watch</span>
      <p><strong>${esc(watch.headline)}</strong></p>
      ${watch.note ? `<span class="small muted">${esc(watch.note)}</span>` : ''}
    </div>
    <div class="detail">
      <span class="label">Where this came from</span>
      <span class="small muted">${source}</span>
    </div>`;
}

// Small amounts of money, readable: $0.0004 rather than 4e-4.
function money(usd) {
  if (!usd) return '$0';
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

// What the agent's search for this round cost. Everyone in the group sees it.
function costLine() {
  const c = state.party && state.party.cost;
  if (!c || sampleMode) return '';
  if (!c.calls) return '<p class="cost small muted">This round used no Muse Ember calls.</p>';
  const how = c.taste
    ? 'films scored against the ones you rated, the final three chosen by the agent'
    : c.random
    ? 'three films drawn at random from your genres, explained by the agent'
    : c.agent
      ? `${c.searches} ${c.searches === 1 ? 'search' : 'searches'} by the agent`
      : 'one-step fallback';
  return `<p class="cost small muted">This round: ${how}, ${c.calls} Muse Ember ${c.calls === 1 ? 'call' : 'calls'}, ${c.tokens.toLocaleString('en-US')} tokens, about <strong>${money(c.usd)}</strong>${c.estimated ? ' (estimated)' : ''}.</p>`;
}

function sharePanel() {
  if (!state.share) return '';
  // The phone's own share sheet (Messages, WhatsApp...) where the browser has one.
  const native = navigator.share
    ? '<button type="button" class="button" data-action="native-share">Send with an app</button>'
    : '';
  return `
    <div class="share-box" role="group" aria-label="Invite friends">
      <p class="small" style="margin:0">${esc(state.share.text)}</p>
      <input id="share-link" type="text" readonly aria-label="Invite link" value="${esc(state.share.url)}">
      <div class="row">
        <button type="button" class="button button--primary" data-action="copy-link">Copy link</button>
        ${native}
      </div>
      <span class="small muted" role="status">${esc(state.share.note)}</span>
    </div>`;
}

function membersList() {
  const rows = state.party.members.map((m) => {
    const tags = [m.isYou ? 'you' : '', m.isHost ? 'host' : ''].filter(Boolean).join(', ');
    const status = state.party.round ? (m.inRound === false ? 'joins next round' : m.voted ? 'voted' : 'choosing') : 'ready';
    return `<li class="member"><span>${esc(m.name)}${tags ? ` <span class="muted">(${tags})</span>` : ''}</span><span class="small muted">${status}</span></li>`;
  }).join('');
  return `<ul class="members" aria-label="People in this group">${rows}</ul>`;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

// Who has used the site lately: the count, then the newest few visitors.
// Only people who agreed to be shown are here. `long` spells out minutes
// for screen readers.
function timeAgo(iso, long) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return long ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

// Icons for the visitor rows. They use currentColor, so CSS colours them.
const ICON_PERSON = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/></svg>';
const ICON_PIN = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.4"/></svg>';

const FADE_MS = 10000; // one fade, as --mb-fade-duration in styles.css
const FADE_STAGGER_MS = 900; // gap between rows, as --mb-fade-stagger
const WALL_ROWS = 3; // most recent visitors shown
const FLASH_MS = 2400; // two flashes of a visitor icon, as .mb-flash in styles.css

// The fade plays once per row. A row whose fade has finished is rendered
// at rest with no animation; one still fading picks up where it was. A row
// only plays again when what it says changes (its key is new).
function fadeState(key, index) {
  const now = Date.now();
  if (!fadeStarts.has(key)) fadeStarts.set(key, now + index * FADE_STAGGER_MS);
  const elapsed = now - fadeStarts.get(key);
  return {
    done: elapsed >= FADE_MS,
    delay: ` style="animation-delay:${-elapsed}ms"`,
    flash: elapsed < FLASH_MS ? ` mb-flash" style="--flash-delay:${-elapsed}ms` : '',
  };
}

// Who has used the site: a live count that stays, with "people have used
// Movie Buddy" beside it fading away, then the newest visitors, each of
// which appears, flashes, and leaves entirely. Hovering or focusing the
// count brings the list back. The count's label carries everything, so
// nothing is lost to screen readers when the rows leave.
function wallBlock() {
  if (!wall || !wall.recent.length) return '';
  const label = `${wall.people === 1 ? 'person has' : 'people have'} used Movie Buddy`;
  const recent = wall.recent.slice(0, WALL_ROWS);
  const spoken = recent.map((e) => [e.name || 'Someone', e.place, timeAgo(e.at, true)].filter(Boolean).join(', '));
  const count = fadeState(`count:${wall.people}`, 0);
  const rows = recent.map((entry, i) => {
    const name = entry.name || '';
    const fade = fadeState(`visitor:${name}|${entry.place}|${entry.at}`, i + 1);
    const icon = name
      ? `<span class="mb-who__icon mb-who__icon--person${fade.flash}">${esc([...name][0].toUpperCase())}</span>`
      : `<span class="mb-who__icon mb-who__icon--unknown${fade.flash}">${ICON_PERSON}</span>`;
    return `
      <div class="mb-who mb-who--visitor ${fade.done ? 'mb-leave--rest' : 'mb-leave'}"${fade.done ? '' : fade.delay}>
        ${icon}
        <div class="mb-who__text">
          ${name ? `<span class="mb-who__name">${esc(name)}</span>` : ''}
          ${entry.place ? `<span class="mb-who__place">${ICON_PIN}${esc(entry.place)}</span>` : ''}
          <span class="mb-who__time">${timeAgo(entry.at)}</span>
        </div>
      </div>`;
  });
  return `
    <div class="mb-visitors">
      <div class="mb-who">
        <button type="button" class="mb-live" aria-label="${esc(`${wall.people} ${label}. Most recent: ${spoken.join('; ')}.`)}">
          <span class="mb-live__dot" aria-hidden="true"></span><span class="mb-live__count" aria-hidden="true">${wall.people}</span>
        </button>
        <div class="mb-who__text mb-fade${count.done ? ' mb-fade--rest' : ''}"${count.done ? '' : count.delay} aria-hidden="true">
          <span class="mb-who__label">${label}</span>
        </div>
      </div>
      <div class="mb-visitors__list" aria-hidden="true">${rows.join('')}</div>
    </div>`;
}

async function loadWall() {
  if (sampleMode) return;
  try {
    const { status, data } = await api('/wall');
    if (status === 200) wall = data;
  } catch (err) { /* the home page works without it */ }
}

// One of the home page's film tiles: one of TMDB's current popular films.
// Hovering, focusing or tapping it shows the film's details over the still:
// the same facts a swipe card shows.
function pickTile(i) {
  const film = posters[i];
  const d = film.details;
  const open = state.filmOpen === i;
  const panel = d ? `
            <div class="tile-details" id="film-details-${i}">
              <strong class="tile-details__title">${esc(film.title)}</strong>
              <span class="tile-details__meta">${esc(d.meta)}${d.rating ? ` · <span aria-label="rated ${d.rating} out of 10">★ ${d.rating}</span>` : ''}</span>
              ${d.about ? `<p class="tile-details__about">${esc(d.about)}</p>` : ''}
              <span class="tile-details__watch">${esc(d.watch || 'Not on a streaming service yet')}</span>
              ${d.trailerUrl ? `<a class="tile-details__link" href="${esc(d.trailerUrl)}" target="_blank" rel="noopener">Watch the trailer</a>` : ''}
            </div>` : '';
  return `
          <div class="tile tile--film${d ? ' tile--has-details' : ''}${open ? ' is-open' : ''}">
            <img src="${esc(film.backdrop || film.poster)}" alt="" draggable="false">
            <span class="tile-title">${esc(film.title)}</span>
            ${d ? `<button type="button" class="tile-hit" data-action="film-details" data-id="${i}" aria-expanded="${open}" aria-controls="film-details-${i}" aria-label="${esc(film.title)}: details"></button>` : ''}
            ${panel}
          </div>`;
}

// TMDB's popular films, shown only once real ones have loaded: nothing
// stands in for them while they load, in sample mode or if TMDB fails.
function picksBlock() {
  const count = Math.min(3, posters.length);
  if (!count) return '';
  return `
      <section class="picks">
        <h2>Popular right now</h2>
        <div class="rail">${Array.from({ length: count }, (_, i) => pickTile(i)).join('')}</div>
      </section>`;
}

// "Pick your own": one giant button that opens the two ways to set up
// the agent. Each choice starts the same flow as the buttons at the top.
function makeOwnBlock() {
  const open = state.makeOwn;
  return `
      <section class="own">
        <button type="button" class="own-button" data-action="make-own" aria-expanded="${open}" aria-controls="own-choices">
          Pick your own <span class="own-arrow" aria-hidden="true">${open ? '↓' : '→'}</span>
        </button>
        <div class="own-choices" id="own-choices"${open ? '' : ' hidden'}>
          <button type="button" class="own-choice" data-action="start-solo">
            <span class="own-choice__title">Just me <span aria-hidden="true">→</span></span>
            <span class="own-choice__text">Your mood, your time and every service you subscribe to. The agent searches them all and finds three films for you in about a minute.</span>
          </button>
          <button type="button" class="own-choice" data-action="start-group">
            <span class="own-choice__title">Watch with friends <span aria-hidden="true">→</span></span>
            <span class="own-choice__text">Send one link. The agent searches across everyone's subscriptions for films the whole group can watch.</span>
          </button>
        </div>
      </section>`;
}

function homeScreen() {
  const caption = profile.name
    ? `Welcome back, ${esc(profile.name)}. <button type="button" class="link-button" data-action="not-me">Not ${esc(profile.name)}?</button>`
    : 'No account. About a minute each.';
  return `
    <div class="wrap home">
      <section class="pitch">
        <h1 tabindex="-1">Every subscription. <em>One search.</em></h1>
        <p class="lede">Tell Movie Buddy your mood, your time and the streaming services you pay for. The agent searches all of them at once and finds three films you can watch tonight, no flicking between apps.</p>
        <div class="cta">
          <button type="button" class="button button--primary" data-action="start-solo">Just me</button>
          <button type="button" class="button" data-action="start-group">Watch with friends</button>
          <small>${caption}</small>
        </div>
        ${wallBlock()}
      </section>
      ${picksBlock()}
      ${makeOwnBlock()}
    </div>
    <section class="steps">
      <div class="wrap steps-grid">
        <div class="step"><b>1</b><h2>Add your subscriptions</h2><p>Netflix, Max, Prime Video, whatever you pay for, plus your mood and your time.</p></div>
        <div class="step"><b>2</b><h2>The agent searches them all</h2><p>One search across every service you have, for films released in the last two years.</p></div>
        <div class="step"><b>3</b><h2>Swipe and watch</h2><p>Right if you would watch it. With friends, everyone votes in private and you see where you agree.</p></div>
      </div>
    </section>`;
}
function stepHeader() {
  // Just me numbers only the four real steps: the name, asked once, has no number.
  const list = state.mode === 'solo' ? steps().filter((s) => s !== 'name') : steps();
  if (!list.includes(state.screen)) return '';
  return `<span class="small muted step-count">${list.indexOf(state.screen) + 1} of ${list.length}</span>`;
}

function stepFooter(nextLabel) {
  return `
    <div class="row row--between">
      <button type="button" class="link-button" data-action="back">Back</button>
      ${nextLabel ? `<button type="button" class="button button--primary" data-action="next">${nextLabel}</button>` : ''}
    </div>`;
}

function nameScreen() {
  const intro = state.mode === 'guest'
    ? `${esc(state.hostName || 'A friend')} invited you to pick a film together.`
    : state.mode === 'solo' ? 'Just a first name.'
    : 'Your friends will see this next to your votes.';
  return `
    <section class="screen screen--wide">
      <div class="stack">
        ${stepHeader()}
        <h1 class="title" tabindex="-1">What should we call you?</h1>
        <p class="muted" style="margin:0">${intro}</p>
      </div>
      <form id="name-form" class="stack" style="gap:16px">
        <label class="small" for="name-input">First name</label>
        <input id="name-input" class="text-input" type="text" maxlength="20" autocomplete="given-name" value="${esc(state.name)}">
        <span class="small error" id="name-error" role="alert"></span>
        <label class="check small">
          <input type="checkbox" id="show-me"${state.showMe ? ' checked' : ''}>
          <span>Show my first name and city on the home page, so others can see who is using Movie Buddy. The city comes from your connection; nothing else is shown.</span>
        </label>
        <div class="row row--between">
          <button type="button" class="link-button" data-action="back">Back</button>
          <button type="submit" class="button button--primary">Continue</button>
        </div>
      </form>
    </section>`;
}

function choiceScreen(title, hint, options, selected) {
  const buttons = options.map((o) => (
    `<button type="button" class="option" aria-pressed="${selected === o.id}" data-action="choose-answer" data-id="${o.id}"><span>${esc(o.label)}</span></button>`
  )).join('');
  return `
    <section class="screen screen--wide">
      <div class="stack">
        ${stepHeader()}
        <h1 class="title" tabindex="-1">${title}</h1>
        <p class="muted" style="margin:0">${hint}</p>
      </div>
      <div class="options">${buttons}</div>
      ${stepFooter('')}
    </section>`;
}

const moodScreen = () => choiceScreen('How do you want to feel?', 'Pick the one closest to tonight.', MOODS, state.answers.mood);
// Just me, step 1: one to three genres, three films to rate from each.
function soloGenresScreen() {
  const chosen = state.answers.genres;
  const full = chosen.length >= MAX_GENRES;
  const buttons = GENRES.map((g) => {
    const on = chosen.includes(g.id);
    return `<button type="button" class="chip" aria-pressed="${on}" data-action="toggle-genre" data-id="${esc(g.id)}"${full && !on ? ' disabled' : ''}>${on ? ICON_CHECK : ''}${esc(g.label)}</button>`;
  }).join('');
  const n = chosen.length;
  const count = n ? `${n} of ${MAX_GENRES} picked · ${n * RATE_PER_GENRE} films to rate` : 'Pick at least 1';
  return `
    <section class="screen screen--wide">
      <div class="stack">
        ${stepHeader()}
        <h1 class="title" tabindex="-1">What are you in the mood for?</h1>
        <p class="muted" style="margin:0">Pick 1 to 3 genres. You'll rate three films from each, and we recommend from what you like.</p>
      </div>
      <div class="chips" role="group" aria-label="Genres">${buttons}</div>
      <div class="row row--between">
        <button type="button" class="link-button" data-action="back">Back</button>
        <div class="row">
          <span class="small muted" role="status">${count}</span>
          <button type="button" class="button button--primary" data-action="next"${n ? '' : ' disabled'}>Continue</button>
        </div>
      </div>
    </section>`;
}

// Optional, several allowed: the genres this person is in the mood for.
// Those that suit the chosen mood are listed first.
function genresScreen() {
  if (state.mode === 'solo') return soloGenresScreen();
  const first = MOOD_FIRST[state.answers.mood] || [];
  const ordered = [...GENRES].sort((a, b) => (first.includes(a.id) ? first.indexOf(a.id) : 99) - (first.includes(b.id) ? first.indexOf(b.id) : 99));
  // Answers saved before genres existed have none.
  const chosen = state.answers.genres || (state.answers.genres = []);
  const full = chosen.length >= MAX_GENRES;
  const buttons = ordered.map((g) => {
    const on = chosen.includes(g.id);
    return `<button type="button" class="chip" aria-pressed="${on}" data-action="toggle-genre" data-id="${esc(g.id)}"${full && !on ? ' disabled' : ''}>${esc(g.label)}</button>`;
  }).join('');
  return `
    <section class="screen screen--wide">
      <div class="stack">
        ${stepHeader()}
        <h1 class="title" tabindex="-1">Any genres in mind?</h1>
        <p class="muted" style="margin:0">Pick up to ${MAX_GENRES}, or skip and let the agent choose from your mood.</p>
      </div>
      <div class="chips" role="group" aria-label="Genres">${buttons}</div>
      <p class="small muted" style="margin:0" role="status">${chosen.length ? `${chosen.length} of ${MAX_GENRES} chosen` : ''}</p>
      ${stepFooter(chosen.length ? 'Continue' : 'Skip')}
    </section>`;
}

const timeScreen = () => choiceScreen('How long have you got?', 'The group goes by whoever has least time.', TIMES, state.answers.time);

function servicesScreen() {
  const buttons = services.map((s) => {
    // The logo is decoration: the name next to it is the accessible label.
    const logo = s.logo ? `<img class="option-logo" src="${esc(s.logo)}" alt="" width="32" height="32">` : '';
    return `<button type="button" class="option" aria-pressed="${state.answers.services.includes(s.id)}" data-action="toggle-service" data-id="${s.id}">${logo}<span>${esc(s.label)}</span></button>`;
  }).join('');
  const isLast = steps().indexOf('services') === steps().length - 1;
  return `
    <section class="screen screen--wide">
      <div class="stack">
        ${stepHeader()}
        <h1 class="title" tabindex="-1">Where do you watch?</h1>
        <p class="muted" style="margin:0">Choose every service you subscribe to. ${state.mode === 'solo' ? 'The agent searches all of them at once.' : 'The agent searches everyone\'s subscriptions together.'}</p>
      </div>
      <div class="options options--grid">${buttons}</div>
      ${stepFooter(isLast ? 'Join the group' : 'Continue')}
    </section>`;
}

function kidsScreen() {
  const options = [{ id: 'no', label: 'No, adults only' }, { id: 'yes', label: 'Yes, keep it family-safe' }];
  const hint = state.mode === 'solo'
    ? 'With kids, only films rated G or PG. Adults only leaves out family films unless you picked that genre.'
    : 'With kids, only films rated G or PG. Adults only leaves out family films unless someone picks that genre.';
  return choiceScreen('Any kids watching?', hint, options, '');
}

// ---------------------------------------------------------------------------
// Just me: rate films (step 2) and the results
// ---------------------------------------------------------------------------

// Every film this person has been shown to rate, rated or swapped away.
function tasteShownIds() {
  const t = state.taste;
  return [...new Set([...t.slots.filter((x) => x.film).map((x) => x.film.id), ...t.unseen])];
}

// The next film from a genre's pool that has not been shown yet.
function nextRateFilm(genre) {
  const shown = new Set(tasteShownIds());
  return (state.taste.pools[genre] || []).find((f) => !shown.has(f.id)) || null;
}

// Fill every empty slot with a film, fetching more films when a genre's
// pool is short. Ratings already given are never touched.
async function fillRateSlots() {
  const t = state.taste;
  const short = [...new Set(t.slots.filter((x) => !x.film).map((x) => x.genre))].filter((g) => {
    const empty = t.slots.filter((x) => x.genre === g && !x.film).length;
    const shown = new Set(tasteShownIds());
    return (t.pools[g] || []).filter((f) => !shown.has(f.id)).length < empty;
  });
  let answered = !short.length;
  if (short.length) {
    t.loading = true;
    t.error = '';
    if (state.screen === 'rate') render({ focus: false });
    try {
      if (sampleMode) throw new Error('no-server');
      const pooled = Object.values(t.pools).flat().map((f) => f.id);
      const exclude = [...new Set([...pooled, ...t.unseen])].join(',');
      const { status, data } = await api(`/rate-films?genres=${encodeURIComponent(short.join(','))}&exclude=${exclude}`);
      if (status !== 200) throw new Error(String(status));
      Object.entries(data.films || {}).forEach(([g, films]) => {
        const have = new Set((t.pools[g] || []).map((f) => f.id));
        t.pools[g] = (t.pools[g] || []).concat(films.filter((f) => !have.has(f.id)));
      });
      answered = true;
    } catch (err) {
      t.error = sampleMode ? 'Rating films needs the live site.' : 'Could not load films to rate.';
    }
    t.loading = false;
  }
  t.slots.forEach((x) => { if (!x.film) x.film = nextRateFilm(x.genre); });
  // TMDB answered but has no more films in a genre: rate fewer from it
  // rather than stop on an error.
  if (answered && t.slots.some((x) => !x.film)) {
    const current = t.slots[t.at];
    t.slots = t.slots.filter((x) => x.film);
    const kept = t.slots.indexOf(current);
    t.at = kept >= 0 ? kept : Math.max(0, Math.min(t.at, t.slots.length - 1));
    if (!t.slots.length) t.error = 'No films to rate in those genres. Go back and pick others.';
    else if (t.slots.every((x) => x.rating)) return finishRating();
  }
  if (state.screen === 'rate') render();
}

// Into step 2 from step 1: three slots for each picked genre, in the order
// they were picked. Ratings for genres still picked are kept.
function startRating() {
  const t = state.taste;
  const genres = state.answers.genres;
  t.slots = t.slots.filter((x) => genres.includes(x.genre));
  genres.forEach((g) => {
    for (let i = t.slots.filter((x) => x.genre === g).length; i < RATE_PER_GENRE; i += 1) t.slots.push({ genre: g, film: null, rating: null });
  });
  t.slots.sort((a, b) => genres.indexOf(a.genre) - genres.indexOf(b.genre)); // stable: keeps each genre's order
  const open = t.slots.findIndex((x) => !x.rating);
  t.at = open < 0 ? 0 : open;
  t.message = '';
  state.screen = 'rate';
  render();
  return fillRateSlots();
}

// Three more films from each genre: after a batch with no likes, or "Rate more films".
function addRateBatch() {
  const t = state.taste;
  const first = t.slots.length;
  state.answers.genres.forEach((g) => {
    for (let i = 0; i < RATE_PER_GENRE; i += 1) t.slots.push({ genre: g, film: null, rating: null });
  });
  t.slots = [...t.slots.slice(0, first), ...t.slots.slice(first).sort((a, b) => state.answers.genres.indexOf(a.genre) - state.answers.genres.indexOf(b.genre))];
  t.at = first;
  state.screen = 'rate';
  render();
  return fillRateSlots();
}

// The last film is rated: more films if nothing landed, otherwise on to
// the services (or, rating more from the results, straight to a new round).
function finishRating() {
  const t = state.taste;
  const liked = t.slots.some((x) => x.rating === 'like');
  if (!liked && t.noLikes === 0) {
    t.noLikes = 1;
    t.message = 'Nothing landed yet. Try three more.';
    return addRateBatch();
  }
  t.message = '';
  if (t.more) {
    t.more = false;
    return newRound();
  }
  return goToStep(1);
}

function rateMeta(film) {
  return [film.year, film.runtime, film.certification].filter(Boolean).join(' · ');
}

function rateScreen() {
  const t = state.taste;
  const slot = t.slots[t.at];
  const genres = state.answers.genres;
  const progress = genres.filter((g) => t.slots.some((x) => x.genre === g)).map((g) => {
    const segs = t.slots.map((x, i) => {
      if (x.genre !== g) return '';
      const kind = i === t.at ? 'now' : x.rating || 'pending';
      return `<span class="seg seg--${kind}"></span>`;
    }).join('');
    return `<div class="progress-group${slot && slot.genre === g ? ' is-now' : ''}"><span>${esc(GENRE_NAME[g] || g)}</span><div class="segs">${segs}</div></div>`;
  }).join('');
  const label = (x) => ({ like: 'liked', dislike: 'not for me' }[x.rating] || 'not rated yet');
  const spoken = t.slots.map((x, i) => `Film ${i + 1}: ${label(x)}`).join('. ');

  let card;
  if (!slot && !t.loading && t.error) {
    card = `<div class="film film--status" role="alert"><p>${esc(t.error)}</p><button type="button" class="button button--primary" data-action="rate-back">Pick other genres</button></div>`;
  } else if (!slot || (!slot.film && t.loading)) {
    card = '<div class="film film--status" role="status"><p class="muted">Finding films to rate…</p></div>';
  } else if (!slot.film) {
    card = `
      <div class="film film--status" role="alert">
        <p>${esc(t.error || 'Could not load films to rate.')}</p>
        <button type="button" class="button button--primary" data-action="rate-retry">Try again</button>
      </div>`;
  } else {
    const f = slot.film;
    const canSwap = (t.swaps[slot.genre] || 0) < MAX_SWAPS && !!nextRateFilm(slot.genre);
    const poster = f.poster
      ? `<img class="film-poster" src="${esc(f.poster)}" alt="Poster for ${esc(f.title)}" width="200" height="300">`
      : `<div class="film-poster poster-blank" aria-hidden="true"><span>${esc(f.title)}</span></div>`;
    card = `
      <div class="film">
        ${poster}
        <div class="film-body">
          <span class="tag">${esc(GENRE_NAME[slot.genre] || slot.genre)}</span>
          <h2>${esc(f.title)}</h2>
          <span class="small muted">${esc(rateMeta(f))}</span>
          <p class="film-overview">${esc(f.overview)}</p>
          <div class="rate-actions">
            <button type="button" class="button button--ghost" data-action="rate-dislike">${ICON_DOWN}Not for me</button>
            <button type="button" class="button button--quiet" data-action="rate-unseen"${canSwap ? '' : ' disabled'}>Haven't seen it</button>
            <button type="button" class="button button--primary" data-action="rate-like">${ICON_UP}Liked it</button>
          </div>
        </div>
      </div>`;
  }
  return `
    <section class="screen screen--rate">
      <div class="stack">
        ${stepHeader()}
        <h1 class="title" tabindex="-1">Tell us what you like</h1>
        <p class="muted" style="margin:0">Three films from each genre you picked. Haven't seen one? We swap in another.</p>
      </div>
      ${t.message ? `<p class="notice" role="status">${esc(t.message)}</p>` : ''}
      <div class="rate-progress" role="img" aria-label="${esc(spoken)}">
        ${progress}
        <span class="small muted progress-count">Film ${Math.min(t.at + 1, t.slots.length)} of ${t.slots.length}</span>
      </div>
      ${card}
      <div class="row row--between">
        <button type="button" class="link-button" data-action="rate-back">Back</button>
        <span class="small muted">Moves on by itself after the last film.</span>
      </div>
    </section>`;
}

function minutesText(minutes) {
  return minutes ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : '';
}

// One recommended film. On a shared page the reason names the person who
// shared it, Ember's line (written to them) is left out, and there is no
// "Not for me".
function recCard(p, shared) {
  const service = (p.service && p.service.name) || (p.watch && p.watch.service) || '';
  const url = p.watchUrl || (p.watch && p.watch.url) || '';
  const meta = [GENRE_NAME[p.primaryGenre] || '', minutesText(p.minutes), service ? `on ${service}` : ''].filter(Boolean).join(' · ');
  const who = shared ? (shared.name ? esc(shared.name) : 'they') : 'you';
  const because = p.becauseTitle ? `Because ${who} liked ${esc(p.becauseTitle)}`
    : p.popularIn ? `A popular pick in ${esc(GENRE_LABEL[p.popularIn] || p.popularIn)}` : '';
  const art = p.backdrop
    ? `<img class="rec-art" src="${esc(p.backdrop)}" alt="" width="780" height="439">`
    : '<div class="rec-art poster-blank" aria-hidden="true"></div>';
  return `
      <article class="rec"${p.id ? ` id="rec-${esc(p.id)}"` : ''}>
        ${art}
        <div class="rec-body">
          <h2 tabindex="-1">${esc(p.title)}</h2>
          <span class="small muted">${esc(meta)}</span>
          ${because ? `<p class="why">${ICON_UP}<span>${because}</span></p>` : ''}
          ${!shared && p.byEmber && p.why ? `<p class="small muted rec-note">${esc(p.why)}</p>` : ''}
          <div class="rec-actions">
            ${url ? `<a class="button button--primary button--sm" href="${esc(url)}" target="_blank" rel="noopener">Watch${service ? ` on ${esc(service)}` : ''}</a>` : ''}
            ${shared ? '' : `<button type="button" class="button button--ghost button--sm" data-action="dismiss-pick" data-id="${esc(p.id)}">Not for me</button>`}
          </div>
        </div>
      </article>`;
}

// Just me: the three films, each with why it is here.
function tasteResultsScreen() {
  const all = picks();
  const cards = all.map((p) => recCard(p, null)).join('');
  const fewer = all.length < 3 ? `
      <div class="next-round" role="status">
        <p>Only ${all.length} ${all.length === 1 ? 'film' : 'films'} on your services matched. Adding a service widens the search.</p>
        <div class="row"><button type="button" class="button" data-action="add-service">Add another service</button></div>
      </div>` : '';
  return `
    <section class="screen screen--results">
      <div class="stack">
        <h1 class="title" tabindex="-1">Your three for <em>tonight.</em></h1>
        <p class="muted" style="margin:0">Chosen from the films you liked, on the services you have. Each one says why it's here.</p>
      </div>
      <div class="recs">${cards}</div>
      ${fewer}
      <div class="row">
        <button type="button" class="button button--primary button--sm" data-action="share-three">Share my three</button>
        <button type="button" class="button button--ghost button--sm" data-action="rate-more">Rate more films</button>
        <span class="small muted">None of these? Rating a few more sharpens the next three. "Not for me" swaps that film for another.</span>
      </div>
      ${state.share ? `${sharePanel()}<p class="small muted" style="margin:0">Shares your first name and these three films, nothing else.</p>` : ''}
      ${costLine()}
    </section>`;
}

// Someone's shared three, opened from /s/<id>: the films and why, then a
// way to get your own.
function sharedScreen() {
  const s = state.shared;
  const own = `
      <section class="own">
        <button type="button" class="own-button" data-action="own-from-share">Get your own three <span class="own-arrow" aria-hidden="true">→</span></button>
      </section>
      <div class="row"><button type="button" class="link-button" data-action="home">What is Movie Buddy?</button></div>`;
  if (!s || s.gone) {
    return `
    <section class="screen screen--results">
      <div class="stack">
        <h1 class="title" tabindex="-1">This share has expired</h1>
        <p class="muted" style="margin:0">Shared films are kept for 30 days. Rate a few films and Movie Buddy finds three for you, on the services you have.</p>
      </div>
      ${own}
    </section>`;
  }
  const share = s.share;
  const who = share.name ? `${esc(share.name)}'s` : 'Their';
  return `
    <section class="screen screen--results">
      <div class="stack">
        <h1 class="title" tabindex="-1">${who} three for <em>tonight.</em></h1>
        <p class="muted" style="margin:0">Chosen by the Movie Buddy agent from films ${share.name ? esc(share.name) : 'they'} liked. Rate a few of your own and get three picked for you.</p>
      </div>
      <div class="recs">${share.picks.map((p) => recCard(p, share)).join('')}</div>
      ${own}
    </section>`;
}

// What the Worker needs to build the taste profile.
function tastePayload() {
  const t = state.taste;
  return {
    ratings: t.slots.filter((x) => x.film && x.rating).map((x) => ({ filmId: x.film.id, title: x.film.title, genre: x.genre, rating: x.rating, f: x.film.f })),
    unseen: t.unseen,
    dismissed: t.dismissed,
  };
}

// While someone waits for the host to start a round: keep the page open, and
// (once they agree) a system notification when it starts, so they can switch
// to another tab or app. Notifications need the tab to stay open; they do not
// reach a closed tab.
function notifyOffer() {
  const keepOpen = 'Keep this page open. It switches to your three films as soon as the round starts.';
  const dot = '<span class="mb-live__dot" aria-hidden="true"></span>';
  if (!('Notification' in window)) return `<p class="next-round">${dot}${keepOpen}</p>`;
  if (Notification.permission === 'granted') {
    return `<p class="next-round">${dot}Notifications are on. You will get one when the round starts, even with this tab in the background. Keep the tab open.</p>`;
  }
  if (Notification.permission === 'denied') {
    return `<p class="next-round">${dot}${keepOpen} Notifications are blocked for this site in your browser settings.</p>`;
  }
  return `
        <div class="next-round next-round--ask">
          <p>${dot}${keepOpen} Want a notification when it starts, so you can use other tabs meanwhile?</p>
          <button type="button" class="button button--primary" data-action="notify-me">Notify me when it starts</button>
        </div>`;
}

// The host started a round while this page was in the background.
function notifyRound(party) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const host = (party.members.find((m) => m.isHost) || {}).name || 'Your host';
  try {
    const note = new Notification('Your Movie Buddy round has started', {
      body: `${host} started a round. Three films are waiting for your vote.`,
      tag: `movie-buddy-${state.partyId}`,
    });
    note.onclick = () => { window.focus(); note.close(); };
  } catch (err) {
    /* some browsers (Chrome on Android) only allow notifications from a service worker */
  }
}

function lobbyScreen() {
  const p = state.party;
  const n = p.members.length;
  if (p.isHost) {
    return `
      <section class="screen screen--medium">
        <div class="stack">
          <h1 class="title" tabindex="-1" style="font-size:32px">Invite your friends</h1>
          <p class="muted" style="margin:0">Send the link. Start when everyone you are waiting for is on the list.</p>
        </div>
        ${sharePanel()}
        ${membersList()}
        <div class="row">
          <button type="button" class="button button--primary" data-action="new-round">${n > 1 ? `Pick for all ${n} of us` : 'Pick for me for now'}</button>
        </div>
      </section>`;
  }
  const host = p.members.find((m) => m.isHost);
  return `
    <section class="screen screen--medium">
      <div class="stack">
        <h1 class="title" tabindex="-1" style="font-size:32px">You are in</h1>
        <p class="muted" style="margin:0" role="status">Waiting for ${esc(host ? host.name : 'the host')} to start. This page updates by itself.</p>
      </div>
      ${notifyOffer()}
      ${membersList()}
    </section>`;
}

// A slow strip of posters that drifts past while the agent works. The list
// is written twice so the loop has no visible seam.
function posterReel() {
  if (posters.length < 6) return '';
  const row = posters.map((p) => `<img src="${esc(p.poster)}" alt="" draggable="false">`).join('');
  return `
    <div class="reel" aria-hidden="true"><div class="reel-track">${row}${row}</div></div>
    <p class="small muted" style="margin:0;text-align:center">Popular right now, from TMDB. Your three picks come next.</p>`;
}

function loadingScreen() {
  return `
    ${posterReel()}
    <section class="screen screen--medium" style="text-align:center" aria-busy="true">
      <h1 class="title" tabindex="-1" style="font-size:28px">The agent is searching</h1>
      <p class="muted" style="margin:0" role="status">Looking across ${isGroup() ? 'your group\'s' : 'your'} streaming services for three films.</p>
      <div id="human-check" style="display:flex;justify-content:center"></div>
    </section>`;
}

function deckScreen() {
  const pick = currentPick();
  const all = picks();
  const dots = all.map((_, k) => `<span class="dot ${k === state.index ? 'dot--on' : ''}"></span>`).join('');
  const heading = isGroup() ? `Three for the ${state.party.members.length} of you` : 'Your three for tonight';
  const sub = isGroup() ? 'Your votes stay private until you have finished.' : 'Right if you would watch it, left if not.';
  return `
    <section class="screen screen--deck">
      <div class="stack" style="text-align:center">
        <h1 class="title title--small" tabindex="-1">${heading}</h1>
        <span class="small muted">${sub}</span>
      </div>
      <article class="card" id="card" tabindex="0" aria-label="${esc(pick.title)}. Press the right arrow if you would watch it, the left arrow if not.">
        ${posterHtml(pick, `Poster for ${pick.title}`)}
        <div class="card-body">
          ${pick.pickedFor ? `<span class="label">${esc(pickLabel(pick))}</span>` : ''}
          <h2>${esc(pick.title)}</h2>
          <span class="small muted">${esc(pick.meta)}</span>
          ${detailsBlock(pick)}
        </div>
      </article>
      <div class="deck-controls">
        <button type="button" class="round" data-action="vote-no" aria-label="Would not watch">
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
        <div class="progress">
          <div class="dots" aria-hidden="true">${dots}</div>
          <span class="small muted">${state.index + 1} of ${all.length}</span>
        </div>
        <button type="button" class="round round--yes" data-action="vote-yes" aria-label="Would watch">
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </button>
      </div>
      <span class="small muted" style="text-align:center">Drag the card, tap a button, or use the arrow keys.</span>
      ${costLine()}
    </section>`;
}

function reasonScreen() {
  const options = REASONS
    .map((r) => `<button type="button" class="option" data-action="reason" data-id="${r.id}"><span>${esc(r.label)}</span></button>`)
    .join('');
  return `
    <section class="screen screen--medium">
      <div class="stack">
        <h1 class="title" tabindex="-1" style="font-size:28px">Why not ${esc(currentPick().title)}?</h1>
        <p class="muted" style="margin:0">One tap helps the agent's next search.</p>
      </div>
      <div class="options">${options}</div>
    </section>`;
}

function pickRow(p, line, canChoose) {
  const isSaved = saved.includes(p.id);
  return `
    <div class="pick">
      ${posterHtml(p, '')}
      <div class="pick-body">
        <div>
          <div class="pick-title">${esc(p.title)}</div>
          <span class="small muted">${esc(p.meta)} · ${esc(watchInfo(p).headline)}</span>
          ${line ? `<div class="small"><strong>${esc(line)}</strong></div>` : ''}
        </div>
        <div class="row">
          ${canChoose ? `<button type="button" class="button button--primary" data-action="choose" data-id="${p.id}">Watch this tonight</button>` : ''}
          <button type="button" class="button" aria-pressed="${isSaved}" data-action="save" data-id="${p.id}">${isSaved ? 'Saved' : 'Save for later'}</button>
        </div>
      </div>
    </div>`;
}

function resultsScreen() {
  if (justMe()) return tasteResultsScreen();
  const p = state.party;
  const all = picks();
  const mine = new Set((p.yourVotes || []).filter((v) => v.vote === 'yes').map((v) => v.id));

  // One person: the films they said yes to.
  if (p.solo) {
    const liked = all.filter((x) => mine.has(x.id));
    const title = liked.length ? `You would watch ${liked.length} of ${all.length}` : 'None of these landed';
    return `
      <section class="screen screen--medium">
        <div class="stack">
          <h1 class="title" tabindex="-1" style="font-size:32px">${title}</h1>
          <p class="muted" style="margin:0">${liked.length ? 'Choose one for tonight, or let the agent try again.' : 'Your reasons go to the agent for its next search.'}</p>
        </div>
        <div class="stack" style="gap:12px">${liked.map((x) => pickRow(x, '', true)).join('')}</div>
        <div class="row"><button type="button" class="button ${liked.length ? '' : 'button--primary'}" data-action="new-round">Try three more</button></div>
        ${costLine()}
      </section>`;
  }

  // Who joined after this round started, and who runs the group.
  const late = p.members.filter((m) => m.inRound === false);
  const voters = p.members.filter((m) => m.inRound !== false);
  const host = (p.members.find((m) => m.isHost) || {}).name || 'The host';

  // A latecomer who was not part of this round: say who starts the next one,
  // and that this page will move on by itself.
  if (p.inRound === false) {
    const now = p.allVoted
      ? `This round is finished. ${esc(host)} can now start the next one, and you will be in it.`
      : `The others are voting on three films now. When they finish, ${esc(host)} can start the next round, and you will be in it.`;
    return `
      <section class="screen screen--medium">
        <div class="stack">
          <h1 class="title" tabindex="-1" style="font-size:32px">You are in the next round</h1>
          <p class="muted" style="margin:0" role="status">${now}</p>
        </div>
        ${notifyOffer()}
        ${membersList()}
      </section>`;
  }

  const results = p.results || [];
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  const ordered = [...all].sort((a, b) => (byId[b.id] ? byId[b.id].yes : 0) - (byId[a.id] ? byId[a.id].yes : 0));
  const waitingFor = p.members.filter((m) => m.inRound !== false && !m.voted).map((m) => m.name);
  const matches = ordered.filter((x) => byId[x.id] && byId[x.id].everyone);

  // "Everyone" only means everyone when nobody is waiting for the next round.
  const allSaid = late.length ? (voters.length === 1 ? 'You said yes' : 'Everyone in this round said yes') : 'Everyone said yes';
  let title;
  let hint;
  if (!p.allVoted) {
    title = `Waiting for ${listNames(waitingFor)}`;
    hint = 'Votes so far are below. This page updates by itself.';
  } else if (matches.length === 1) {
    title = `${allSaid} to ${matches[0].title}`;
    hint = late.length ? 'That is the pick from this round.' : 'That is your film.';
  } else if (matches.length > 1) {
    title = `${allSaid} to ${matches.length} films`;
    hint = 'Choose one for tonight.';
  } else {
    title = 'No film everyone agreed on';
    hint = p.isHost ? 'The closest are first. Ask the agent to try again; it knows what each of you rejected.' : 'The closest are first. The host can ask the agent to try again.';
  }

  const rows = ordered.map((x) => {
    const r = byId[x.id];
    const line = r ? (r.everyone ? allSaid : `${r.yes} of ${r.of} said yes${mine.has(x.id) ? ', including you' : ''}`) : '';
    return pickRow(x, line, !!(r && r.everyone));
  }).join('');

  // People who joined mid-round wait for the host. Tell the host plainly,
  // and give them the next round as the main action.
  const lateNames = listNames(late.map((m) => m.name));
  const left = usageNow().left;
  let again = '';
  let prompt = '';
  if (p.isHost && p.allVoted && late.length) {
    prompt = `
      <div class="next-round next-round--host" role="status">
        <p><strong>${esc(lateNames)} ${late.length === 1 ? 'is' : 'are'} waiting for you.</strong> They joined after this round started. Start a new round to choose with everyone. It uses 1 of your ${left} ${left === 1 ? 'round' : 'rounds'} left today.</p>
        <div class="row"><button type="button" class="button button--primary" data-action="new-round">Start a round with everyone</button></div>
      </div>`;
  } else if (p.isHost && p.allVoted) {
    again = `<div class="row"><button type="button" class="button ${matches.length ? '' : 'button--primary'}" data-action="new-round">Try three more</button></div>`;
  } else if (p.allVoted && late.length) {
    again = `<p class="next-round"><span class="mb-live__dot" aria-hidden="true"></span>${esc(lateNames)} ${late.length === 1 ? 'joins' : 'join'} the next round when ${esc(host)} starts it. This page switches to it by itself.</p>`;
  }
  return `
    <section class="screen screen--medium">
      <div class="stack">
        <h1 class="title" tabindex="-1" style="font-size:32px">${esc(title)}</h1>
        <p class="muted" style="margin:0" role="status">${hint}</p>
      </div>
      ${prompt}
      <div class="stack" style="gap:12px">${rows}</div>
      ${membersList()}
      ${again}
      ${costLine()}
    </section>`;
}

function tonightScreen() {
  const p = picks().find((x) => x.id === state.chosenId);
  const w = p.watch;
  const open = w && w.url
    ? `<a class="button button--primary" href="${esc(w.url)}" target="_blank" rel="noopener">${w.direct ? `Open ${esc(w.service)}` : 'See viewing options'}</a>`
    : '';
  const trailer = p.trailerUrl
    ? `<a class="button" href="${esc(p.trailerUrl)}" target="_blank" rel="noopener">Watch trailer</a>`
    : '';
  return `
    <section class="tonight">
      <div class="tonight-poster">${posterHtml(p, `Poster for ${p.title}`)}</div>
      <div class="tonight-body">
        <span class="small muted">${isGroup() ? 'Tonight you are all watching' : 'Tonight you are watching'}</span>
        <h1 class="title" tabindex="-1">${esc(p.title)}</h1>
        <span class="muted" style="font-size:15px">${esc(p.meta)}</span>
        ${detailsBlock(p)}
        <div class="row">${open}${trailer}</div>
        <div><button type="button" class="link-button" data-action="to-results">Choose a different one</button></div>
      </div>
    </section>`;
}

function usageScreen() {
  const u = usageNow();
  const { left, limit } = u;
  const percent = Math.round((left / limit) * 100);
  const title = left > 0 ? `${left} of ${limit} rounds left today` : 'You have used today\'s rounds';
  const request = u.requested
    ? `<p class="small muted" style="margin:0">You have had today's extra ${u.extraRounds} rounds. The count resets tomorrow.</p>`
    : `<div class="stack">
         <label class="small" for="usage-note">What are you still looking for? (optional)</label>
         <textarea id="usage-note" rows="2"></textarea>
         <div class="row"><button type="button" class="button ${left > 0 ? '' : 'button--primary'}" data-action="request-more">Request ${u.extraRounds} more rounds</button></div>
       </div>`;
  return `
    <section class="screen screen--medium">
      <div class="stack">
        <h1 class="title" tabindex="-1" style="font-size:32px">${title}</h1>
        <p class="muted" style="margin:0">Movie Buddy runs on a small shared budget, so every visitor gets ${u.perDay} rounds a day. A round is one search by the agent for three films. A group's round counts against the host only.</p>
      </div>
      <div class="stack">
        <div class="bar" role="img" aria-label="${left} of ${limit} rounds left"><span style="width:${percent}%"></span></div>
        <span class="small muted">About ${Number(u.tokens || 0).toLocaleString('en-US')} Muse Ember tokens used today${u.costUsd ? `, roughly ${money(u.costUsd)} at list prices` : ''}.</span>
      </div>
      ${state.usageNote ? `<p class="small" role="status" style="margin:0"><strong>${esc(state.usageNote)}</strong></p>` : ''}
      ${remoteBudget && !sampleMode ? `<p class="small muted" style="margin:0">Across all visitors, Movie Buddy has spent about ${money(remoteBudget.spentUsd)} of its ${money(remoteBudget.limitUsd)} Muse Ember budget. At the limit the agent switches off.</p>` : ''}
      ${request}
      <div class="row"><button type="button" class="button ${left > 0 ? 'button--primary' : ''}" data-action="usage-back">Back</button></div>
    </section>`;
}

function goneScreen() {
  return `
    <section class="screen screen--medium">
      <div class="stack">
        <h1 class="title" tabindex="-1" style="font-size:32px">This group has ended</h1>
        <p class="muted" style="margin:0">Groups last two days, or the link may be mistyped. You can start a new one.</p>
      </div>
      <div class="row"><button type="button" class="button button--primary" data-action="home">Start again</button></div>
    </section>`;
}

const SCREENS = {
  home: homeScreen, name: nameScreen, mood: moodScreen, genres: genresScreen, time: timeScreen, services: servicesScreen,
  kids: kidsScreen, rate: rateScreen, shared: sharedScreen, lobby: lobbyScreen, loading: loadingScreen, deck: deckScreen, reason: reasonScreen,
  results: resultsScreen, tonight: tonightScreen, usage: usageScreen, gone: goneScreen,
};

let lastHtml = '';

function render(options) {
  const notice = state.notice ? `<p class="notice" role="alert">${esc(state.notice)}</p>` : '';
  const html = notice + SCREENS[state.screen]();
  const quiet = options && options.focus === false;
  // A background refresh that changes nothing must not disturb the page:
  // re-rendering would drop text selection and reset the card mid-drag.
  if (quiet && options.ifChanged && html === lastHtml) return;
  state.notice = '';
  lastHtml = html;
  app.innerHTML = html;

  document.getElementById('mode-note').hidden = !sampleMode;
  startOverButton.hidden = state.screen === 'home';
  const left = usageNow().left;
  meterButton.textContent = `${left} ${left === 1 ? 'round' : 'rounds'} left`;
  meterButton.setAttribute('aria-label', `${left} of ${usageNow().limit} rounds left today. Open usage details.`);

  if (state.screen === 'deck') wireCard();
  if (state.screen === 'name') wireNameForm();
  // Move focus to the new screen's heading so keyboard and screen-reader
  // users land in the right place. Skipped for in-place updates.
  if (!quiet) {
    const target = state.screen === 'deck' ? document.getElementById('card')
      : state.screen === 'name' ? document.getElementById('name-input')
      : app.querySelector('h1');
    if (target) target.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

// ---------------------------------------------------------------------------
// The group: create, join, keep in step
// ---------------------------------------------------------------------------

let pollTimer = null;

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling() {
  stopPolling();
  if (sampleMode || !state.partyId) return;
  pollTimer = setInterval(refreshParty, POLL_MS);
}

function rememberParty() {
  const t = state.taste;
  const taste = state.mode === 'solo' ? { slots: t.slots.filter((x) => x.film && x.rating), unseen: t.unseen, dismissed: t.dismissed } : null;
  writeStore(PARTY_KEY, { id: state.partyId, mid: state.mid, name: state.name, answers: state.answers, taste });
  history.replaceState(null, '', `${location.pathname}${location.search}#party-${state.partyId}`);
}

// Take the server's description of the group and move this browser to the
// screen that matches it.
// A tab in the background shows news in its title until it is looked at.
const PAGE_TITLE = document.title;
function flagTab(text) {
  document.title = text;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = PAGE_TITLE;
});

function adoptParty(party, options) {
  state.party = party;
  // A new round has started: everyone who is part of it goes to the cards.
  if (party.round > state.roundShown && party.picks.length) {
    // Someone else started it while this tab was in the background.
    if (document.hidden && !party.isHost && party.inRound !== false) {
      flagTab('New round · Movie Buddy');
      notifyRound(party);
    }
    state.roundShown = party.round;
    state.index = 0;
    state.votes = [];
    state.chosenId = null;
    // Just me has no cards to swipe: the three films come with their reasons.
    state.screen = (party.justMe || party.inRound === false || party.yourVotes) ? 'results' : 'deck';
    return render();
  }
  if (['usage', 'tonight', 'deck', 'reason', 'loading'].includes(state.screen)) return undefined; // do not interrupt
  if (!party.round) state.screen = 'lobby';
  return render({ focus: false, ifChanged: !(options && options.force) });
}

async function refreshParty() {
  if (!state.partyId || sampleMode) return;
  try {
    const { status, data } = await api(`/party/${state.partyId}?mid=${state.mid}`);
    if (status === 200 && data.party.joined) adoptParty(data.party);
  } catch (err) {
    /* a missed check is fine; the next one will catch up */
  }
}

// The last question has been answered: create or join the group.
async function finishAnswers() {
  if (sampleMode) {
    // No server: a group of one with the built-in titles.
    state.party = { solo: true, isHost: true, round: 0, members: [{ name: 'You', isYou: true, isHost: true }], picks: [], yourVotes: null, allVoted: false };
    return newRound();
  }
  try {
    if (state.mode === 'guest') {
      const { status, data } = await api(`/party/${state.partyId}/join`, { mid: state.mid, name: state.name, answers: state.answers, showOnWall: state.showMe });
      if (status === 409) { state.notice = 'This group is full.'; state.screen = 'home'; return render(); }
      if (status !== 200) { state.screen = 'gone'; return render(); }
      rememberParty();
      startPolling();
      return adoptParty(data.party, { force: true });
    }
    state.mid = profile.id;
    const { status, data } = await api('/party', { mid: state.mid, name: state.name, answers: state.answers, kids: state.kids, showOnWall: state.showMe, solo: state.mode === 'solo' });
    if (status !== 200) { state.notice = 'Could not start. Try again in a minute.'; return render(); }
    state.partyId = data.party.id;
    state.party = data.party;
    rememberParty();
    if (state.mode === 'solo') return newRound();
    state.share = { url: inviteLink(), text: 'Help pick tonight\'s film. Add your mood and your streaming services:', note: '' };
    state.screen = 'lobby';
    startPolling();
    return render();
  } catch (err) {
    sampleMode = true;
    return finishAnswers();
  }
}

// Ask the agent for three films for the whole group.
async function newRound() {
  if (usageNow().left < 1) return openUsage();
  const cameFrom = state.screen === 'kids' || state.screen === 'services' ? 'home' : state.screen;
  state.share = null;
  state.screen = 'loading';
  render();

  if (sampleMode) {
    localUsage.used += 1;
    localUsage.tokens += TOKENS_PER_ROUND;
    writeStore(USAGE_KEY, localUsage);
    return adoptParty({ ...state.party, round: state.roundShown + 1, picks: SAMPLE_PICKS, yourVotes: null, allVoted: false, results: null });
  }

  // Just me goes back to the step it came from, ratings kept.
  const soloBack = state.mode === 'solo' ? (state.party && state.party.round ? 'results' : 'kids') : null;
  const fail = (message) => { state.screen = soloBack || (state.party && state.party.round ? 'results' : cameFrom === 'home' ? 'home' : 'lobby'); state.notice = message; render(); };
  try {
    const turnstileToken = await humanToken();
    const taste = state.mode === 'solo' ? { taste: tastePayload() } : {};
    const { status, data } = await api(`/party/${state.partyId}/round`, { mid: state.mid, turnstileToken, ...taste });
    if (status === 200) {
      humanVerified = true;
      if (state.mode === 'solo') rememberParty(); // keep the ratings with the round
      startPolling();
      return adoptParty(data.party);
    }
    state.screen = soloBack || (state.party && state.party.round ? 'results' : 'lobby');
    if (status === 429 && data.error === 'limit') return openUsage();
    if (status === 429 && data.error === 'busy') return openUsage('Movie Buddy has reached today\'s shared budget. It resets tomorrow.');
    if (status === 429 && data.error === 'budget') return openUsage('Movie Buddy has used its whole Muse Ember budget, so the agent is switched off.');
    if (status === 429) return fail('Too many requests. Wait a minute and try again.');
    if (data.error === 'human-check') return fail('We could not confirm you are a person. Reload the page and try again.');
    if (data.error === 'no-matches') return fail(state.mode === 'solo' ? 'Nothing on your services matched. Try adding another service.' : 'Nothing matched the whole group. Try adding more services.');
    return fail('Something went wrong getting your films. Try again.');
  } catch (err) {
    return fail('Could not reach Movie Buddy. Check your connection and try again.');
  }
}

async function submitVotes() {
  state.screen = 'results';
  if (sampleMode) {
    state.party = { ...state.party, yourVotes: state.votes, allVoted: true };
    return render();
  }
  state.party = { ...state.party, yourVotes: state.votes }; // show something at once
  render();
  try {
    const { status, data } = await api(`/party/${state.partyId}/votes`, { mid: state.mid, round: state.roundShown, votes: state.votes });
    if (status === 200) adoptParty(data.party, { force: true });
  } catch (err) {
    state.notice = 'Your votes were not saved. Check your connection.';
    render();
  }
}

// Opening an invite link, or coming back to a group this browser is in.
async function openParty(id) {
  const mine = readStore(PARTY_KEY, null);
  state.partyId = id;
  try {
    const mid = mine && mine.id === id ? mine.mid : profile.id;
    const { status, data } = await api(`/party/${id}?mid=${mid}`);
    if (status !== 200) { state.screen = 'gone'; return render(); }
    if (data.party.joined) {
      state.mid = mid;
      state.name = (mine && mine.id === id && mine.name) || profile.name || '';
      state.answers = (mine && mine.id === id && mine.answers) || state.answers;
      state.mode = data.party.justMe ? 'solo' : data.party.isHost ? 'host' : 'guest';
      if (data.party.justMe && mine && mine.taste) {
        state.taste = { ...newTaste(), ...mine.taste, at: Math.max(0, mine.taste.slots.length - 1) };
        state.taste.slots.forEach((x) => { (state.taste.pools[x.genre] = state.taste.pools[x.genre] || []).push(x.film); });
      }
      if (data.party.isHost && !data.party.round) state.share = { url: inviteLink(), text: 'Help pick tonight\'s film. Add your mood and your streaming services:', note: '' };
      startPolling();
      return adoptParty(data.party, { force: true });
    }
    if (data.party.full) { state.notice = 'This group is full.'; state.screen = 'home'; return render(); }
    state.mode = 'guest';
    state.mid = profile.id;
    state.hostName = data.party.hostName;
    state.askName = !profile.name;
    state.screen = steps()[0];
    if (!state.askName) state.notice = `${state.hostName || 'A friend'} invited you to pick a film together, ${profile.name}.`;
    return render();
  } catch (err) {
    sampleMode = true;
    state.notice = 'Groups need the live site. This preview is solo only.';
    state.partyId = '';
    state.screen = 'home';
    return render();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function goToStep(offset) {
  const list = steps();
  const next = list.indexOf(state.screen) + offset;
  if (next < 0) {
    reset('home');
    return render();
  }
  if (next >= list.length) return finishAnswers();
  // Just me: going forward into the rating step loads its films; coming
  // back to it lands on the last film rated, rating intact.
  if (list[next] === 'rate') {
    if (offset > 0) return startRating();
    state.taste.at = Math.max(0, state.taste.slots.length - 1);
  }
  state.screen = list[next];
  return render();
}

function openUsage(note) {
  if (state.screen !== 'usage') state.usageFrom = state.screen === 'loading' ? 'home' : state.screen;
  state.usageNote = note || '';
  state.screen = 'usage';
  render();
}

function recordVote(vote, reason) {
  state.votes.push({ id: currentPick().id, vote, reason: reason || '' });
  if (state.index < picks().length - 1) {
    state.index += 1;
    state.screen = 'deck';
    return render();
  }
  return submitVotes();
}

function vote(direction) {
  const card = document.getElementById('card');
  const finish = () => {
    if (direction === 'yes') return recordVote('yes');
    state.screen = 'reason';
    return render();
  };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!card || reduced) return finish();
  // Fling the card off in the direction of the vote, then move on.
  const x = direction === 'yes' ? 500 : -500;
  card.style.transition = 'transform 0.2s ease-in, opacity 0.2s ease-in';
  card.style.transform = `translateX(${x}px) rotate(${x / 25}deg)`;
  card.style.opacity = '0';
  return setTimeout(finish, 200);
}

async function copyLink() {
  let note = 'Link copied. Paste it into your group chat.';
  try {
    await navigator.clipboard.writeText(state.share.url);
  } catch (err) {
    note = 'Could not copy automatically. Select the link and copy it.';
  }
  state.share.note = note;
  render({ focus: false });
  const input = document.getElementById('share-link');
  if (input) input.select();
}

async function nativeShare() {
  try {
    await navigator.share({ title: 'Movie Buddy', text: state.share.text, url: state.share.url });
  } catch (err) {
    // Closed the sheet, or sharing is blocked here: the Copy button still works.
  }
}

// Liked it / Not for me: record it and move to the next film, or on when
// it was the last.
function rateFilm(rating) {
  const t = state.taste;
  const slot = t.slots[t.at];
  if (!slot || !slot.film) return undefined;
  slot.rating = rating;
  t.message = '';
  if (t.at < t.slots.length - 1) {
    t.at += 1;
    render({ focus: false });
    return focusRateButton(`rate-${rating}`);
  }
  return finishRating();
}

// After a re-render, keep keyboard focus on the button just used.
function focusRateButton(action) {
  const button = app.querySelector(`[data-action="${action}"]:not([disabled])`) || app.querySelector('[data-action="rate-like"]');
  if (button) button.focus();
}

const ACTIONS = {
  home() { reset('home'); render(); loadWall().then(() => { if (state.screen === 'home') render({ focus: false }); }); },
  'start-solo'() { reset('home'); state.mode = 'solo'; state.screen = steps()[0]; render(); },
  'start-group'() {
    if (sampleMode) { state.notice = 'Groups need the live site. This preview is solo only.'; return render(); }
    reset('home');
    state.mode = 'host';
    state.screen = steps()[0];
    return render();
  },
  // Someone else is using this device: forget the name and start a new identity.
  // A film tile on the home page: tap or click to keep its details open.
  'film-details'(id) {
    const i = Number(id);
    state.filmOpen = state.filmOpen === i ? -1 : i;
    render({ focus: false });
    const hit = app.querySelector(`.tile-hit[data-id="${i}"]`);
    if (hit) hit.focus();
  },
  async 'notify-me'() {
    try { await Notification.requestPermission(); } catch (err) { /* treated as not granted */ }
    render({ focus: false });
  },
  'make-own'() {
    state.makeOwn = !state.makeOwn;
    render({ focus: false });
    const target = state.makeOwn ? app.querySelector('.own-choice') : app.querySelector('.own-button');
    if (target) target.focus();
  },
  'not-me'() {
    profile = { id: newId(16), name: '', showMe: true };
    writeStore(PROFILE_KEY, profile);
    state.name = '';
    state.showMe = true;
    reset('home');
    render();
  },
  back() { goToStep(-1); },
  next() { goToStep(1); },
  'choose-answer'(id) {
    if (state.screen === 'kids') state.kids = id === 'yes';
    else state.answers[state.screen] = id;
    goToStep(1);
  },
  'toggle-genre'(id) {
    const list = state.answers.genres || [];
    if (list.includes(id)) state.answers.genres = list.filter((g) => g !== id);
    else if (list.length < MAX_GENRES) state.answers.genres = list.concat(id);
    render({ focus: false });
    const again = app.querySelector(`[data-action="toggle-genre"][data-id="${CSS.escape(id)}"]`);
    if (again) again.focus();
  },
  'toggle-service'(id) {
    const n = Number(id);
    const list = state.answers.services;
    state.answers.services = list.includes(n) ? list.filter((x) => x !== n) : list.concat(n);
    render({ focus: false });
  },
  'new-round': newRound,
  async 'share-three'() {
    try {
      const { status, data } = await api(`/party/${state.partyId}/share`, { mid: state.mid, round: state.roundShown });
      if (status !== 200) throw new Error(String(status));
      state.share = { url: `${SITE_URL || location.origin}${data.url}`, text: 'Send your three to a friend. They can see why each one is here, then get their own.', note: '' };
    } catch (err) {
      state.notice = 'Could not make a link. Try again.';
    }
    render({ focus: false });
    const link = document.getElementById('share-link');
    if (link) link.focus();
  },
  'own-from-share'() {
    const genres = state.shared && state.shared.share ? state.shared.share.genres : [];
    reset('home');
    state.mode = 'solo';
    state.answers.genres = (genres || []).filter((g) => GENRE_NAME[g]).slice(0, MAX_GENRES);
    state.screen = steps()[0];
    render();
  },
  'rate-like'() { rateFilm('like'); },
  'rate-dislike'() { rateFilm('dislike'); },
  'rate-unseen'() {
    const t = state.taste;
    const slot = t.slots[t.at];
    if (!slot || !slot.film || (t.swaps[slot.genre] || 0) >= MAX_SWAPS) return;
    const next = nextRateFilm(slot.genre);
    if (!next) return;
    t.unseen.push(slot.film.id);
    t.swaps[slot.genre] = (t.swaps[slot.genre] || 0) + 1;
    slot.film = next;
    slot.rating = null;
    render({ focus: false });
    focusRateButton('rate-unseen');
  },
  'rate-back'() {
    const t = state.taste;
    if (t.at > 0) { t.at -= 1; render({ focus: false }); return focusRateButton('rate-like'); }
    return goToStep(-1);
  },
  'rate-retry'() { fillRateSlots(); },
  'rate-more'() {
    if (usageNow().left < 1) return openUsage();
    state.taste.more = true;
    state.taste.message = '';
    return addRateBatch();
  },
  'add-service'() { state.screen = 'services'; render(); },
  async 'dismiss-pick'(id) {
    if (!state.taste.dismissed.includes(Number(id))) state.taste.dismissed.push(Number(id));
    try {
      const { status, data } = await api(`/party/${state.partyId}/replace`, { mid: state.mid, round: state.roundShown, filmId: id });
      if (status === 200) {
        const at = picks().findIndex((p) => p.id === id);
        state.party = data.party;
        state.share = null; // the three changed: a new share makes a new link
        render({ focus: false });
        // Focus the card that replaced it, so keyboard users stay in place.
        const replaced = picks()[at];
        const heading = replaced && document.querySelector(`#rec-${CSS.escape(replaced.id)} h2`);
        if (heading) heading.focus();
        return undefined;
      }
      state.notice = data.error === 'no-more'
        ? 'No other films on your services matched. Try "Rate more films" or add a service.'
        : 'Could not swap that film. Try again.';
    } catch (err) {
      state.notice = 'Could not reach Movie Buddy. Check your connection and try again.';
    }
    return render({ focus: false });
  },
  'vote-yes'() { vote('yes'); },
  'vote-no'() { vote('no'); },
  reason(id) { recordVote('no', id); },
  save(id) {
    saved = saved.includes(id) ? saved.filter((x) => x !== id) : saved.concat(id);
    writeStore(SAVED_KEY, saved);
    render({ focus: false });
  },
  choose(id) { state.chosenId = id; state.screen = 'tonight'; render(); },
  'to-results'() { state.screen = 'results'; render(); },
  usage() { openUsage(); },
  'usage-back'() { state.screen = state.usageFrom; render(); },
  async 'request-more'() {
    const field = document.getElementById('usage-note');
    const result = await requestMore(field ? field.value.trim() : '');
    state.usageNote = result.granted ? `${result.extra} more rounds added.` : 'No more rounds can be added today.';
    render();
  },
  'copy-link': copyLink,
  'native-share': nativeShare,
};

// One click listener for the whole page: buttons declare what they do with
// data-action, and optionally which item with data-id.
document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = ACTIONS[el.dataset.action];
  if (action) action(el.dataset.id);
});

function wireNameForm() {
  document.getElementById('name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('name-input');
    const value = input.value.trim();
    if (!value) {
      document.getElementById('name-error').textContent = 'Enter a name first.';
      input.focus();
      return;
    }
    state.name = value.slice(0, 20);
    state.showMe = document.getElementById('show-me').checked;
    profile = { id: profile.id, name: state.name, showMe: state.showMe };
    writeStore(PROFILE_KEY, profile);
    goToStep(1);
  });
  document.getElementById('name-input').addEventListener('input', () => {
    document.getElementById('name-error').textContent = '';
  });
}

// ---------------------------------------------------------------------------
// Swipe gesture
// ---------------------------------------------------------------------------

const SWIPE_THRESHOLD = 90; // pixels the card must travel to count as a vote

function wireCard() {
  const card = document.getElementById('card');
  let startX = 0;
  let dx = 0;
  let dragging = false;

  card.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    dx = 0;
    card.style.transition = 'none';
    try { card.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
  });

  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 24}deg)`;
  });

  const release = () => {
    if (!dragging) return undefined;
    dragging = false;
    if (dx > SWIPE_THRESHOLD) return vote('yes');
    if (dx < -SWIPE_THRESHOLD) return vote('no');
    card.style.transition = 'transform 0.2s';
    card.style.transform = '';
    return undefined;
  };

  card.addEventListener('pointerup', release);
  card.addEventListener('pointercancel', release);

  card.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); vote('yes'); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); vote('no'); }
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function partyIdFromHash() {
  const match = location.hash.match(/^#party-([a-z0-9]{10})$/);
  return match ? match[1] : '';
}

async function start() {
  try {
    await api('/usage'); // also tells us whether there is a server
  } catch (err) {
    sampleMode = true;
  }
  const shared = location.pathname.match(/^\/s\/([a-z0-9]{8})\/?$/);
  const id = partyIdFromHash();
  if (shared && !sampleMode) {
    try {
      const { status, data } = await api(`/share/${shared[1]}`);
      state.shared = status === 200 ? { id: shared[1], share: data.share } : { id: shared[1], gone: true };
    } catch (err) {
      state.shared = { id: shared[1], gone: true };
    }
    state.screen = 'shared';
    render();
  } else if (id) await openParty(id);
  else render({ focus: false });
  loadWall().then(() => { if (state.screen === 'home') render({ focus: false }); });
  // Posters fill the home page's film tiles and the waiting screen.
  loadPosters().then(() => { if (state.screen === 'home') render({ focus: false }); });
  // Logos are a nicety, so the page never waits for them.
  loadServices().then(() => { if (state.screen === 'services') render({ focus: false }); });
}

// Pasting an invite link into a tab that already has the site open.
window.addEventListener('hashchange', () => {
  const id = partyIdFromHash();
  if (id && id !== state.partyId) { reset('home', true); openParty(id); }
});

start();
