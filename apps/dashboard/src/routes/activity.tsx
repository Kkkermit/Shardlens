import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { type ActivitySearch, OUTCOME_FILTERS, parseActivitySearch } from '../activity-search';
import { api, errorText, request, useMeta } from '../api';
import { NeedsDiscord, useAdminGate } from '../components/AdminGate';
import { DataTable } from '../components/DataTable';
import { Name, PageHead, Pager, Panel, QueryBody, Segmented, StatusMessage, UserTag } from '../components/ui';
import { commandLabel, dateTime, label, ms, num } from '../format';
import { activityFilterError } from '../forms';

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

const withUser = (search: ActivitySearch, user: string): ActivitySearch & { user?: string } =>
  user ? { ...search, user } : search;

export function ActivityPage() {
  const gate = useAdminGate();
  const meta = useMeta();
  const tz = meta.data?.timezone ?? 'UTC';
  const navigate = useNavigate();
  const { command, guild, outcome } = useSearch({ from: '/activity' });
  const [filters, setFilters] = useState({
    command: command ?? '',
    guild: guild ?? '',
    outcome: outcome ?? '',
    user: '',
  });
  // The address's filters plus the user ID, which stays out of the address: one value, so Apply changes both at once.
  const [applied, setApplied] = useState<ActivitySearch & { user?: string }>(() =>
    parseActivitySearch({ command, guild, outcome }),
  );
  // The form and the log follow the address when it changes from elsewhere (Back, a link from a server's page).
  useEffect(() => {
    setFilters((typed) => ({ ...typed, command: command ?? '', guild: guild ?? '', outcome: outcome ?? '' }));
    setApplied((was) => withUser(parseActivitySearch({ command, guild, outcome }), was.user ?? ''));
  }, [command, guild, outcome]);
  const appliedKey = JSON.stringify(applied);
  // `nextBefore` of each page shown so far, for these filters only: new filters start at the newest page.
  const [paging, setPaging] = useState<{ filters: string; cursors: string[] }>({ filters: appliedKey, cursors: [] });
  const pages = paging.filters === appliedKey ? paging.cursors : [];
  const setPages = (cursors: string[]) => setPaging({ filters: appliedKey, cursors });
  const [message, setMessage] = useState('');
  const [windowSel, setWindowSel] = useState<'24h' | '7d'>('24h');
  const params = new URLSearchParams({ ...applied });
  const before = pages.at(-1);
  const pageParams = new URLSearchParams(params);
  if (before) pageParams.set('before', before);
  const log = useQuery({
    queryKey: ['audit-log', appliedKey, before],
    queryFn: () => api<{ rows: AuditRow[]; nextBefore: string | null }>(`/v1/audit/log?${pageParams.toString()}`),
    enabled: gate.allowed && meta.data?.mode === 'audit',
    placeholderData: keepPreviousData,
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
    try {
      const res = await request(`/v1/audit/export.csv?${params.toString()}`, {
        headers: { accept: 'text/csv', 'x-shardlens-csrf': '1', 'x-shardlens-confirm': 'export-audit-log' },
      });
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'shardlens-activity.csv';
      a.click();
      URL.revokeObjectURL(url);
      setMessage('Exported. The download is in your browser.');
    } catch (error) {
      setMessage(`The export failed. ${errorText(error)}`);
    }
  };

  if (!gate.allowed && !gate.loading) return <NeedsDiscord title="Activity" />;
  // Without the mode there is nothing to go on: never say privacy mode because the request failed.
  if (gate.loading || !meta.data) {
    return (
      <>
        <PageHead title="Activity" />
        <QueryBody query={[{ isLoading: gate.loading, error: null }, meta]}>{null}</QueryBody>
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
    const problem = activityFilterError(filters);
    setMessage(problem);
    if (problem) return;
    const search = parseActivitySearch(filters);
    setApplied(withUser(search, filters.user.trim()));
    void navigate({ to: '/activity', search });
  };
  // While another page loads, the buttons wait for it: its cursor isn't known yet.
  const nextBefore = log.isPlaceholderData ? null : (log.data?.nextBefore ?? null);
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
          Outcome
          <select value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}>
            <option value="">Any</option>
            {OUTCOME_FILTERS.map((o) => (
              <option key={o} value={o}>
                {o === 'failed' ? 'Failed' : label('outcome', o)}
              </option>
            ))}
          </select>
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
      <div className="grid log">
        <Panel
          title="Activity log"
          subtitle={pages.length === 0 ? 'Newest first, 50 per page' : `Newest first, page ${pages.length + 1}`}
          busy={log.isPlaceholderData}
        >
          <QueryBody query={log}>
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
                        <Link to="/commands/$name" params={{ name: r.command }}>
                          <Name>{commandLabel(r.command, [r.kind])}</Name>
                        </Link>
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
                  render: (r) =>
                    r.guildId ? (
                      <Link to="/servers/$id" params={{ id: r.guildId }}>
                        {r.guildName ? <Name>{r.guildName}</Name> : <code>{r.guildId}</code>}
                      </Link>
                    ) : (
                      'DM'
                    ),
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
          </QueryBody>
          {pages.length > 0 || nextBefore ? (
            <Pager
              label="Pages of the activity log"
              buttons={[
                { label: 'Newest', onClick: pages.length > 0 ? () => setPages([]) : undefined },
                { label: 'Newer', onClick: pages.length > 0 ? () => setPages(pages.slice(0, -1)) : undefined },
                { label: 'Older', onClick: nextBefore ? () => setPages([...pages, nextBefore]) : undefined },
              ]}
            />
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
