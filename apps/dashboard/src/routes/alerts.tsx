import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorText, useMeta } from '../api';
import { NeedsDiscord, useAdminGate } from '../components/AdminGate';
import { DataTable } from '../components/DataTable';
import { Name, PageHead, Panel, QueryBody, StatusMessage, usePanelStatus } from '../components/ui';
import { ago, dateTime, decimal, number } from '../format';

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
        history: {
          ts: string;
          ruleId: string;
          name: string;
          value: number;
          delivered: boolean;
          error: string | null;
        }[];
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
  const [messageFor, say] = usePanelStatus();
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
      say('new', 'Alert created.');
      void refresh();
    },
    onError: (e) => say('new', errorText(e)),
  });
  const action = async (path: string, method: string, body: unknown, done: string, failed: string) => {
    say('rules', '');
    try {
      await api(path, { method, body });
      say('rules', done);
    } catch (e) {
      say('rules', `${failed} ${errorText(e)}`);
    }
    void refresh();
  };

  if (!gate.allowed && !gate.loading) return <NeedsDiscord title="Alerts" />;
  return (
    <>
      <PageHead
        title="Alerts"
        description="Messages to a Discord channel when something needs attention. At most one per rule every 30 minutes."
      />
      <QueryBody query={{ isLoading: gate.loading, error: null }}>
        <div className="stack">
          <Panel title="Rules">
            <StatusMessage message={messageFor('rules')} />
            <QueryBody query={alerts}>
              <DataTable
                caption="Alert rules"
                rowKey={(r) => r.id}
                rows={alerts.data?.rules ?? []}
                columns={[
                  { key: 'name', header: 'Name', render: (r) => <Name>{r.name}</Name> },
                  {
                    key: 'rule',
                    header: 'Rule',
                    render: (r) =>
                      `${METRICS[r.metric] ?? r.metric} ${r.comparator} ${number(r.threshold)} over ${number(r.windowS / 60)} min`,
                  },
                  { key: 'webhook', header: 'Webhook', render: (r) => <code>{r.webhook}</code> },
                  { key: 'fired', header: 'Last fired', render: (r) => (r.lastFired ? ago(r.lastFired) : 'never') },
                  {
                    key: 'actions',
                    header: 'Actions',
                    render: (r) => (
                      <span className="row-actions">
                        <label>
                          <input
                            type="checkbox"
                            checked={r.enabled}
                            onChange={() =>
                              void action(
                                `/v1/alerts/${r.id}`,
                                'PATCH',
                                { enabled: !r.enabled },
                                r.enabled ? `“${r.name}” is off.` : `“${r.name}” is on.`,
                                `Couldn't change “${r.name}”.`,
                              )
                            }
                          />
                          Enabled
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            void action(
                              `/v1/alerts/${r.id}/test`,
                              'POST',
                              {},
                              `Test message for “${r.name}” sent.`,
                              `The test message for “${r.name}” failed.`,
                            )
                          }
                        >
                          Test
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`Delete the alert “${r.name}”?`))
                              void action(
                                `/v1/alerts/${r.id}`,
                                'DELETE',
                                {},
                                `“${r.name}” deleted.`,
                                `Couldn't delete “${r.name}”.`,
                              );
                          }}
                        >
                          Delete
                        </button>
                      </span>
                    ),
                  },
                ]}
              />
            </QueryBody>
          </Panel>
          <Panel title="New alert">
            <StatusMessage message={messageFor('new')} />
            <form
              className="filters"
              onSubmit={(e) => {
                e.preventDefault();
                say('new', '');
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
                  className="narrow"
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
                  className="narrow"
                />
              </label>
              <label className="wide-field">
                Discord webhook URL
                <input
                  required
                  type="url"
                  placeholder="https://discord.com/api/webhooks/…"
                  value={form.webhookUrl}
                  onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
                />
              </label>
              <button type="submit" className="primary" disabled={create.isPending}>
                Create
              </button>
            </form>
          </Panel>
          <Panel title="History">
            <QueryBody query={alerts}>
              <DataTable
                caption="Alert history"
                rowKey={(h) => `${h.ts}-${h.ruleId}`}
                rows={alerts.data?.history ?? []}
                columns={[
                  { key: 'ts', header: 'When', render: (h) => dateTime(h.ts, tz) },
                  { key: 'name', header: 'Rule', render: (h) => <Name>{h.name}</Name> },
                  {
                    key: 'value',
                    header: 'Value',
                    numeric: true,
                    render: (h) => decimal(Number(h.value), 2),
                  },
                  {
                    key: 'delivered',
                    header: 'Delivered',
                    render: (h) => (h.delivered ? 'Yes' : `No (${h.error ?? 'error'})`),
                  },
                ]}
              />
            </QueryBody>
          </Panel>
        </div>
      </QueryBody>
    </>
  );
}
