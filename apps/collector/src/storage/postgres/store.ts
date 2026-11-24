import { type Db, isRefusedInput } from '../../db.js';
import type { AdminAuditStorage, AppStorage, KeyStorage, SessionStorage, SettingStorage, Store } from '../store.js';
import { postgresAdminAudit } from './admin-audit.js';
import { postgresApps } from './apps.js';
import { postgresKeys } from './keys.js';
import { postgresSessions } from './sessions.js';
import { postgresSettings } from './settings.js';

/**
 * The collector's store on PostgreSQL, or on PGlite in embedded mode (ADR 0012): a `pg` pool, or PGlite behind the
 * same Pool API. Migrations are applied before the store is made, and whoever made the pool closes it.
 */
export class PostgresStore implements Store {
  readonly apps: AppStorage;
  readonly keys: KeyStorage;
  readonly sessions: SessionStorage;
  readonly settings: SettingStorage;
  readonly adminAudit: AdminAuditStorage;
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    this.apps = postgresApps(db);
    this.keys = postgresKeys(db);
    this.sessions = postgresSessions(db);
    this.settings = postgresSettings(db);
    this.adminAudit = postgresAdminAudit(db);
  }

  async ready(): Promise<void> {
    await this.#db.query('SELECT 1 FROM pgmigrations LIMIT 1');
  }

  refusedInput(error: unknown): string | undefined {
    return isRefusedInput(error) ? error.code : undefined;
  }
}
