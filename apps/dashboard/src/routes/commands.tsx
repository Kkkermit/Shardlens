import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useMeta, useSpec } from '../api';
import { pivot } from '../chart-data';
import { BarList, Heatmap, TimeChart } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { Delta, ErrorNote, GuildIcon, Loading, PageHead, Panel, RangePicker, Tile } from '../components/ui';
import { agoHour, commandLabel, label, ms, num, pct } from '../format';
import { useRange } from '../range';

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
        title="All commands"
        subtitle={q.data ? `Unique users count since ${q.data.periodStart} (current salt period)` : undefined}
      >
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorNote error={q.error} />
        ) : (
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
                      {commandLabel(row.command, row.kinds)}
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
              { key: 'last', header: 'Last used', sort: (row) => row.lastUsed, render: (row) => agoHour(row.lastUsed) },
            ]}
          />
        )}
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

export function CommandPage() {
  const { name } = useParams({ from: '/commands/$name' });
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
  const title = commandLabel(name, d?.kinds.map((k) => k.key) ?? []);
  const chart = useMemo(
    () => pivot(series.data?.points ?? [], (k) => (k ? `${title} ${k}` : title)),
    [series.data, title],
  );
  const t = d?.totals;
  const runs = t?.runs ?? 0;
  const latency = (d?.latencyHistogram ?? [])
    .map((v, i) => ({ key: String(i), name: `≤ ${ms(bucketUpper(i))}`, value: v }))
    .filter((b) => b.value > 0);

  return (
    <>
      <PageHead
        title={title}
        description={<Link to="/commands">← All commands</Link>}
        actions={<RangePicker value={r.id} onChange={r.setId} />}
      />
      {detail.error ? <ErrorNote error={detail.error} /> : null}
      <div className="stack">
        <div className="grid tiles">
          <Tile
            label="Runs"
            value={num(runs)}
            sub={d && Date.parse(d.from) > Date.parse(r.range.from) ? 'Detail covers the last 35 days' : undefined}
          />
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
          {series.isLoading ? (
            <Loading />
          ) : (
            <TimeChart
              label={`Runs of /${name} over time by subcommand`}
              x={chart.x}
              series={chart.series}
              withTime={r.interval === 'hour'}
              timezone={tz}
            />
          )}
        </Panel>
        <div className="grid three">
          <Panel title="Outcomes">
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
              rows={(d?.subcommands ?? []).map((s) => ({ key: s.key, name: s.key || '(none)', value: s.value }))}
            />
          </Panel>
          <Panel title="Options used" subtitle="Names only, unless allow-listed">
            <BarList
              label="Options used"
              rows={(d?.options ?? []).map((o) => ({ key: o.key, name: o.key, value: o.value }))}
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
                name: `${label('kind', c.kind)} ${c.key}`,
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
                { key: 'option', header: 'Option', render: (v) => v.option },
                { key: 'value', header: 'Value', render: (v) => v.value },
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
                { key: 'id', header: 'Modal', render: (m) => m.customId },
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
          <Heatmap label={`Runs of /${name} by hour of day and weekday`} cells={heat.data?.cells ?? []} />
        </Panel>
      </div>
    </>
  );
}
