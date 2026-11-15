import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useMeta, useSpec } from '../api';
import { pivot } from '../chart-data';
import { BarList, TimeChart } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { ErrorNote, GuildIcon, Loading, PageHead, Panel, RangePicker, Tile } from '../components/ui';
import { ago, date, dateTime, label, num } from '../format';
import { useRange } from '../range';

interface ServerRow {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
  boosts: number | null;
  locale: string | null;
  features: string[];
  joinedAt: string;
  leftAt: string | null;
  shard: number | null;
  lastActive: string | null;
  runs: number;
  baseline: boolean;
}

const PAGE = 50;

export function ServersPage() {
  const navigate = useNavigate();
  const meta = useMeta();
  const tz = meta.data?.timezone ?? 'UTC';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'active' | 'left' | 'all'>('active');
  const [size, setSize] = useState('');
  const [inactive, setInactive] = useState(false);
  const [missing, setMissing] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'members', dir: 'desc' });
  const [page, setPage] = useState(0);
  const spec = {
    kind: 'servers',
    status,
    sort: sort.key,
    order: sort.dir,
    limit: PAGE,
    offset: page * PAGE,
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(size ? { size } : {}),
    ...(inactive ? { inactive: true } : {}),
    ...(missing ? { missingPermissions: true } : {}),
  };
  const q = useSpec<{ total: number; rows: ServerRow[] }>(spec);
  const total = q.data?.total ?? 0;
  const reset = () => setPage(0);

  return (
    <>
      <PageHead title="Servers" description={`${num(total)} servers match`} />
      <search className="filters">
        <label>
          <span className="visually-hidden">Search server names</span>
          <input
            type="search"
            placeholder="Search names"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              reset();
            }}
          />
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status);
              reset();
            }}
          >
            <option value="active">Installed</option>
            <option value="left">Removed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Size
          <select
            value={size}
            onChange={(e) => {
              setSize(e.target.value);
              reset();
            }}
          >
            <option value="">Any</option>
            {['1-10', '11-100', '101-1k', '1k-10k', '10k+'].map((s) => (
              <option key={s} value={s}>
                {s} members
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={inactive}
            onChange={(e) => {
              setInactive(e.target.checked);
              reset();
            }}
          />
          No commands in 30 days
        </label>
        <label>
          <input
            type="checkbox"
            checked={missing}
            onChange={(e) => {
              setMissing(e.target.checked);
              reset();
            }}
          />
          Missing permissions
        </label>
      </search>
      <Panel title="Server list" subtitle="Runs are the last 30 days">
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorNote error={q.error} />
        ) : (
          <>
            <DataTable
              caption="Servers"
              rows={q.data?.rows ?? []}
              rowKey={(row) => row.id}
              initialSort={sort}
              onSort={(key, dir) => {
                setSort({ key, dir });
                reset();
              }}
              onRowClick={(row) => void navigate({ to: '/servers/$id', params: { id: row.id } })}
              columns={[
                {
                  key: 'name',
                  header: 'Server',
                  sort: (row) => row.name,
                  render: (row) => <GuildIcon id={row.id} icon={row.icon} name={row.name || row.id} />,
                },
                {
                  key: 'members',
                  header: 'Members',
                  numeric: true,
                  sort: (row) => row.memberCount,
                  render: (row) => num(row.memberCount),
                },
                { key: 'runs', header: 'Runs', numeric: true, sort: (row) => row.runs, render: (row) => num(row.runs) },
                {
                  key: 'last_active',
                  header: 'Last active',
                  sort: (row) => row.lastActive,
                  render: (row) => ago(row.lastActive),
                },
                {
                  key: 'joined',
                  header: 'Added',
                  sort: (row) => row.joinedAt,
                  render: (row) =>
                    row.baseline ? <span className="muted">before Shardlens</span> : date(row.joinedAt, tz),
                },
                { key: 'locale', header: 'Locale', render: (row) => row.locale ?? '—' },
                { key: 'boosts', header: 'Boosts', numeric: true, render: (row) => num(row.boosts) },
                { key: 'shard', header: 'Shard', numeric: true, render: (row) => num(row.shard) },
              ]}
            />
            <div className="filters" style={{ marginTop: 12, marginBottom: 0 }}>
              <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span className="muted">
                Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE))}
              </span>
              <button type="button" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}

interface ServerDetail {
  found: boolean;
  profile?: {
    id: string;
    name: string;
    icon: string | null;
    memberCount: number;
    sizeAtJoin: number | null;
    locale: string | null;
    features: string[];
    premiumTier: number | null;
    boosts: number | null;
    verificationLevel: number | null;
    createdAt: string | null;
    joinedAt: string;
    leftAt: string | null;
    shard: number | null;
    channelCounts: Record<string, number> | null;
    roleCount: number | null;
    emojiCount: number | null;
    stickerCount: number | null;
    botPermissions: string | null;
    baseline: boolean;
    detectedAtStartup: boolean;
    firstCommandAt: string | null;
    lastCommandAt: string | null;
  };
  events?: { ts: string; kind: string; detectedAtStartup: boolean }[];
  uniqueUsersThisPeriod?: number | null;
  periodStart?: string;
  missingPermissions?: string | null;
}

