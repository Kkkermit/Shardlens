import { type Db, isRefusedInput } from '../../db.js';
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
import { postgresAdminAudit } from './admin-audit.js';
import { postgresAlerts } from './alerts.js';
import { postgresApps } from './apps.js';
import { postgresDemo } from './demo.js';
import { postgresIngest } from './ingest/write.js';
import { postgresJobs } from './jobs.js';
import { postgresKeys } from './keys.js';
import { postgresLive } from './live.js';
import { ensurePartitions } from './partitions.js';
import { postgresPrivacy } from './privacy.js';
import { postgresQueries } from './queries.js';
import { postgresSalts } from './salts.js';
import { postgresReports } from './scheduled-reports.js';
import { postgresSessions } from './sessions.js';
import { postgresSettings } from './settings.js';
import { postgresWebhookEvents } from './webhook-events.js';

/**
 * The collector's store on PostgreSQL, or on PGlite in embedded mode (ADR 0012): a `pg` pool, or PGlite behind the
 * same Pool API. Migrations are applied before the store is made, and whoever made the pool closes it.
 */
export class PostgresStore implements Store {
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
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    this.apps = postgresApps(db);
    this.keys = postgresKeys(db);
    this.sessions = postgresSessions(db);
    this.settings = postgresSettings(db);
    this.salts = postgresSalts(db);
    this.ingest = postgresIngest(db);
    this.webhookEvents = postgresWebhookEvents(db);
    this.query = postgresQueries(db);
    this.alerts = postgresAlerts(db);
    this.reports = postgresReports(db);
    this.privacy = postgresPrivacy(db);
    this.adminAudit = postgresAdminAudit(db);
    this.live = postgresLive(db);
    this.jobs = postgresJobs(db);
    this.demo = postgresDemo(db);
  }

  async prepare(): Promise<void> {
    await ensurePartitions(this.#db);
  }

  async ready(): Promise<void> {
    await this.#db.query('SELECT 1 FROM pgmigrations LIMIT 1');
  }

  refusedInput(error: unknown): string | undefined {
    return isRefusedInput(error) ? error.code : undefined;
  }
}
