import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, errorText } from '../api';
import { NeedsDiscord, useAdminGate } from '../components/AdminGate';
import { DataTable } from '../components/DataTable';
import { Name, PageHead, Panel, QueryBody, StatusMessage, usePanelStatus } from '../components/ui';
import { ago, dateTime, money, num, quoted } from '../format';
import { changedFields, isSnowflake, permissionBitsError } from '../forms';

interface Settings {
  timezone: string;
  rawRetentionDays: number;
  auditRetentionDays: number;
  mode: 'privacy' | 'audit';
  saltPeriod: 'day' | 'week' | 'month';
  requiredPermissions: string | null;
  skuPrices: Record<string, { amount: number; currency: string }>;
  badges: string[];
  auditKeyConfigured: boolean;
}

interface Key {
  id: string;
  scope: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const BADGES: Record<string, string> = {
  servers: 'Server count',
  'users-monthly': 'Monthly users',
  'commands-daily': 'Commands per day',
};

/** `rows: 3, command: ticket`: the filters that were used, without the ones that were not. */
function describeDetails(details: unknown): string {
  if (typeof details !== 'object' || details === null) return '';
  return Object.entries(details)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(', ');
}

export function SettingsPage() {
  const gate = useAdminGate();
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/v1/settings'),
    enabled: gate.allowed,
  });
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => api<{ rows: Key[] }>('/v1/keys'), enabled: gate.allowed });
  const access = useQuery({
    queryKey: ['access-log'],
    queryFn: () =>
      api<{ rows: { ts: string; viewerUserId: string; action: string; details: Record<string, unknown> }[] }>(
        '/v1/audit/access-log',
      ),
    enabled: gate.allowed,
  });
  const [messageFor, say] = usePanelStatus();
  // The key just created, shown once, until it is revoked.
  const [newKey, setNewKey] = useState<{ id: string; key: string }>();
  const [eraseId, setEraseId] = useState('');
  const [erasing, setErasing] = useState(false);
  const save = useMutation({
    // Only what was changed, so a form can't put back a value it didn't show (a time zone this browser doesn't list).
    mutationFn: (patch: Partial<Settings>) =>
      api<Settings>('/v1/settings', {
        method: 'PUT',
        body: settings.data ? changedFields(settings.data, patch) : patch,
      }),
    onSuccess: (data) => {
      client.setQueryData(['settings'], data);
      void client.invalidateQueries({ queryKey: ['meta'] });
    },
  });
  /** Saves part of the settings from one panel, and says how it went in that panel. */
  const saveFrom = (panel: string, patch: Partial<Settings>, done?: () => void) => {
    say(panel, '');
    save.mutate(patch, {
      onSuccess: () => {
        say(panel, 'Saved.');
        done?.();
      },
      onError: (e) => say(panel, errorText(e)),
    });
  };

  if (!gate.allowed && !gate.loading) return <NeedsDiscord title="Settings" />;
  const s = settings.data;
  if (gate.loading || !s) {
    return (
      <>
        <PageHead title="Settings" />
        <QueryBody query={[{ isLoading: gate.loading, error: null }, settings]}>{null}</QueryBody>
      </>
    );
  }
  const timezones = [...new Set([s.timezone, 'UTC', ...Intl.supportedValuesOf('timeZone')])];

  const createKey = async (scope: 'ingest' | 'read') => {
    const name = window.prompt(`Label for the new ${scope} key`, scope === 'ingest' ? 'bot' : 'scripts');
    if (!name) return;
    say('keys', '');
    try {
      const res = await api<{ id: string; key: string }>('/v1/keys', { body: { scope, label: name } });
      setNewKey({ id: res.id, key: res.key });
      void client.invalidateQueries({ queryKey: ['keys'] });
    } catch (e) {
      say('keys', errorText(e));
    }
  };
  const revokeKey = async (k: Key) => {
    if (
      !window.confirm(`Revoke ${k.label ? quoted(k.label) : 'this key'}? Anything using it stops working immediately.`)
    )
      return;
    say('keys', '');
    try {
      await api(`/v1/keys/${k.id}`, { method: 'DELETE', body: {} });
      if (newKey?.id === k.id) setNewKey(undefined);
      say('keys', `${k.label ? quoted(k.label) : 'The key'} is revoked.`);
    } catch (err) {
      say('keys', errorText(err));
    }
    void client.invalidateQueries({ queryKey: ['keys'] });
  };
  const erase = async (e: FormEvent) => {
    e.preventDefault();
    if (erasing) return;
    const userId = eraseId.trim();
    if (!isSnowflake(userId)) return say('privacy', 'Enter a Discord user ID: 17 to 19 digits.');
    if (!window.confirm('Delete everything stored about this user? This cannot be undone.')) return;
    say('privacy', '');
    setErasing(true);
    try {
      const res = await api<{ erased: number }>('/v1/privacy/erase', { body: { userId } });
      say('privacy', `Erased ${num(res.erased)} records.`);
      setEraseId('');
      void client.invalidateQueries({ queryKey: ['access-log'] });
    } catch (err) {
      say('privacy', errorText(err));
    } finally {
      setErasing(false);
    }
  };
  const addPrice = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const sku = String(f.get('sku')).trim();
    const amount = Number(f.get('amount'));
    const currency = String(f.get('currency')).trim().toUpperCase();
    if (!isSnowflake(sku)) return say('prices', 'Enter the SKU ID from the Discord developer portal: 17 to 19 digits.');
    if (!Number.isFinite(amount) || amount < 0) return say('prices', 'Enter a price of 0 or more.');
    if (!/^[A-Z]{3}$/.test(currency)) return say('prices', 'Enter a three-letter currency code, such as USD or EUR.');
    saveFrom('prices', { skuPrices: { ...s.skuPrices, [sku]: { amount, currency } } }, () => form.reset());
  };
  const removePrice = (sku: string) => {
    const rest = { ...s.skuPrices };
    delete rest[sku];
    saveFrom('prices', { skuPrices: rest });
  };
  const origin = window.location.origin;

  return (
    <>
      <PageHead title="Settings" />
      <div className="stack">
        <Panel title="General">
          <StatusMessage message={messageFor('general')} />
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              saveFrom('general', { timezone: String(f.get('timezone')), rawRetentionDays: Number(f.get('raw')) });
            }}
          >
            <label>
              Time zone
              <select name="timezone" defaultValue={s.timezone}>
                {timezones.map((tz) => (
                  <option key={tz}>{tz}</option>
                ))}
              </select>
            </label>
            <label>
              Keep raw events (days)
              <input name="raw" type="number" min={7} max={90} defaultValue={s.rawRetentionDays} className="narrow" />
            </label>
            <button type="submit">Save</button>
          </form>
        </Panel>

        <Panel
          title="User identity"
          subtitle="Choose whether users are hashed inside your bot, or identified so you can see who ran what."
        >
          <p className="muted">
            <strong>Hashed</strong> (privacy mode) never sends a user ID: you get counts of unique users, not people.{' '}
            <strong>Identified</strong> (audit mode) records the user ID, username and avatar of whoever ran each
            interaction, and nothing else about them. It is meant for support and abuse handling, needs{' '}
            <code>mode: 'audit'</code> in the SDK and <code>SHARDLENS_AUDIT_KEY</code> on the collector, stores
            identities encrypted for at most 90 days and logs every view. Tell your users in your privacy policy if you
            turn it on.
          </p>
          <StatusMessage message={messageFor('identity')} />
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const mode = String(f.get('mode')) as Settings['mode'];
              if (
                mode === 'audit' &&
                s.mode !== 'audit' &&
                !window.confirm('Identify users from now on? Their ID, username and avatar will be recorded.')
              )
                return;
              saveFrom('identity', {
                mode,
                auditRetentionDays: Number(f.get('auditDays')),
                saltPeriod: String(f.get('salt')) as Settings['saltPeriod'],
              });
            }}
          >
            <label>
              Mode
              <select name="mode" defaultValue={s.mode}>
                <option value="privacy">Hashed: user IDs never leave your bot (default)</option>
                <option value="audit" disabled={!s.auditKeyConfigured}>
                  Identified: user ID, username and avatar
                  {s.auditKeyConfigured ? '' : ' (set SHARDLENS_AUDIT_KEY first)'}
                </option>
              </select>
            </label>
            <label>
              Audit retention (days, max 90)
              <input
                name="auditDays"
                type="number"
                min={1}
                max={90}
                defaultValue={s.auditRetentionDays}
                className="narrow"
              />
            </label>
            <label>
              Salt period
              <select name="salt" defaultValue={s.saltPeriod}>
                <option value="month">Month (weekly and monthly users)</option>
                <option value="week">Week</option>
                <option value="day">Day (strictest, daily users only)</option>
              </select>
            </label>
            <button type="submit">Save</button>
          </form>
        </Panel>

        <Panel title="Permission health" subtitle="Servers where your bot lacks these permissions are flagged">
          <StatusMessage message={messageFor('permissions')} />
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              const v = String(new FormData(e.currentTarget).get('perms')).trim();
              const problem = permissionBitsError(v);
              if (problem) return say('permissions', problem);
              saveFrom('permissions', { requiredPermissions: v === '' ? null : v });
            }}
          >
            <label>
              Required permission bits (decimal)
              <input
                name="perms"
                inputMode="numeric"
                pattern="\d*"
                defaultValue={s.requiredPermissions ?? ''}
                placeholder="e.g. 277025770560"
              />
            </label>
            <button type="submit">Save</button>
          </form>
        </Panel>

        <Panel title="Public badges" subtitle="Opt-in SVG badges for READMEs and bot lists">
          <StatusMessage message={messageFor('badges')} />
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              saveFrom('badges', { badges: Object.keys(BADGES).filter((b) => f.get(b) === 'on') });
            }}
          >
            {Object.entries(BADGES).map(([k, v]) => (
              <label key={k}>
                <input type="checkbox" name={k} defaultChecked={s.badges.includes(k)} /> {v}
              </label>
            ))}
            <button type="submit">Save</button>
          </form>
          {s.badges.map((b) => (
            <p key={b} className="muted">
              <code>{`![${BADGES[b]}](${origin}/v1/badge/${b}.svg)`}</code>
            </p>
          ))}
        </Panel>

        <Panel
          title="SKU prices"
          subtitle="The monthly price of each subscription SKU, for the estimated revenue on the Premium page. Discord sends SKU IDs, not amounts."
        >
          <DataTable
            caption="SKU prices"
            rowKey={(r) => r.sku}
            rows={Object.entries(s.skuPrices).map(([sku, price]) => ({ sku, ...price }))}
            empty="No prices yet."
            columns={[
              { key: 'sku', header: 'SKU ID', render: (r) => <code>{r.sku}</code> },
              {
                key: 'price',
                header: 'Per month',
                numeric: true,
                render: (r) => money(r.amount, r.currency),
              },
              {
                key: 'remove',
                header: 'Actions',
                hideHeader: true,
                render: (r) => (
                  <button type="button" disabled={save.isPending} onClick={() => removePrice(r.sku)}>
                    Remove
                  </button>
                ),
              },
            ]}
          />
          <StatusMessage message={messageFor('prices')} />
          <form className="filters" onSubmit={addPrice}>
            <label>
              SKU ID
              <input name="sku" inputMode="numeric" required />
            </label>
            <label>
              Price
              <input name="amount" type="number" min={0} max={1_000_000} step="0.01" required className="narrow" />
            </label>
            <label>
              Currency
              <input name="currency" maxLength={3} placeholder="USD" required className="narrow" />
            </label>
            <button type="submit" disabled={save.isPending}>
              Save price
            </button>
          </form>
        </Panel>

        <Panel
          title="API keys"
          subtitle="Ingest keys are for your bot; read keys for scripts and read-only dashboard access"
        >
          {newKey ? (
            <div className="notice" role="status">
              Copy this key now; it will not be shown again: <code>{newKey.key}</code>
            </div>
          ) : null}
          <StatusMessage message={messageFor('keys')} />
          <div className="filters">
            <button type="button" onClick={() => void createKey('ingest')}>
              New ingest key
            </button>
            <button type="button" onClick={() => void createKey('read')}>
              New read key
            </button>
          </div>
          <QueryBody query={keys}>
            <DataTable
              caption="API keys"
              rowKey={(k) => k.id}
              rows={keys.data?.rows ?? []}
              columns={[
                { key: 'label', header: 'Label', render: (k) => (k.label ? <Name>{k.label}</Name> : '—') },
                { key: 'scope', header: 'Scope', render: (k) => k.scope },
                { key: 'used', header: 'Last used', render: (k) => ago(k.lastUsedAt) },
                { key: 'status', header: 'Status', render: (k) => (k.revokedAt ? 'Revoked' : 'Active') },
                {
                  key: 'revoke',
                  header: 'Actions',
                  hideHeader: true,
                  render: (k) =>
                    k.revokedAt ? null : (
                      <button type="button" onClick={() => void revokeKey(k)}>
                        Revoke
                      </button>
                    ),
                },
              ]}
            />
          </QueryBody>
        </Panel>

        <Panel title="Privacy" subtitle="Right to erasure, and who looked at audit data">
          <StatusMessage message={messageFor('privacy')} />
          <form className="filters" onSubmit={(e) => void erase(e)}>
            <label>
              Erase a user by Discord ID
              <input value={eraseId} onChange={(e) => setEraseId(e.target.value)} inputMode="numeric" />
            </label>
            <button type="submit" disabled={erasing}>
              {erasing ? 'Erasing…' : 'Erase'}
            </button>
          </form>
          <QueryBody query={access}>
            <DataTable
              caption="Audit access log"
              rowKey={(r) => String(r.n)}
              rows={(access.data?.rows ?? []).map((row, n) => ({ ...row, n }))}
              columns={[
                { key: 'ts', header: 'When', render: (r) => dateTime(r.ts, s.timezone) },
                {
                  key: 'who',
                  header: 'Viewer',
                  render: (r) => (r.viewerUserId === '0' ? 'SDK' : <code>{r.viewerUserId}</code>),
                },
                { key: 'action', header: 'Action', render: (r) => r.action },
                { key: 'details', header: 'Details', render: (r) => <code>{describeDetails(r.details)}</code> },
              ]}
            />
          </QueryBody>
        </Panel>
      </div>
    </>
  );
}
