import { readFileSync } from 'node:fs';
import { batchJsonSchema, ConfigResponse, ErrorResponse, IngestAccepted } from '@shardlens/schema';
import { z } from 'zod';
import { QuerySpec } from './query/spec.js';
import { AlertBody, SettingsPatch } from './routes/admin.js';
import { AuditLogFilters, EraseBody } from './routes/privacy.js';
import { ReportBody } from './routes/reports.js';

const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0', unrepresentable: 'any' });
const body = (schema: z.ZodType, description?: string) => ({
  required: true,
  ...(description ? { description } : {}),
  content: { 'application/json': { schema: json(schema) } },
});
const ok = (description: string, schema?: z.ZodType) => ({
  description,
  ...(schema ? { content: { 'application/json': { schema: json(schema) } } } : {}),
});
const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: json(ErrorResponse) } },
});

const unauthorized = { '401': error('Missing or wrong credentials') };
const admin = {
  '401': error('Not signed in'),
  '403': error('Needs a Discord sign-in (owner or team) and, for changes, the CSRF header'),
};
const id = [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^\\d{1,18}$' } }];
const auditLogFilters = Object.entries(
  (json(AuditLogFilters) as { properties: Record<string, object> }).properties,
).map(([name, schema]) => ({ name, in: 'query', required: false, schema }));

/** This collector's version, from its package.json: one folder up from `src/` and from `dist/` alike. */
function collectorVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

/**
 * OpenAPI 3.1 description of the collector's HTTP API, generated from the same zod schemas the routes validate with,
 * so the document cannot drift from the code. Served at `/openapi.json` and rendered on the docs site.
 */
export function openApiDocument(version = collectorVersion()): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Shardlens collector API',
      version,
      description:
        'Self-hosted collector for Shardlens. SDKs send batches with an ingest key; dashboards and scripts read with a read key or a session. Every route validates its input; SQL is always parameterised.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: 'https://stats.example.com', description: 'Your collector' }],
    components: {
      securitySchemes: {
        ingestKey: { type: 'http', scheme: 'bearer', description: 'Ingest-only key: `slk_ingest_…`' },
        readKey: { type: 'http', scheme: 'bearer', description: 'Read-only key: `slk_read_…`' },
        activityKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Activity key: `slk_activity_…`. Reads what a read key does, and who ran what in audit mode. Server side only.',
        },
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'shardlens_session',
          description: 'Dashboard session. State-changing requests also need the header `x-shardlens-csrf: 1`.',
        },
        discordSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Signature-Ed25519',
          description: 'Ed25519 signature of `X-Signature-Timestamp` + raw body, checked with the app’s public key.',
        },
      },
    },
    tags: [
      { name: 'SDK', description: 'Used by the Shardlens SDKs' },
      { name: 'Discord', description: 'Called by Discord' },
      { name: 'Data', description: 'Queries for dashboards and scripts' },
      { name: 'Admin', description: 'Settings, keys, alerts and reports (Discord sign-in)' },
      { name: 'Audit mode', description: 'Who ran what (audit mode only; every access is logged)' },
      { name: 'Privacy', description: 'Erasure' },
      { name: 'Auth', description: 'Dashboard sign-in' },
      { name: 'Health', description: 'Liveness and readiness' },
    ],
    paths: {
      '/v1/ingest': {
        post: {
          tags: ['SDK'],
          summary: 'Send a batch of events',
          description:
            'Gzipped JSON (`Content-Encoding: gzip`), at most 500 events, 1 MB compressed and 5 MB decompressed. Invalid events are rejected one by one; duplicates (retries) are counted, not stored twice.',
          security: [{ ingestKey: [] }],
          // The published batch schema, with the rules checked in code (no NUL, no `actor` in privacy mode).
          requestBody: { required: true, content: { 'application/json': { schema: batchJsonSchema() } } },
          responses: {
            '202': ok('Accepted', IngestAccepted),
            '400': error('Invalid batch envelope, or audit data sent to a privacy-mode app'),
            ...unauthorized,
            '403': error('The batch is for another application'),
            '413': error('Body too large'),
            '429': error('Rate limited; retry after the `Retry-After` header'),
            '503': error('Busy; retry after the `Retry-After` header'),
          },
        },
      },
      '/v1/config': {
        get: {
          tags: ['SDK'],
          summary: 'Salts, sampling and data mode for the SDK',
          description:
            'The salt of the current period first, then the previous one while it is inside its grace week. In the last 5 minutes of a period the next period’s salt comes too, last: SDKs ask again 1 to 4 minutes before a boundary, so they hold it before the period starts.',
          security: [{ ingestKey: [] }],
          responses: { '200': ok('Current configuration', ConfigResponse), ...unauthorized },
        },
      },
      '/v1/discord/events': {
        post: {
          tags: ['Discord'],
          summary: 'Discord webhook events',
          description:
            'APPLICATION_AUTHORIZED, APPLICATION_DEAUTHORIZED and ENTITLEMENT_* events. Answered with 204 before processing; retried deliveries are stored once.',
          security: [{ discordSignature: [] }],
          responses: {
            '204': { description: 'Acknowledged' },
            '401': error('Bad or stale signature'),
            '404': error('Not configured'),
          },
        },
      },
      '/v1/query': {
        post: {
          tags: ['Data'],
          summary: 'Run a typed query',
          description:
            'Every query kind maps to a fixed SQL template with bound parameters. There is no per-user grouping.',
          security: [{ readKey: [] }, { activityKey: [] }, { session: [] }],
          requestBody: body(QuerySpec),
          responses: {
            '200': { description: 'Query result (shape depends on `kind`)' },
            '400': error('Invalid query'),
            ...unauthorized,
          },
        },
      },
      '/v1/meta': {
        get: {
          tags: ['Data'],
          summary: 'Application name, mode and time zone',
          security: [{ readKey: [] }, { activityKey: [] }, { session: [] }],
          responses: { '200': { description: 'Metadata' }, ...unauthorized },
        },
      },
      '/v1/live': {
        get: {
          tags: ['Data'],
          summary: 'Live tiles (Server-Sent Events)',
          security: [{ readKey: [] }, { activityKey: [] }, { session: [] }],
          responses: {
            '200': {
              description: '`tiles` events every second',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
            ...unauthorized,
          },
        },
      },
      '/v1/badge/{metric}': {
        get: {
          tags: ['Data'],
          summary: 'Public SVG badge (opt-in per metric)',
          parameters: [
            {
              name: 'metric',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['servers.svg', 'users-monthly.svg', 'commands-daily.svg'] },
            },
          ],
          responses: {
            '200': { description: 'Badge', content: { 'image/svg+xml': { schema: { type: 'string' } } } },
            '404': error('Unknown or switched off'),
          },
        },
      },
      '/v1/privacy/erase': {
        post: {
          tags: ['Privacy'],
          summary: 'Erase everything stored about a user',
          description:
            'From an SDK: user hashes (the raw ID only in audit mode). From the dashboard: an exact Discord user ID. Every erasure is logged.',
          security: [{ ingestKey: [] }, { session: [] }],
          requestBody: body(EraseBody),
          responses: {
            '200': { description: 'Rows removed' },
            '400': error('Nothing to erase, or a raw ID in privacy mode'),
            ...admin,
          },
        },
      },
      '/v1/settings': {
        get: {
          tags: ['Admin'],
          summary: 'Read settings',
          security: [{ session: [] }],
          responses: { '200': { description: 'Settings' }, ...admin },
        },
        put: {
          tags: ['Admin'],
          summary: 'Change settings',
          description:
            'Audit retention above 90 days is rejected. Audit mode needs `SHARDLENS_AUDIT_KEY` on the collector.',
          security: [{ session: [] }],
          requestBody: body(SettingsPatch),
          responses: { '200': { description: 'Updated settings' }, '400': error('Invalid settings'), ...admin },
        },
      },
      '/v1/keys': {
        get: {
          tags: ['Admin'],
          summary: 'List API keys',
          security: [{ session: [] }],
          responses: { '200': { description: 'Keys (never the secrets)' }, ...admin },
        },
        post: {
          tags: ['Admin'],
          summary: 'Create an API key (shown once)',
          security: [{ session: [] }],
          requestBody: body(
            z.object({ scope: z.enum(['ingest', 'read', 'activity']), label: z.string().min(1).max(64) }),
          ),
          responses: { '201': { description: 'The new key, shown once' }, ...admin },
        },
      },
      '/v1/keys/{id}': {
        delete: {
          tags: ['Admin'],
          summary: 'Revoke an API key',
          security: [{ session: [] }],
          parameters: id,
          responses: { '200': { description: 'Revoked' }, ...admin },
        },
      },
      '/v1/alerts': {
        get: {
          tags: ['Admin'],
          summary: 'Alert rules and history',
          security: [{ session: [] }],
          responses: { '200': { description: 'Rules (webhook URLs masked)' }, ...admin },
        },
        post: {
          tags: ['Admin'],
          summary: 'Create an alert rule',
          description: 'The webhook must be a Discord webhook URL; it is stored encrypted.',
          security: [{ session: [] }],
          requestBody: body(AlertBody),
          responses: { '201': { description: 'Created' }, '400': error('Invalid rule or webhook URL'), ...admin },
        },
      },
      '/v1/alerts/{id}': {
        patch: {
          tags: ['Admin'],
          summary: 'Turn a rule on or off',
          security: [{ session: [] }],
          parameters: id,
          requestBody: body(z.object({ enabled: z.boolean() })),
          responses: { '200': { description: 'Updated' }, ...admin },
        },
        delete: {
          tags: ['Admin'],
          summary: 'Delete a rule',
          security: [{ session: [] }],
          parameters: id,
          responses: { '200': { description: 'Deleted' }, ...admin },
        },
      },
      '/v1/alerts/{id}/test': {
        post: {
          tags: ['Admin'],
          summary: 'Send a test message',
          security: [{ session: [] }],
          parameters: id,
          responses: { '200': { description: 'Sent' }, '502': error('Discord refused it'), ...admin },
        },
      },
      '/v1/reports': {
        get: {
          tags: ['Admin'],
          summary: 'Scheduled reports',
          security: [{ session: [] }],
          responses: {
            '200': { description: 'Reports (webhook URLs masked) and the time zone they run in' },
            ...admin,
          },
        },
        post: {
          tags: ['Admin'],
          summary: 'Create a scheduled report',
          description:
            'A daily or weekly summary posted to a Discord channel. The webhook must be a Discord webhook URL; it is stored encrypted. Reports contain counts only.',
          security: [{ session: [] }],
          requestBody: body(ReportBody),
          responses: { '201': { description: 'Created' }, '400': error('Invalid report or webhook URL'), ...admin },
        },
      },
      '/v1/reports/{id}': {
        patch: {
          tags: ['Admin'],
          summary: 'Turn a report on or off',
          security: [{ session: [] }],
          parameters: id,
          requestBody: body(z.object({ enabled: z.boolean() })),
          responses: { '200': { description: 'Updated' }, ...admin },
        },
        delete: {
          tags: ['Admin'],
          summary: 'Delete a report',
          security: [{ session: [] }],
          parameters: id,
          responses: { '200': { description: 'Deleted' }, ...admin },
        },
      },
      '/v1/reports/{id}/send': {
        post: {
          tags: ['Admin'],
          summary: 'Send a report now',
          description: 'Posts the report for its last finished day or week.',
          security: [{ session: [] }],
          parameters: id,
          responses: { '200': { description: 'Sent' }, '502': error('Discord refused it'), ...admin },
        },
      },
      '/v1/audit/log': {
        get: {
          tags: ['Audit mode'],
          summary: 'Activity log (who ran what)',
          description:
            'Filter by time, command, server, outcome (`failed` is every outcome but `ok`) or exact user ID. `nextBefore` in the reply is the `before` of the next page. For a Discord sign-in or an activity key (a read key gets `403 activity_key_required`). Logged in the access log.',
          security: [{ session: [] }, { activityKey: [] }],
          parameters: auditLogFilters,
          responses: {
            '200': { description: 'Rows, newest first' },
            '400': error('Unknown or malformed filter'),
            ...admin,
            '404': error('Audit mode is off'),
          },
        },
      },
      '/v1/audit/top-users': {
        get: {
          tags: ['Audit mode'],
          summary: 'Most active users in the last 24 hours or 7 days',
          description: 'For a Discord sign-in or an activity key. Logged in the access log.',
          security: [{ session: [] }, { activityKey: [] }],
          responses: { '200': { description: 'Counts' }, ...admin, '404': error('Audit mode is off') },
        },
      },
      '/v1/audit/export.csv': {
        get: {
          tags: ['Audit mode'],
          summary: 'Export the activity log as CSV',
          description:
            'Takes the filters of the activity log (up to 10,000 rows; `limit` is ignored). Needs `x-shardlens-confirm: export-audit-log` and the CSRF header. Spreadsheet formulas are neutralised.',
          security: [{ session: [] }],
          parameters: auditLogFilters,
          responses: {
            '200': { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } },
            '428': error('Confirmation missing'),
            ...admin,
          },
        },
      },
      '/v1/audit/access-log': {
        get: {
          tags: ['Audit mode'],
          summary: 'Who viewed, looked up, exported or erased audit data',
          security: [{ session: [] }],
          responses: { '200': { description: 'Entries' }, ...admin },
        },
      },
      '/auth/discord': {
        get: {
          tags: ['Auth'],
          summary: 'Start "Sign in with Discord"',
          responses: { '302': { description: 'Redirect to Discord' } },
        },
      },
      '/auth/discord/callback': {
        get: {
          tags: ['Auth'],
          summary: 'OAuth2 callback',
          responses: { '302': { description: 'Signed in, or back to the login page' } },
        },
      },
      '/auth/read-key': {
        post: {
          tags: ['Auth'],
          summary: 'Sign in with a read key (view-only session)',
          requestBody: body(z.object({ key: z.string() })),
          responses: {
            '200': { description: 'Signed in' },
            '401': error('Key not accepted'),
            '403': error('CSRF header missing'),
          },
        },
      },
      '/auth/logout': {
        post: { tags: ['Auth'], summary: 'Sign out', responses: { '200': { description: 'Signed out' } } },
      },
      '/auth/me': {
        get: { tags: ['Auth'], summary: 'Current session', responses: { '200': { description: 'Session state' } } },
      },
      '/healthz': { get: { tags: ['Health'], summary: 'Liveness', responses: { '200': { description: 'Running' } } } },
      '/readyz': {
        get: {
          tags: ['Health'],
          summary: 'Readiness (database reachable)',
          responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } },
        },
      },
    },
  };
}
