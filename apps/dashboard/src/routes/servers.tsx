import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, updating, useMeta, useSpec } from '../api';
import { pivot } from '../chart-data';
import { BarList, TimeChart } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { GuildIcon, Name, NotFoundPage, PageHead, Pager, Panel, QueryBody, RangePicker, Tile } from '../components/ui';
import { ago, date, dateTime, day, label, num } from '../format';
import { isSnowflake } from '../forms';
import { useRange } from '../range';
import { pageCount, parseServerListSearch, type ServerListSearch, SIZES, searchText } from '../server-list';

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
  const search = useSearch({ from: '/servers' });
  const status = search.status ?? 'active';
  const sort = { key: search.sort ?? 'members', dir: search.dir ?? 'desc' } as const;
  const page = (search.page ?? 1) - 1;
  /** Changes the list's state in the address; any change other than paging goes back to the first page. */
  const update = (patch: Partial<Record<keyof ServerListSearch, unknown>>) =>
    void navigate({
      to: '/servers',
      search: (prev) => parseServerListSearch({ ...prev, page: undefined, ...patch }),
      replace: true,
    });
  const spec = {
    kind: 'servers',
    status,
    sort: sort.key,
    order: sort.dir,
    limit: PAGE,
    offset: page * PAGE,
    ...(search.q?.trim() ? { search: search.q.trim() } : {}),
    ...(search.size ? { size: search.size } : {}),
    ...(search.inactive ? { inactive: true } : {}),
    ...(search.missing ? { missingPermissions: true } : {}),
  };
  const q = useSpec<{ total: number; rows: ServerRow[] }>(spec);
  const total = q.data?.total ?? 0;
  const pages = pageCount(total, PAGE);
  // A page past the end (an old link, or servers removed since): the last page instead of an empty one.
  useEffect(() => {
    if (q.data && !q.isPlaceholderData && page + 1 > pages && page > 0) update({ page: pages });
  });

  // What is typed is kept here and goes to the address once typing pauses. Following the address keystroke by
  // keystroke would drop a leading space and move the caret to the end; it is followed only when it changes from
  // elsewhere (Back, a link).
  const [text, setText] = useState(search.q ?? '');
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(typing.current), []);
  useEffect(() => {
    setText((typed) => (searchText(typed) === search.q ? typed : (search.q ?? '')));
  }, [search.q]);

  return (
    <>
      <PageHead title="Servers" description={q.data ? `${num(total)} servers match` : undefined} />
      <search className="filters">
        <label>
          <span className="visually-hidden">Search server names</span>
          <input
            type="search"
            placeholder="Search names"
            maxLength={100}
            value={text}
            onChange={(e) => {
              const typed = e.target.value;
              setText(typed);
              clearTimeout(typing.current);
              typing.current = setTimeout(() => update({ q: typed }), 250);
            }}
          />
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => update({ status: e.target.value })}>
            <option value="active">Installed</option>
            <option value="left">Removed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Size
          <select value={search.size ?? ''} onChange={(e) => update({ size: e.target.value })}>
            <option value="">Any</option>
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s} members
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={search.inactive === true}
            onChange={(e) => update({ inactive: e.target.checked })}
          />
          No commands in 30 days
        </label>
        <label>
          <input
            type="checkbox"
            checked={search.missing === true}
            onChange={(e) => update({ missing: e.target.checked })}
          />
          Missing permissions
        </label>
      </search>
      <Panel title="Server list" subtitle="Runs are the last 30 days" busy={updating(q)}>
        <QueryBody query={q}>
          <DataTable
            caption="Servers"
            rows={q.data?.rows ?? []}
            rowKey={(row) => row.id}
            sort={sort}
            onSort={(key, dir) => update({ sort: key, dir })}
            onRowClick={(row) => void navigate({ to: '/servers/$id', params: { id: row.id } })}
            empty="No servers match."
            columns={[
              {
                key: 'name',
                header: 'Server',
                sort: (row) => row.name,
                render: (row) => (
                  <Link to="/servers/$id" params={{ id: row.id }}>
                    <GuildIcon id={row.id} icon={row.icon} name={row.name || row.id} />
                  </Link>
                ),
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
                firstDir: 'desc',
                sort: (row) => row.lastActive,
                render: (row) => ago(row.lastActive),
              },
              {
                key: 'joined',
                header: 'Added',
                firstDir: 'desc',
                sort: (row) => row.joinedAt,
                render: (row) =>
                  row.baseline ? <span className="muted">before Shardlens</span> : date(row.joinedAt, tz),
              },
              { key: 'locale', header: 'Locale', render: (row) => row.locale ?? '—' },
              { key: 'boosts', header: 'Boosts', numeric: true, render: (row) => num(row.boosts) },
              { key: 'shard', header: 'Shard', numeric: true, render: (row) => num(row.shard) },
            ]}
          />
          <Pager
            label="Pages of the server list"
            status={`Page ${num(Math.min(page + 1, pages))} of ${num(pages)}`}
            buttons={[
              { label: 'Previous', onClick: page > 0 ? () => update({ page }) : undefined },
              { label: 'Next', onClick: page + 1 < pages ? () => update({ page: page + 2 }) : undefined },
            ]}
          />
        </QueryBody>
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

