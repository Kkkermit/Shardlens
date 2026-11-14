import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorText, useMeta } from '../api';
import { NeedsDiscord, useAdminGate } from '../components/AdminGate';
import { DataTable } from '../components/DataTable';
import { Loading, PageHead, Panel } from '../components/ui';
import { ago, dateTime } from '../format';

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  windowS: number;
  webhook: string;
  enabled: boolean;
  lastFired: string | null;
}

const METRICS: Record<string, string> = {
  missed_deadline_rate: 'Missed 3 s deadlines (%)',
  error_rate: 'Failed interactions (%)',
  p95_ms: 'p95 response time (ms)',
  invalid_requests_pct: 'Invalid-request budget used (%)',
  stale_shards: 'Shards not reporting',
  interactions_per_min: 'Interactions per minute',
  identify_remaining: 'Identify calls left',
};

export function AlertsPage() {
  const gate = useAdminGate();
  const client = useQueryClient();
  const meta = useMeta();
  const tz = meta.data?.timezone ?? 'UTC';
  const alerts = useQuery({
    queryKey: ['alerts'],
    queryFn: () =>
      api<{
        rules: AlertRule[];
        history: { ts: string; name: string; value: number; delivered: boolean; error: string | null }[];
      }>('/v1/alerts'),
    enabled: gate.allowed,
  });
  const [form, setForm] = useState({
    name: '',
    metric: 'missed_deadline_rate',
    comparator: '>',
    threshold: '1',
    windowMin: '10',
    webhookUrl: '',
  });
  const [message, setMessage] = useState('');
  const refresh = () => client.invalidateQueries({ queryKey: ['alerts'] });
  const create = useMutation({
    mutationFn: () =>
      api('/v1/alerts', {
        body: {
          name: form.name,
          metric: form.metric,
          comparator: form.comparator,
          threshold: Number(form.threshold),
          windowS: Math.round(Number(form.windowMin) * 60),
          webhookUrl: form.webhookUrl.trim(),
        },
      }),
    onSuccess: () => {
      setForm({ ...form, name: '', webhookUrl: '' });
      setMessage('Alert created.');
      void refresh();
    },
    onError: (e) => setMessage(errorText(e)),
  });
  const action = async (path: string, method: string, body?: unknown, done?: string) => {
    try {
      await api(path, { method, body: body ?? {} });
      if (done) setMessage(done);
      void refresh();
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  if (gate.loading) return <Loading />;
  if (!gate.allowed) return <NeedsDiscord />;
  return (
    <>
      <PageHead
        title="Alerts"
        description="Messages to a Discord channel when something needs attention. At most one per rule every 30 minutes."
      />
      {message ? (
        <p role="status" className="notice">
          {message}
        </p>
      ) : null}
      <div className="stack">
        <Panel title="Rules">
          {alerts.isLoading ? (
            <Loading />
          ) : (
            <DataTable
              caption="Alert rules"
              rowKey={(r) => r.id}
              rows={alerts.data?.rules ?? []}
              columns={[
                { key: 'name', header: 'Name', render: (r) => r.name },
                {
                  key: 'rule',
                  header: 'Rule',
                  render: (r) =>
                    `${METRICS[r.metric] ?? r.metric} ${r.comparator} ${r.threshold} over ${Math.round(r.windowS / 60)} min`,
                },
                { key: 'webhook', header: 'Webhook', render: (r) => <code>{r.webhook}</code> },
                { key: 'fired', header: 'Last fired', render: (r) => (r.lastFired ? ago(r.lastFired) : 'never') },
                {
                  key: 'actions',
                  header: 'Actions',
                  render: (r) => (
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button
                        type="button"
                        aria-pressed={r.enabled}
                        onClick={() => void action(`/v1/alerts/${r.id}`, 'PATCH', { enabled: !r.enabled })}
                      >
                        {r.enabled ? 'On' : 'Off'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void action(`/v1/alerts/${r.id}/test`, 'POST', {}, 'Test message sent.')}
                      >
                        Test
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Delete the alert “${r.name}”?`))
                            void action(`/v1/alerts/${r.id}`, 'DELETE');
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Panel>
        <Panel title="New alert">
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              setMessage('');
              create.mutate();
            }}
          >
            <label>
              Name
              <input
                required
                maxLength={100}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              Metric
              <select value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })}>
                {Object.entries(METRICS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="visually-hidden">Comparator</span>
              <select value={form.comparator} onChange={(e) => setForm({ ...form, comparator: e.target.value })}>
                {['>', '>=', '<', '<='].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Threshold
              <input
                required
                type="number"
                step="any"
                value={form.threshold}
                onChange={(e) => setForm({ ...form, threshold: e.target.value })}
                style={{ width: 90 }}
              />
            </label>
            <label>
              Over (minutes)
              <input
                required
                type="number"
                min={1}
                max={1440}
                value={form.windowMin}
                onChange={(e) => setForm({ ...form, windowMin: e.target.value })}
                style={{ width: 80 }}
              />
            </label>
            <label style={{ flex: '1 1 320px' }}>
              Discord webhook URL
              <input
                required
                type="url"
                placeholder="https://discord.com/api/webhooks/…"
                value={form.webhookUrl}
                onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
                style={{ flex: 1 }}
              />
            </label>
            <button type="submit" className="primary" disabled={create.isPending}>
              Create
            </button>
          </form>
        </Panel>
        <Panel title="History">
          <DataTable
            caption="Alert history"
            rowKey={(h) => `${h.ts}-${h.name}`}
            rows={alerts.data?.history ?? []}
            columns={[
              { key: 'ts', header: 'When', render: (h) => dateTime(h.ts, tz) },
              { key: 'name', header: 'Rule', render: (h) => h.name },
              { key: 'value', header: 'Value', numeric: true, render: (h) => Number(h.value).toFixed(2) },
              {
                key: 'delivered',
                header: 'Delivered',
                render: (h) => (h.delivered ? 'Yes' : `No (${h.error ?? 'error'})`),
              },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
