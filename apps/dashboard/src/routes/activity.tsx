import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, useMeta } from '../api';
import { NeedsDiscord, useAdminGate } from '../components/AdminGate';
import { DataTable } from '../components/DataTable';
import {
  ErrorNote,
  Loading,
  Name,
  PageHead,
  Panel,
  QueryBody,
  Segmented,
  StatusMessage,
  UserTag,
} from '../components/ui';
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
  // Cursors of the pages shown so far: `nextBefore` of each, newest page first. Empty on the newest page.
  const [pages, setPages] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [windowSel, setWindowSel] = useState<'24h' | '7d'>('24h');
  const params = new URLSearchParams(
    Object.entries(applied)
      .map(([k, v]) => [k, v.trim()] as [string, string])
      .filter(([, v]) => v !== ''),
  );
  const before = pages.at(-1);
  const pageParams = new URLSearchParams(params);
  if (before) pageParams.set('before', before);
  const log = useQuery({
    queryKey: ['audit-log', applied, before],
    queryFn: () => api<{ rows: AuditRow[]; nextBefore: string | null }>(`/v1/audit/log?${pageParams.toString()}`),
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
    setMessage('');
    const res = await fetch(`/v1/audit/export.csv?${params.toString()}`, {
      credentials: 'same-origin',
      headers: { 'x-shardlens-csrf': '1', 'x-shardlens-confirm': 'export-audit-log' },
    }).catch(() => undefined);
    if (!res?.ok) {
      setMessage(
        res?.status === 429
          ? 'Too many exports. Wait a minute and try again.'
          : `The export failed${res ? ` (${res.status})` : ''}. Try again.`,
      );
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shardlens-activity.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (gate.loading || meta.isLoading) return <Loading />;
  if (!gate.allowed) return <NeedsDiscord title="Activity" />;
  // Without the mode there is nothing to go on: never say privacy mode because the request failed.
  if (!meta.data) {
    return (
      <>
        <PageHead title="Activity" />
        <ErrorNote error={meta.error} retry={() => void meta.refetch()} />
      </>
    );
  }
  if (meta.data.mode !== 'audit') {
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
    setPages([]);
  };
  const nextBefore = log.data?.nextBefore ?? null;
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
      <StatusMessage message={message} />
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
        <Panel
          title="Activity log"
          subtitle={pages.length === 0 ? 'Newest first, 50 per page' : `Newest first, page ${pages.length + 1}`}
        >
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
                    r.command ? (
                      <>
                        <Name>{commandLabel(r.command, [r.kind])}</Name>
                        {r.sub ? (
                          <>
                            {' '}
                            <Name>{r.sub}</Name>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <>
                        {label('kind', r.kind)} {r.customId ? <Name>{r.customId}</Name> : null}
                      </>
                    ),
                },
                {
                  key: 'server',
                  header: 'Server',
                  render: (r) => (r.guildName ? <Name>{r.guildName}</Name> : (r.guildId ?? 'DM')),
                },
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
          {pages.length > 0 || nextBefore ? (
            <div className="filters" style={{ marginTop: 12, marginBottom: 0 }}>
              <button type="button" disabled={pages.length === 0} onClick={() => setPages([])}>
                Newest
              </button>
              <button type="button" disabled={pages.length === 0} onClick={() => setPages(pages.slice(0, -1))}>
                Newer
              </button>
              <button
                type="button"
                disabled={!nextBefore}
                onClick={() => {
                  if (nextBefore) setPages([...pages, nextBefore]);
                }}
              >
                Older
              </button>
            </div>
          ) : null}
        </Panel>
        <Panel
          title="Top users"
          subtitle="Counts only, for abuse and support"
          actions={<Segmented label="Top users over" options={WINDOWS} value={windowSel} onChange={setWindowSel} />}
        >
          <QueryBody query={top}>
            <DataTable
              caption="Top users"
              rowKey={(r) => String(r.userId)}
              rows={top.data?.rows ?? []}
              columns={[
                { key: 'user', header: 'User ID', render: (r) => <code>{r.userId ?? '—'}</code> },
                { key: 'runs', header: 'Runs', numeric: true, render: (r) => num(r.runs) },
              ]}
            />
          </QueryBody>
        </Panel>
      </div>
    </>
  );
}