const CHANNEL_TYPES: Record<string, string> = {
  '0': 'Text',
  '2': 'Voice',
  '4': 'Categories',
  '5': 'Announcement',
  '13': 'Stage',
  '15': 'Forum',
  '16': 'Media',
};

export function ServerPage() {
  const { id } = useParams({ from: '/servers/$id' });
  const r = useRange();
  const meta = useMeta();
  const tz = meta.data?.timezone ?? 'UTC';
  const filters = [{ field: 'guild', value: id }];
  const detail = useSpec<ServerDetail>({ kind: 'server', guild: id });
  const series = useSpec<{ points: { t: string; key: string | null; value: number | null }[] }>({
    kind: 'series',
    metric: 'interactions',
    range: r.range,
    interval: r.interval,
    filters,
    timezone: tz,
  });
  const commands = useSpec<{ rows: { key: string; count: number }[] }>({
    kind: 'top',
    metric: 'interactions',
    range: r.range,
    groupBy: 'command',
    filters,
    limit: 10,
  });
  const outcomes = useSpec<{ rows: { key: string; count: number }[] }>({
    kind: 'top',
    metric: 'interactions',
    range: r.range,
    groupBy: 'outcome',
    filters,
  });
  const chart = useMemo(() => pivot(series.data?.points ?? [], () => 'Runs'), [series.data]);
  const p = detail.data?.profile;

  if (detail.isLoading) return <Loading />;
  if (detail.error) return <ErrorNote error={detail.error} />;
  if (!detail.data?.found || !p) {
    return <PageHead title="Server not found" description={<Link to="/servers">← All servers</Link>} />;
  }
  return (
    <>
      <PageHead
        title={p.name || p.id}
        description={<Link to="/servers">← All servers</Link>}
        actions={<RangePicker value={r.id} onChange={r.setId} />}
      />
      <div className="stack">
        <div className="grid tiles">
          <Tile
            label="Members"
            value={num(p.memberCount)}
            sub={p.sizeAtJoin != null ? `${num(p.sizeAtJoin)} when added` : undefined}
          />
          <Tile
            label="Unique users"
            value={num(detail.data.uniqueUsersThisPeriod)}
            sub={`Since ${detail.data.periodStart}`}
          />
          <Tile label="Last command" value={ago(p.lastCommandAt)} />
          <Tile
            label="Status"
            value={p.leftAt ? 'Removed' : 'Installed'}
            sub={
              p.leftAt
                ? `Removed ${date(p.leftAt, tz)}`
                : p.baseline
                  ? 'Added before Shardlens'
                  : `Added ${date(p.joinedAt, tz)}`
            }
          />
        </div>
        <Panel title="Runs over time" subtitle={tz}>
          <TimeChart
            label="Runs in this server over time"
            x={chart.x}
            series={chart.series}
            withTime={r.interval === 'hour'}
            timezone={tz}
          />
        </Panel>
        <div className="grid three">
          <Panel title="Top commands">
            <BarList
              label="Top commands"
              rows={(commands.data?.rows ?? []).map((c) => ({ key: c.key, name: `/${c.key}`, value: c.count }))}
            />
          </Panel>
          <Panel title="Outcomes">
            <BarList
              label="Outcomes"
              rows={(outcomes.data?.rows ?? []).map((c) => ({
                key: c.key,
                name: label('outcome', c.key),
                value: c.count,
              }))}
            />
          </Panel>
          <Panel title="Profile">
            <dl className="dl">
              <dt>Locale</dt>
              <dd>{p.locale ?? '—'}</dd>
              <dt>Boosts</dt>
              <dd>
                {num(p.boosts)} (tier {p.premiumTier ?? 0})
              </dd>
              <dt>Created</dt>
              <dd>{date(p.createdAt, tz)}</dd>
              <dt>Shard</dt>
              <dd>{num(p.shard)}</dd>
              <dt>Roles · emoji · stickers</dt>
              <dd>
                {num(p.roleCount)} · {num(p.emojiCount)} · {num(p.stickerCount)}
              </dd>
              <dt>Channels</dt>
              <dd>
                {Object.entries(p.channelCounts ?? {})
                  .map(([type, n]) => `${n} ${CHANNEL_TYPES[type] ?? `type ${type}`}`)
                  .join(', ') || '—'}
              </dd>
              <dt>Features</dt>
              <dd>{p.features.length ? p.features.join(', ') : '—'}</dd>
              <dt>Permissions</dt>
              <dd>
                {detail.data.missingPermissions && detail.data.missingPermissions !== '0' ? (
                  <span className="badge bad">Missing required permissions</span>
                ) : detail.data.missingPermissions === '0' ? (
                  <span className="badge good">OK</span>
                ) : (
                  <span className="muted">No required permissions set</span>
                )}
              </dd>
            </dl>
          </Panel>
        </div>
        <Panel title="Install history">
          <DataTable
            caption="Install history"
            rowKey={(e) => `${e.ts}-${e.kind}`}
            rows={detail.data.events ?? []}
            columns={[
              { key: 'ts', header: 'When', render: (e) => dateTime(e.ts, tz) },
              { key: 'kind', header: 'Event', render: (e) => e.kind },
              {
                key: 'detected',
                header: 'Detected',
                render: (e) => (e.detectedAtStartup ? 'At startup (bot was offline)' : 'Live'),
              },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
