import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type ReactNode, useMemo } from 'react';
import { updating, useMeta, useSpec } from '../api';
import { pivot } from '../chart-data';
import { commandFound, KNOWN_COMMAND_DAYS, MAX_COMMAND_NAME } from '../commands';
import { BarList, Heatmap, TimeChart } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { FailedRunsLink } from '../components/FailedRunsLink';
import { Delta, GuildIcon, Name, NotFoundPage, PageHead, Panel, QueryBody, RangePicker, Tile } from '../components/ui';
import { agoHour, commandLabel, date, day, label, ms, num, pct } from '../format';
import { lastDays, useRange } from '../range';

interface CommandRow {
  command: string;
  runs: number;
  previousRuns: number;
  changePct: number | null;
  errorRate: number | null;
  p95Ms: number | null;
  servers: number;
  lastUsed: string | null;
  uniqueUsersThisPeriod: number | null;
  registered: boolean;
  /** Interaction kinds the command ran as, or is registered as: `chat_input`, `message_command`, `user_context`... */
  kinds: string[];
}

/** Badges for every way a command runs other than as a slash command. */
const OTHER_KINDS: Record<string, string> = {
  message_command: 'prefix',
  user_context: 'user menu',
  message_context: 'message menu',
  primary_entry_point: 'entry point',
};

export function CommandsPage() {
  const r = useRange();
  const navigate = useNavigate();
  const q = useSpec<{ periodStart: string; rows: CommandRow[] }>({ kind: 'commands', range: r.range });
  return (
    <>
      <PageHead
        title="Commands"
        description="Every command your bot ran, with change against the previous period of the same length."
        actions={<RangePicker value={r.id} onChange={r.setId} />}
      />
      <Panel
        busy={updating(q)}
        title="All commands"
        subtitle={q.data ? `Unique users count since ${day(q.data.periodStart)} (current salt period)` : undefined}
      >
        <QueryBody query={q}>
          <DataTable
            caption="Commands ranked by runs"
            rows={q.data?.rows ?? []}
            rowKey={(row) => row.command}
            initialSort={{ key: 'runs', dir: 'desc' }}
            onRowClick={(row) => void navigate({ to: '/commands/$name', params: { name: row.command } })}
            columns={[
              {
                key: 'command',
                header: 'Command',
                sort: (row) => row.command,
                render: (row) => (
                  <>
                    <Link to="/commands/$name" params={{ name: row.command }}>
                      <Name>{commandLabel(row.command, row.kinds)}</Name>
                    </Link>{' '}
                    {row.kinds
                      .filter((kind) => OTHER_KINDS[kind])
                      .map((kind) => (
                        <span key={kind} className="badge">
                          {OTHER_KINDS[kind]}
                        </span>
                      ))}{' '}
                    {row.registered && row.runs === 0 ? <span className="badge">unused</span> : null}
                  </>
                ),
              },
              { key: 'runs', header: 'Runs', numeric: true, sort: (row) => row.runs, render: (row) => num(row.runs) },
              {
                key: 'change',
                header: 'Change',
                numeric: true,
                sort: (row) => row.changePct,
                render: (row) =>
                  row.runs === 0 ? (
                    '—'
                  ) : row.previousRuns < 10 ? (
                    <span className="muted">new</span>
                  ) : (
                    <Delta pct={row.changePct} />
                  ),
              },
              {
                key: 'users',
                header: 'Unique users',
                numeric: true,
                sort: (row) => row.uniqueUsersThisPeriod,
                render: (row) => num(row.uniqueUsersThisPeriod),
              },
              {
                key: 'servers',
                header: 'Servers',
                numeric: true,
                sort: (row) => row.servers,
                render: (row) => num(row.servers),
              },
              {
                key: 'errors',
                header: 'Failed',
                numeric: true,
                sort: (row) => row.errorRate,
                render: (row) => pct(row.errorRate),
              },
              {
                key: 'p95',
                header: 'p95 response',
                numeric: true,
                sort: (row) => row.p95Ms,
                render: (row) => ms(row.p95Ms),
              },
              {
                key: 'last',
                header: 'Last used',
                firstDir: 'desc',
                sort: (row) => row.lastUsed,
                render: (row) => agoHour(row.lastUsed),
              },
            ]}
          />
        </QueryBody>
      </Panel>
    </>
  );
}

interface CommandDetail {
  from: string;
  totals: {
    runs: number | null;
    ok: number | null;
    error: number | null;
    timeout: number | null;
    noResponse: number | null;
    deferRate: number | null;
    ephemeralRate: number | null;
    premiumShare: number | null;
    over3sRate: number | null;
    handlerP95Ms: number | null;
  };
  latencyHistogram: number[] | null;
  kinds: { key: string; value: number }[];
  subcommands: { key: string; value: number }[];
  options: { key: string; value: number }[];
  optionValues: { option: string; value: string; runs: number }[];
  memberTiers: { key: string | null; value: number }[];
  installs: { key: string | null; value: number }[];
  contexts: { key: string | null; value: number }[];
  channelTypes: { key: string; value: number }[];
  locales: { key: string; value: number }[];
  topServers: { key: string; value: number; name: string | null; icon: string | null }[];
  components: { key: string; kind: string; value: number }[];
  modals: { customId: string; shown: number; submitted: number }[];
}

