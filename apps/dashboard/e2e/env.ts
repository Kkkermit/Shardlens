/** Fixed test values shared by global setup and the specs. Local test credentials only, never real ones. */
export const PORT = Number(process.env.SHARDLENS_E2E_PORT ?? 18_765);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const APP_ID = '1234567890123456789';
export const INGEST_KEY = `slk_ingest_${'E'.repeat(43)}`;
export const READ_KEY = `slk_read_${'F'.repeat(43)}`;
export const ADMIN_ID = '987654321098765432';
/** A hostile server name: must render as text, never as markup. */
export const XSS_NAME = '<img src=x onerror="window.__xss=1">Evil <b>Server</b>';
