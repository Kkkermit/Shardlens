import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorText } from '../api';
import { NeedsDiscord, useAdminGate } from '../components/AdminGate';
import { DataTable } from '../components/DataTable';
import { ErrorNote, Loading, Name, PageHead, Panel, StatusMessage } from '../components/ui';
import { ago } from '../format';

interface Report {
  id: string;
  name: string;
  schedule: 'daily' | 'weekly';
  hour: number;
  weekday: number;
  webhook: string;
  enabled: boolean;
  lastSent: string | null;
  lastError: string | null;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

function when(report: Report): string {
  const day = report.schedule === 'weekly' ? `Every ${WEEKDAYS[report.weekday - 1]}` : 'Every day';
  return `${day} at ${clock(report.hour)}`;
}

export function ReportsPage() {
  const gate = useAdminGate();
  const client = useQueryClient();
  const reports = useQuery({
    queryKey: ['reports'],
    queryFn: () => api<{ timezone: string; reports: Report[] }>('/v1/reports'),
    enabled: gate.allowed,
  });
  const [form, setForm] = useState({ name: '', schedule: 'daily', hour: '9', weekday: '1', webhookUrl: '' });
  const [message, setMessage] = useState('');
  const refresh = () => client.invalidateQueries({ queryKey: ['reports'] });
  const create = useMutation({
    mutationFn: () =>
      api('/v1/reports', {
        body: {
          name: form.name,
          schedule: form.schedule,
          hour: Number(form.hour),
          weekday: Number(form.weekday),
          webhookUrl: form.webhookUrl.trim(),
        },
      }),
    onSuccess: () => {
      setForm({ ...form, name: '', webhookUrl: '' });
      setMessage('Report created. Use “Send now” to see it in your channel.');
      void refresh();
    },
    onError: (e) => setMessage(errorText(e)),
  });
  const action = async (path: string, method: string, body?: unknown, done?: string) => {
    try {
      await api(path, { method, body: body ?? {} });
      if (done) setMessage(done);
    } catch (e) {
      setMessage(errorText(e));
    }
    void refresh();
  };

  if (gate.loading) return <Loading />;
  if (!gate.allowed) return <NeedsDiscord title="Reports" />;
  const timezone = reports.data?.timezone ?? 'UTC';
  return (
    <>
      <PageHead
        title="Reports"
        description="A daily or weekly summary posted to a Discord channel of your choice: commands run, unique users, failures, response time, servers and your top commands. Counts only."
      />
      <StatusMessage message={message} />
      <div className="stack">
        <Panel title="Scheduled reports" subtitle={`Times are in ${timezone}, the time zone from Settings`}>
          {reports.isLoading ? (
            <Loading />
          ) : reports.error ? (
            <ErrorNote error={reports.error} retry={() => void reports.refetch()} />
          ) : (
            <DataTable
              caption="Scheduled reports"
              rowKey={(r) => r.id}
              rows={reports.data?.reports ?? []}
              empty="No reports yet. Create one below."
              columns={[
                { key: 'name', header: 'Name', render: (r) => <Name>{r.name}</Name> },
                { key: 'when', header: 'Sent', render: when },
                { key: 'webhook', header: 'Webhook', render: (r) => <code>{r.webhook}</code> },
                {
                  key: 'last',
                  header: 'Last sent',
                  render: (r) => {
                    if (!r.lastSent) return 'never';
                    return r.lastError ? `Failed ${ago(r.lastSent)}: ${r.lastError}` : ago(r.lastSent);
                  },
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  render: (r) => (
                    <span className="row-actions">
                      <label>
                        <input
                          type="checkbox"
                          checked={r.enabled}
                          onChange={() => void action(`/v1/reports/${r.id}`, 'PATCH', { enabled: !r.enabled })}
                        />
                        Enabled
                      </label>
                      <button
                        type="button"
                        onClick={() => void action(`/v1/reports/${r.id}/send`, 'POST', {}, 'Report sent.')}
                      >
                        Send now
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Delete the report “${r.name}”?`))
                            void action(`/v1/reports/${r.id}`, 'DELETE');
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
        <Panel
          title="New report"
          subtitle="In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL"
        >
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
                maxLength={64}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              How often
              <select value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            {form.schedule === 'weekly' ? (
              <label>
                Day
                <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: e.target.value })}>
                  {WEEKDAYS.map((day, i) => (
                    <option key={day} value={i + 1}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              At
              <select value={form.hour} onChange={(e) => setForm({ ...form, hour: e.target.value })}>
                {Array.from({ length: 24 }, (_, hour) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the hour is the option's identity
                  <option key={hour} value={hour}>
                    {clock(hour)}
                  </option>
                ))}
              </select>
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
      </div>
    </>
  );
}
