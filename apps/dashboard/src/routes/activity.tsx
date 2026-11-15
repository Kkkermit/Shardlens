import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, useMeta } from '../api';
import { NeedsDiscord, useAdminGate } from '../components/AdminGate';
import { DataTable } from '../components/DataTable';
import { ErrorNote, Loading, PageHead, Panel, Segmented, UserTag } from '../components/ui';
import { commandLabel, dateTime, label, ms, num } from '../format';

const WINDOWS = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
] as const;

interface AuditRow {
  interactionId: string;
  ts: string;
  guildId: string | null;
  guildName: string | null;
  kind: string;
  command: string | null;
  sub: string | null;
  customId: string | null;
  outcome: string;
  ackMs: number | null;
  userId: string | null;
  username: string | null;
  avatar: string | null;
}

export function ActivityPage() {
  const gate = useAdminGate();
  const meta = useMeta();
  const tz = meta.data?.timezone ?? 'UTC';
  const [filters, setFilters] = useState({ command: '', guild: '', user: '' });
  const [applied, setApplied] = useState(filters);
  const [windowSel, setWindowSel] = useState<'24h' | '7d'>('24h');
  const params = new URLSearchParams(Object.entries(applied).filter(([, v]) => v.trim() !== '') as [string, string][]);
  const log = useQuery({
    queryKey: ['audit-log', applied],
    queryFn: () => api<{ rows: AuditRow[] }>(`/v1/audit/log?${params.toString()}`),
    enabled: gate.allowed && meta.data?.mode === 'audit',
  });
  const top = useQuery({
    queryKey: ['audit-top', windowSel],
    queryFn: () => api<{ rows: { userId: string | null; runs: number }[] }>(`/v1/audit/top-users?window=${windowSel}`),
    enabled: gate.allowed && meta.data?.mode === 'audit',
  });

  const exportCsv = async () => {
    if (!window.confirm('Export who ran what as CSV? This export contains user IDs and is recorded in the access log.'))
      return;
    const res = await fetch(`/v1/audit/export.csv?${params.toString()}`, {
      credentials: 'same-origin',
      headers: { 'x-shardlens-csrf': '1', 'x-shardlens-confirm': 'export-audit-log' },
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shardlens-activity.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (gate.loading || meta.isLoading) return <Loading />;
  if (!gate.allowed) return <NeedsDiscord />;
  if (meta.data?.mode !== 'audit') {
    return (
      <>
        <PageHead title="Activity" />
        <Panel title="Audit mode is off">
          <p className="muted">
            Shardlens is in privacy mode: user IDs are hashed in your bot and who ran what is not recorded. Audit mode
            can be switched on in Settings for support and abuse handling.
          </p>
        </Panel>
      </>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied(filters);
  };
  return (
    <>
      <PageHead
        title="Activity"
        description="Who ran what, for support and abuse handling. Every view, lookup and export is logged."
        actions={
          <button type="button" onClick={() => void exportCsv()}>
            Export CSV
          </button>
        }
      />
      <form className="filters" onSubmit={submit}>
        <label>
          Command
          <input
            value={filters.command}
            onChange={(e) => setFilters({ ...filters, command: e.target.value })}
            placeholder="ticket"
          />
        </label>
        <label>
          Server ID
          <input
            value={filters.guild}
            onChange={(e) => setFilters({ ...filters, guild: e.target.value })}
            inputMode="numeric"
          />
        </label>
        <label>
          Exact user ID
          <input
            value={filters.user}
            onChange={(e) => setFilters({ ...filters, user: e.target.value })}
            inputMode="numeric"
          />
        </label>
        <button type="submit">Apply</button>
      </form>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(240px, 1fr)' }}>
        <Panel title="Activity log" subtitle="Newest first, 50 per page">
          {log.isLoading ? (
            <Loading />
          ) : log.error ? (
            <ErrorNote error={log.error} />
          ) : (
            <DataTable
              caption="Activity log"
              rowKey={(r) => r.interactionId}
              rows={log.data?.rows ?? []}
              columns={[
                { key: 'ts', header: 'When', render: (r) => dateTime(r.ts, tz) },
                {
                  key: 'what',
                  header: 'Command',
                  render: (r) =>
                    r.command
                      ? `${commandLabel(r.command, [r.kind])}${r.sub ? ` ${r.sub}` : ''}`
                      : `${label('kind', r.kind)} ${r.customId ?? ''}`,
                },
                { key: 'server', header: 'Server', render: (r) => r.guildName ?? r.guildId ?? 'DM' },
                {
                  key: 'user',
                  header: 'User',
                  render: (r) => <UserTag id={r.userId} username={r.username} avatar={r.avatar} />,
                },
                { key: 'outcome', header: 'Outcome', render: (r) => label('outcome', r.outcome) },
                { key: 'ack', header: 'Response', numeric: true, render: (r) => ms(r.ackMs) },
              ]}
            />
          )}
        </Panel>
        <Panel
          title="Top users"
          subtitle="Counts only, for abuse and support"
          actions={<Segmented label="Top users over" options={WINDOWS} value={windowSel} onChange={setWindowSel} />}
        >
          <DataTable
            caption="Top users"
            rowKey={(r) => String(r.userId)}
            rows={top.data?.rows ?? []}
            columns={[
              { key: 'user', header: 'User ID', render: (r) => <code>{r.userId ?? '—'}</code> },
              { key: 'runs', header: 'Runs', numeric: true, render: (r) => num(r.runs) },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