function ServerNotFound() {
  return (
    <NotFoundPage title="Server not found" back={<Link to="/servers">← All servers</Link>}>
      There is no server with this ID in your bot's data.
    </NotFoundPage>
  );
}

const INSTALL_EVENTS: Record<string, string> = {
  join: 'Added',
  leave: 'Removed',
  unavailable: 'Unavailable (Discord outage)',
  available: 'Available again',
};

export function ServerPage() {
  const { id } = useParams({ from: '/servers/$id' });
  return isSnowflake(id) ? <ServerDetailPage id={id} /> : <ServerNotFound />;
}

function ServerDetailPage(props: { id: string }) {
  const id = props.id;
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

  if (detail.error instanceof ApiError && detail.error.status === 400) return <ServerNotFound />;
  if (detail.isLoading || detail.error) {
    return (
      <>
        <PageHead title="Server" description={<Link to="/servers">← All servers</Link>} />
        <QueryBody query={detail}>{null}</QueryBody>
      </>
    );
  }
  if (!detail.data?.found || !p) return <ServerNotFound />;
  return (
    <>
      <PageHead
        title={p.name || p.id}
        description={<Link to="/servers">← All servers</Link>}
        actions={<RangePicker value={r.id} onChange={r.setId} />}
      />
      <div className="stack" aria-busy={updating(series, commands, outcomes) || undefined}>
        <div className="grid tiles">
          <Tile
            label="Members"
            value={num(p.memberCount)}
            sub={p.sizeAtJoin != null ? `${num(p.sizeAtJoin)} when added` : undefined}
          />
          <Tile
            label="Unique users"
            value={num(detail.data.uniqueUsersThisPeriod)}
            sub={`Since ${day(detail.data.periodStart)}`}
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
          <QueryBody query={series}>
            <TimeChart
              label="Runs in this server over time"
              x={chart.x}
              series={chart.series}
              withTime={r.interval === 'hour'}
              timezone={tz}
            />
          </QueryBody>
        </Panel>
        <div className="grid three">
          <Panel title="Top commands">
            <QueryBody query={commands}>
              <BarList
                label="Top commands"
                rows={(commands.data?.rows ?? []).map((c) => ({
                  key: c.key,
                  name: (
                    <Link to="/commands/$name" params={{ name: c.key }}>
                      <Name>{c.key}</Name>
                    </Link>
                  ),
                  value: c.count,
                }))}
              />
            </QueryBody>
          </Panel>
          <Panel title="Outcomes">
            <QueryBody query={outcomes}>
              <BarList
                label="Outcomes"
                rows={(outcomes.data?.rows ?? []).map((c) => ({
                  key: c.key,
                  name: label('outcome', c.key),
                  value: c.count,
                }))}
              />
            </QueryBody>
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
              <dd>{p.features.length ? <Name>{p.features.join(', ')}</Name> : '—'}</dd>
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
              { key: 'kind', header: 'Event', render: (e) => INSTALL_EVENTS[e.kind] ?? e.kind },
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
