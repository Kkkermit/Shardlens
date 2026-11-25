import type {
  AdminAuditStorage,
  AlertStorage,
  AppStorage,
  DemoStorage,
  IngestStorage,
  JobStorage,
  KeyStorage,
  LiveStorage,
  PrivacyStorage,
  QueryStorage,
  ReportStorage,
  SaltStorage,
  SessionStorage,
  SettingStorage,
  Store,
  WebhookEventStorage,
} from '../store.js';
import { mongoAdminAudit } from './admin-audit.js';
import { mongoAlerts } from './alerts.js';
import { mongoApps } from './apps.js';
import { ensureIndexes } from './collections.js';
import type { Mongo } from './connect.js';
import { mongoDemo } from './demo.js';
import { mongoIngest } from './ingest/write.js';
import { mongoJobs } from './jobs.js';
import { mongoKeys } from './keys.js';
import { mongoLive } from './live.js';
import { mongoPrivacy } from './privacy.js';
import { mongoQuery } from './queries.js';
import { mongoSalts } from './salts.js';
import { mongoReports } from './scheduled-reports.js';
import { mongoSessions } from './sessions.js';
import { mongoSettings } from './settings.js';
import { mongoWebhookEvents } from './webhook-events.js';

/**
 * The collector's store on MongoDB (ADR 0022): the owner's own database, a standalone server, a replica set or Atlas.
 * Collections are prefixed `shardlens_` (`collections.ts`). Whoever connected the client closes it.
 */
export class MongoStore implements Store {
  readonly apps: AppStorage;
  readonly keys: KeyStorage;
  readonly sessions: SessionStorage;
  readonly settings: SettingStorage;
  readonly salts: SaltStorage;
  readonly ingest: IngestStorage;
  readonly webhookEvents: WebhookEventStorage;
  readonly query: QueryStorage;
  readonly alerts: AlertStorage;
  readonly reports: ReportStorage;
  readonly privacy: PrivacyStorage;
  readonly adminAudit: AdminAuditStorage;
  readonly live: LiveStorage;
  readonly jobs: JobStorage;
  readonly demo: DemoStorage;
  /** The connection and collections, for MongoDB's own tests and the runners that made it. */
  readonly mongo: Mongo;

  constructor(m: Mongo) {
    this.mongo = m;
    this.apps = mongoApps(m);
    this.keys = mongoKeys(m);
    this.sessions = mongoSessions(m);
    this.settings = mongoSettings(m);
    this.salts = mongoSalts(m);
    this.ingest = mongoIngest(m);
    this.webhookEvents = mongoWebhookEvents(m);
    this.query = mongoQuery(m);
    this.alerts = mongoAlerts(m);
    this.reports = mongoReports(m);
    this.privacy = mongoPrivacy(m);
    this.adminAudit = mongoAdminAudit(m);
    this.live = mongoLive(m);
    this.jobs = mongoJobs(m);
    this.demo = mongoDemo(m);
  }

  async prepare(): Promise<void> {
    await ensureIndexes(this.mongo.db);
  }

  async ready(): Promise<void> {
    await this.mongo.db.command({ ping: 1 });
  }

  refusedInput(_error: unknown): string | undefined {
    return undefined;
  }
}