/** Upper edge of bucket `i` of the SDK's latency histogram: 40 log-scale buckets up to 60 s (`@shardlens/core`). */
const bucketUpper = (i: number) => Math.exp(((i + 1) / 39) * Math.log(60_000));

function CommandNotFound(props: { name: string }) {
  return (
    <NotFoundPage title="Command not found" back={<Link to="/commands">← All commands</Link>}>
      No command called <Name>{props.name}</Name> is registered, and none has run in the last {KNOWN_COMMAND_DAYS} days.
    </NotFoundPage>
  );
}

export function CommandPage() {
  const { name } = useParams({ from: '/commands/$name' });
  // The collector refuses a longer name, and no command can have one.
  return name.length > MAX_COMMAND_NAME ? <CommandNotFound name={name} /> : <CommandDetailPage name={name} />;
}

function CommandDetailPage(props: { name: string }) {
  const name = props.name;
  const r = useRange();
  const meta = useMeta();
  const tz = meta.data?.timezone ?? 'UTC';
  const filters = [{ field: 'command', value: name }];
  const detail = useSpec<CommandDetail>({ kind: 'command', name, range: r.range });
  const series = useSpec<{ points: { t: string; key: string | null; value: number | null }[] }>({
    kind: 'series',
    metric: 'interactions',
    range: r.range,
    interval: r.interval,
    groupBy: 'sub',
    filters,
    timezone: tz,
    limit: 3,
  });
  const heat = useSpec<{ cells: { weekday: number; hour: number; value: number }[] }>({
    kind: 'heatmap',
    range: r.range,
    filters,
    timezone: tz,
  });
  const d = detail.data;
  // No runs in this range: is it a command at all? Asked only then, over the widest range the page offers.
  const noRuns = d !== undefined && !detail.isPlaceholderData && (d.totals.runs ?? 0) === 0;
  const wide = useMemo(() => lastDays(KNOWN_COMMAND_DAYS), []);
  const known = useSpec<{ rows: { command: string; kinds: string[] }[] }>(
    noRuns ? { kind: 'commands', range: wide } : null,
  );
  const listed = known.data?.rows.find((row) => row.command === name);
  const title = commandLabel(name, d?.kinds.length ? d.kinds.map((k) => k.key) : (listed?.kinds ?? []));
  const chart = useMemo(
    () => pivot(series.data?.points ?? [], (k) => (k ? `${title} ${k}` : title)),
    [series.data, title],
  );
  const t = d?.totals;
  const runs = t?.runs ?? 0;
  const latency = (d?.latencyHistogram ?? [])
    .map((v, i) => ({ key: String(i), name: `≤ ${ms(bucketUpper(i))}`, value: v }))
    .filter((b) => b.value > 0);

  if (noRuns && commandFound(name, known.data?.rows) === false) return <CommandNotFound name={name} />;
  // The detail reads raw events, which are kept for 35 days at most: a longer range starts later.
  const cut = d !== undefined && Date.parse(d.from) > Date.parse(r.range.from);
  return (
    <>
      <PageHead
        title={title}
        description={<Link to="/commands">← All commands</Link>}
        actions={<RangePicker value={r.id} onChange={r.setId} />}
      />
      <QueryBody query={noRuns ? [detail, { isLoading: known.isLoading, error: null }] : detail}>
        <div className="stack" aria-busy={updating(detail, series, heat) || undefined}>
          {d && runs === 0 ? (
            <p className="notice">
              No runs of <Name>{title}</Name> {cut ? `since ${date(d.from, tz)}` : 'in this range'}.
            </p>
          ) : null}
          <div className="grid tiles">
            <Tile label="Runs" value={num(runs)} sub={cut ? `Counted since ${date(d?.from, tz)}` : undefined} />
            <Tile
              label="Failed"
              value={pct(runs ? ((t?.error ?? 0) + (t?.timeout ?? 0) + (t?.noResponse ?? 0)) / runs : null)}
            />
            <Tile label="Over 3 s" value={pct(t?.over3sRate)} />
            <Tile label="Deferred" value={pct(t?.deferRate)} />
            <Tile label="Ephemeral" value={pct(t?.ephemeralRate)} />
            <Tile label="Premium users" value={pct(t?.premiumShare)} />
            <Tile label="Handler p95" value={ms(t?.handlerP95Ms)} sub="Wrapped handlers only" />
          </div>
          <Panel title="Runs over time" subtitle={`Top subcommands · ${tz}`}>
            <QueryBody query={series}>
              <TimeChart
                label={`Runs of ${title} over time by subcommand`}
                x={chart.x}
                series={chart.series}
                withTime={r.interval === 'hour'}
                timezone={tz}
              />
            </QueryBody>
          </Panel>
          <div className="grid three">
            <Panel title="Outcomes" actions={<FailedRunsLink command={name} />}>
              <BarList
                label="Outcomes"
                rows={[
                  { key: 'ok', name: label('outcome', 'ok'), value: t?.ok ?? 0 },
                  { key: 'error', name: label('outcome', 'error'), value: t?.error ?? 0 },
                  { key: 'timeout', name: label('outcome', 'timeout'), value: t?.timeout ?? 0 },
                  { key: 'no_response', name: label('outcome', 'no_response'), value: t?.noResponse ?? 0 },
                ].filter((x) => x.value > 0)}
              />
            </Panel>
            <Panel title="Response time" subtitle="Time to first response, log-scale buckets">
              <BarList label="Response time distribution" rows={latency} limit={40} />
            </Panel>
            <Panel title="Subcommands">
              <BarList
                label="Subcommands"
                rows={(d?.subcommands ?? []).map((s) => ({ key: s.key, name: nameOf(s.key), value: s.value }))}
              />
            </Panel>
            <Panel title="Options used" subtitle="Names only, unless allow-listed">
              <BarList
                label="Options used"
                rows={(d?.options ?? []).map((o) => ({ key: o.key, name: nameOf(o.key), value: o.value }))}
              />
            </Panel>
            <Panel title="Who runs it">
              <BarList
                label="Member tiers"
                rows={(d?.memberTiers ?? []).map((x) => ({
                  key: String(x.key),
                  name: label('tier', x.key),
                  value: x.value,
                }))}
              />
            </Panel>
            <Panel title="Install type and context">
              <BarList
                label="Install type and context"
                rows={[
                  ...(d?.installs ?? []).map((x) => ({
                    key: `i${x.key}`,
                    name: label('install', x.key),
                    value: x.value,
                  })),
                  ...(d?.contexts ?? []).map((x) => ({
                    key: `c${x.key}`,
                    name: label('context', x.key),
                    value: x.value,
                  })),
                ]}
              />
            </Panel>
            <Panel title="Channel types" subtitle="The kind of channel it was run in, never which channel">
              <BarList
                label="Channel types"
                rows={(d?.channelTypes ?? []).map((x) => ({
                  key: x.key,
                  name: label('channel', x.key),
                  value: x.value,
                }))}
              />
            </Panel>
            <Panel title="Languages" subtitle="Discord app language, not location">
              <BarList
                label="Languages"
                rows={(d?.locales ?? []).map((x) => ({ key: x.key, name: x.key, value: x.value }))}
              />
            </Panel>
            <Panel title="Top servers">
              <BarList
                label="Top servers"
                rows={(d?.topServers ?? []).map((s) => ({
                  key: s.key,
                  name: (
                    <Link to="/servers/$id" params={{ id: s.key }}>
                      <GuildIcon id={s.key} icon={s.icon} name={s.name ?? s.key} />
                    </Link>
                  ),
                  value: s.value,
                }))}
              />
            </Panel>
            <Panel title="Components from this command" subtitle="Buttons and selects on its messages">
              <BarList
                label="Components"
                rows={(d?.components ?? []).map((c) => ({
                  key: `${c.kind}:${c.key}`,
                  name: (
                    <>
                      {label('kind', c.kind)} <Name>{c.key}</Name>
                    </>
                  ),
                  value: c.value,
                }))}
              />
            </Panel>
          </div>
          {d && d.optionValues.length > 0 ? (
            <Panel title="Option values" subtitle="Allow-listed options only">
              <DataTable
                caption="Option values"
                rowKey={(v) => `${v.option}=${v.value}`}
                rows={d.optionValues}
                columns={[
                  { key: 'option', header: 'Option', render: (v) => <Name>{v.option}</Name> },
                  { key: 'value', header: 'Value', render: (v) => <Name>{v.value}</Name> },
                  { key: 'runs', header: 'Runs', numeric: true, sort: (v) => v.runs, render: (v) => num(v.runs) },
                ]}
              />
            </Panel>
          ) : null}
          {d && d.modals.length > 0 ? (
            <Panel title="Modal completion" subtitle="Submitted ÷ shown">
              <DataTable
                caption="Modal completion"
                rowKey={(m) => m.customId}
                rows={d.modals}
                columns={[
                  { key: 'id', header: 'Modal', render: (m) => <Name>{m.customId}</Name> },
                  { key: 'shown', header: 'Shown', numeric: true, render: (m) => num(m.shown) },
                  { key: 'submitted', header: 'Submitted', numeric: true, render: (m) => num(m.submitted) },
                  {
                    key: 'rate',
                    header: 'Completion',
                    numeric: true,
                    render: (m) => pct(m.shown ? m.submitted / m.shown : null),
                  },
                ]}
              />
            </Panel>
          ) : null}
          <Panel title="Peak hours" subtitle={`Runs by hour and weekday · ${tz}`}>
            <QueryBody query={heat}>
              <Heatmap label={`Runs of ${title} by hour of day and weekday`} cells={heat.data?.cells ?? []} />
            </QueryBody>
          </Panel>
        </div>
      </QueryBody>
    </>
  );
}

/** A subcommand or option name as the bot defined it. */
const nameOf = (key: string): ReactNode => (key ? <Name>{key}</Name> : '(none)');
