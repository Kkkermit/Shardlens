import crypto from 'node:crypto';

const IK = 'slk_ingest_' + 'E'.repeat(43);
function uuid() {
  const b = crypto.randomBytes(16);
  const ts = Date.now();
  const tb = Buffer.alloc(6);
  tb.writeUIntBE(ts, 0, 6);
  tb.copy(b, 0, 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const batch = {
  v: 1,
  mode: 'privacy',
  sdk: { name: 't', version: '0' },
  app: { id: '1234567890123456789', env: 'prod' },
  source: { shards: [0], instance: 'x' },
  sentAt: new Date().toISOString(),
  events: [
    {
      type: 'app_info',
      id: uuid(),
      ts: Date.now(),
      weight: 1,
      name: 'MyBot',
      approximateGuildCount: 5,
      approximateUserInstallCount: 1,
      approximateUserAuthorizationCount: 1,
      dashboardUserIds: ['123456789012345678', '876543210987654321'],
      eventWebhooksStatus: 2,
      skus: [],
      nodeVersion: 'v24',
      libVersion: 'x',
      sessionStartRemaining: 1000,
      sessionStartTotal: 1000,
    },
  ],
};
const r = await fetch('http://127.0.0.1:10090/v1/ingest', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + IK, 'content-type': 'application/json' },
  body: JSON.stringify(batch),
});
console.log('ingest', r.status, await r.text());
