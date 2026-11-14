// k6 load test for collector ingest. Target: 5,000 events/s per instance on 1 vCPU.
//
//   k6 run -e URL=http://localhost:8080 -e KEY=slk_ingest_… tests/load/ingest.js
//
// Sends gzipped batches of 500 events at a constant arrival rate (default 10 batches/s = 5,000 events/s) for 60 s.
// Users are hashed exactly like the SDK does (HMAC-SHA-256 with the period salt from /v1/config, first 16 bytes),
// so the collector does all of its real work: validation, dedupe, uniques and writes.
import { check } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import http from 'k6/http';

const URL = __ENV.URL || 'http://localhost:8080';
const KEY = __ENV.KEY;
const RATE = Number(__ENV.RATE || 10);
const BATCH = Number(__ENV.BATCH || 500);

export const options = {
  scenarios: {
    ingest: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
  },
  thresholds: {
    // Accepted, quickly, and no dropped iterations (the collector kept up with the arrival rate).
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    'http_req_duration{expected_response:true}': ['p(95)<1000'],
    dropped_iterations: ['count<=5'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const COMMANDS = ['ticket', 'help', 'music', 'poll', 'profile', 'rank', 'settings'];
const SUBS = { ticket: ['open', 'close'], music: ['play', 'skip', 'queue'], poll: ['create', 'end'] };
const LOCALES = ['en-GB', 'en-US', 'de', 'fr', 'es-ES', 'pt-BR'];

function uuidv7() {
  const time = Date.now().toString(16).padStart(12, '0');
  const rand = new Uint8Array(crypto.randomBytes(10));
  rand[0] = (rand[0] & 0x0f) | 0x70; // version 7
  rand[2] = (rand[2] & 0x3f) | 0x80; // variant
  const r = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-${r.slice(0, 4)}-${r.slice(4, 8)}-${r.slice(8, 20)}`;
}

const pick = (items) => items[Math.floor(Math.random() * items.length)];

function snowflake(i) {
  // 19-digit IDs; only the format matters here.
  return `1000000000000${String(i).padStart(6, '0')}`;
}

export function setup() {
  if (!KEY) throw new Error('Set KEY to an slk_ingest_ key');
  const res = http.get(`${URL}/v1/config`, { headers: { authorization: `Bearer ${KEY}` } });
  if (res.status !== 200) throw new Error(`/v1/config answered ${res.status}`);
  const config = res.json();
  const { period, salt } = config.salts[0];
  const secret = encoding.b64decode(salt, 'rawurl');
  const users = [];
  for (let i = 0; i < 2000; i++) {
    const hex = crypto.hmac('sha256', secret, snowflake(500000 + i), 'hex');
    users.push(`h1:${period}:${hex.slice(0, 32)}`);
  }
  const guilds = Array.from({ length: 300 }, (_, i) => snowflake(i));
  return { appId: config.appId, users, guilds };
}

function event(data, now) {
  if (Math.random() < 0.15) {
    return {
      id: uuidv7(),
      ts: now,
      type: 'custom',
      name: pick(['ticket_opened', 'ticket_closed', 'song_played']),
      props: { category: pick(['billing', 'support', 'report']) },
      user: pick(data.users),
      guild: pick(data.guilds),
    };
  }
  const command = pick(COMMANDS);
  const subs = SUBS[command];
  const ok = Math.random() > 0.04;
  const e = {
    id: uuidv7(),
    ts: now,
    type: 'interaction',
    kind: 'chat_input',
    command,
    options: [],
    context: 0,
    install: 'guild',
    guild: pick(data.guilds),
    locale: pick(LOCALES),
    memberTier: 'member',
    user: pick(data.users),
    premium: Math.random() < 0.05,
    outcome: ok ? 'ok' : 'error',
    ackMs: Math.round(50 + Math.random() * 600),
    deferred: false,
  };
  if (subs) e.sub = pick(subs);
  return e;
}

export default function (data) {
  const now = Date.now();
  const events = Array.from({ length: BATCH }, () => event(data, now));
  const body = JSON.stringify({
    v: 1,
    mode: 'privacy',
    sdk: { name: 'k6', version: '0.0.0' },
    app: { id: data.appId, env: 'load' },
    source: { shards: [0], instance: `k6:${__VU}` },
    sentAt: new Date(now).toISOString(),
    events,
  });
  const res = http.post(`${URL}/v1/ingest`, body, {
    compression: 'gzip',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  });
  check(res, { accepted: (r) => r.status === 202 });
}
