import { useMemo } from 'react';
import { useMeta, useSpec } from '../api';
import { pivot } from '../chart-data';
import { BarList, TimeChart } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { ErrorNote, Loading, PageHead, Panel, RangePicker, Tile } from '../components/ui';
import { ago, dateTime, ms, num, pct } from '../format';
import { useRange } from '../range';

interface Reliability {
  from: string;
  totals: {
    runs: number | null;
    missedDeadlines: number | null;
    noResponse: number | null;
    errors: number | null;
    over3sRate: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
  } | null;
  errorsByCode: { key: string; value: number }[];
  routes: {
    method: string;
    route: string;
    calls: number;
    failures: number | null;
    retries: number;
    p95Ms: number | null;
  }[];
  rateLimits: { scope: string; route: string; count: number; maxRetryAfter: number | null }[];
  invalidBudget: { used: number; limit: number; share: number; shared429: number };
  identify: {
    remaining: number | null;
    total: number | null;
    nodeVersion: string | null;
    libVersion: string | null;
    sdkVersion: string | null;
    release: string | null;
  } | null;
  shards: { shard: number; ping: number; ts: string; stale: boolean }[];
  shardEvents: { ts: string; shard: number; state: string; closeCode: number | null; replayed: number | null }[];
  process: Record<string, number>;
  sdkInstances: {
    instance: string;
    ts: string;
    queueDepth: number;
    failedFlushes: number;
    dropped: Record<string, number>;
    sdkVersion: string | null;
  }[];
}

const ERROR_NAMES: Record<string, string> = {
  '10062': '10062 Unknown interaction (missed deadline)',
  '40060': '40060 Already acknowledged',
  '50013': '50013 Missing permissions',
  '50001': '50001 Missing access',
};

/** Status with an icon and a word, never colour alone. */
function Status(props: { level: 'good' | 'warning' | 'critical'; children: React.ReactNode }) {
  const icon = props.level === 'good' ? '✓' : props.level === 'warning' ? '!' : '✕';
  return (
    <span className={`badge ${props.level === 'good' ? 'good' : props.level === 'critical' ? 'bad' : ''}`}>
      <span aria-hidden="true">{icon}</span> {props.children}
    </span>
  );
}

export function ReliabilityPage() {
  const r = useRange();
  const meta = useMeta();
  const tz = meta.data?.timezone ?? 'UTC';
  const q = useSpec<Reliability>({ kind: 'reliability', range: r.range });
  const p95 = useSpec<{ points: { t: string; key: string | null; value: number | null }[] }>({
    kind: 'series',
    metric: 'interactions',
    range: r.range,
    interval: r.interval,
    stat: 'p95',
    timezone: tz,
  });
  const p99 = useSpec<{ points: { t: string; key: string | null; value: number | null }[] }>({
    kind: 'series',
    metric: 'interactions',
    range: r.range,
    interval: r.interval,
    stat: 'p99',
    timezone: tz,
  });
  const latency = useMemo(() => {
    const a = pivot(p95.data?.points ?? [], () => 'p95');
    const b = pivot(p99.data?.points ?? [], () => 'p99');
    const index = new Map(b.x.map((x, i) => [x, i]));
    return {
      x: a.x,
      series: [
        { name: 'p95', values: a.series[0]?.values ?? [] },
        { name: 'p99', values: a.x.map((x) => (index.has(x) ? (b.series[0]?.values[index.get(x)!] ?? null) : null)) },
      ],
    };
  }, [p95.data, p99.data]);
  const d = q.data;
  const t = d?.totals;
  const budget = d?.invalidBudget;
  const budgetLevel = !budget ? 'good' : budget.share >= 0.5 ? 'critical' : budget.share >= 0.2 ? 'warning' : 'good';
  const identifyShare =
    d?.identify?.remaining != null && d.identify.total ? d.identify.remaining / d.identify.total : null;

  return (
    <>
      <PageHead
        title="Reliability"
        description="Response times against Discord's 3-second deadline, REST health, rate limits and shards."
        actions={<RangePicker value={r.id} onChange={r.setId} />}
      />
      {q.error ? <ErrorNote error={q.error} /> : null}
      <div className="stack">
        <div className="grid tiles">
          <Tile label="p50 response" value={ms(t?.p50Ms)} />
          <Tile label="p95 response" value={ms(t?.p95Ms)} sub="Deadline: 3 s" />
          <Tile label="p99 response" value={ms(t?.p99Ms)} />
          <Tile label="Over 3 s" value={pct(t?.over3sRate)} />
          <Tile label="Missed deadlines" value={num(t?.missedDeadlines)} sub="Users saw “interaction failed”" />
          <Tile
            label="Invalid requests (10 min)"
            value={`${num(budget?.used)} / 10,000`}
            sub={
              <Status level={budgetLevel}>
                {budgetLevel === 'good' ? 'Healthy' : budgetLevel === 'warning' ? 'Watch' : 'Ban risk'}
              </Status>
            }
          />
          <Tile
            label="Identify budget"
            value={d?.identify?.remaining != null ? `${num(d.identify.remaining)} left` : '—'}
            sub={
              identifyShare === null ? (
                'Sent by the shard 0 process'
              ) : (
                <Status
                  level={identifyShare < 0.2 ? 'critical' : 'good'}
                >{`${pct(identifyShare, 0)} of ${num(d?.identify?.total)}`}</Status>
              )
            }
          />
        </div>
        <Panel title="Response time" subtitle={`Time to first response · ${tz}`}>
          {p95.isLoading ? (
            <Loading />
          ) : (
            <TimeChart
              label="p95 and p99 time to first response"
              x={latency.x}
              series={latency.series}
              format={(v) => ms(v)}
              withTime={r.interval === 'hour'}
              timezone={tz}
            />
          )}
        </Panel>
        <div className="grid two">
          <Panel title="Errors by code" subtitle={d ? `Since ${dateTime(d.from, tz)} (raw retention)` : undefined}>
            <BarList
              label="Errors by code"
              rows={(d?.errorsByCode ?? []).map((e) => ({
                key: e.key,
                name: ERROR_NAMES[e.key] ?? e.key,
                value: e.value,
              }))}
            />
          </Panel>
          <Panel title="Rate limits (429)" subtitle="By scope and route">
            {d && d.rateLimits.length > 0 ? (
              <DataTable
                caption="Rate limits"
                rowKey={(x) => `${x.scope} ${x.route}`}
                rows={d.rateLimits}
                columns={[
                  { key: 'scope', header: 'Scope', render: (x) => x.scope },
                  { key: 'route', header: 'Route', render: (x) => <code>{x.route}</code> },
                  { key: 'count', header: 'Count', numeric: true, sort: (x) => x.count, render: (x) => num(x.count) },
                  { key: 'retry', header: 'Longest wait', numeric: true, render: (x) => ms(x.maxRetryAfter) },
                ]}
              />
            ) : (
              <p className="muted">No 429s in this range.</p>
            )}
          </Panel>
        </div>
        <Panel title="REST calls by route" subtitle="Bucketed routes only; raw paths are never stored">
          <DataTable
            caption="REST calls by route"
            rowKey={(x) => `${x.method} ${x.route}`}
            rows={d?.routes ?? []}
            initialSort={{ key: 'calls', dir: 'desc' }}
            columns={[
              { key: 'method', header: 'Method', render: (x) => x.method },
              { key: 'route', header: 'Route', render: (x) => <code>{x.route}</code> },
              { key: 'calls', header: 'Calls', numeric: true, sort: (x) => x.calls, render: (x) => num(x.calls) },
              {
                key: 'failed',
                header: 'Failed',
                numeric: true,
                sort: (x) => (x.failures ?? 0) / (x.calls || 1),
                render: (x) => pct((x.failures ?? 0) / (x.calls || 1)),
              },
              { key: 'retries', header: 'Retries', numeric: true, render: (x) => num(x.retries) },
              { key: 'p95', header: 'p95', numeric: true, sort: (x) => x.p95Ms, render: (x) => ms(x.p95Ms) },
            ]}
          />
        </Panel>
        <div className="grid two">
          <Panel title="Shards" subtitle="Gateway ping, sampled every 30 seconds">
            {d && d.shards.length > 0 ? (
              <DataTable
                caption="Shards"
                rowKey={(s) => String(s.shard)}
                rows={d.shards}
                columns={[
                  { key: 'shard', header: 'Shard', numeric: true, render: (s) => s.shard },
                  { key: 'ping', header: 'Ping', numeric: true, render: (s) => ms(s.ping) },
                  { key: 'seen', header: 'Last report', render: (s) => ago(s.ts) },
                  {
                    key: 'state',
                    header: 'State',
                    render: (s) => (
                      <Status level={s.stale ? 'warning' : 'good'}>{s.stale ? 'Stale' : 'Reporting'}</Status>
                    ),
                  },
                ]}
              />
            ) : (
              <p className="muted">No shard reports in the last day.</p>
            )}
          </Panel>
          <Panel title="Gateway events" subtitle="Reconnects, resumes and close codes">
            {d && d.shardEvents.length > 0 ? (
              <DataTable
                caption="Gateway events"
                rowKey={(e) => `${e.ts}-${e.shard}-${e.state}`}
                rows={d.shardEvents}
                columns={[
                  { key: 'ts', header: 'When', render: (e) => dateTime(e.ts, tz) },
                  { key: 'shard', header: 'Shard', numeric: true, render: (e) => e.shard },
                  { key: 'state', header: 'State', render: (e) => e.state },
                  { key: 'code', header: 'Close code', numeric: true, render: (e) => e.closeCode ?? '—' },
                ]}
              />
            ) : (
              <p className="muted">No gateway events in this range.</p>
            )}
          </Panel>
          <Panel title="Bot process">
            <dl className="dl">
              <dt>Event-loop delay p99</dt>
              <dd>{ms(d?.process['eventloop.p99_ms'])}</dd>
              <dt>Memory (RSS)</dt>
              <dd>{d?.process['memory.rss_bytes'] ? `${num(d.process['memory.rss_bytes'] / 1_048_576)} MB` : '—'}</dd>
              <dt>Heap used</dt>
              <dd>
                {d?.process['memory.heap_used_bytes']
                  ? `${num(d.process['memory.heap_used_bytes'] / 1_048_576)} MB`
                  : '—'}
              </dd>
              <dt>Cached users · channels</dt>
              <dd>
                {num(d?.process['cache.users'])} · {num(d?.process['cache.channels'])}
              </dd>
              <dt>Node · discord.js</dt>
              <dd>
                {d?.identify?.nodeVersion ?? '—'} · {d?.identify?.libVersion ?? '—'}
              </dd>
              <dt>SDK · bot release</dt>
              <dd>
                {d?.identify?.sdkVersion ?? '—'} · {d?.identify?.release ?? '—'}
              </dd>
            </dl>
          </Panel>
          <Panel title="SDK health">
            {d && d.sdkInstances.length > 0 ? (
              <DataTable
                caption="SDK health"
                rowKey={(s) => s.instance}
                rows={d.sdkInstances}
                columns={[
                  { key: 'instance', header: 'Instance', render: (s) => s.instance },
                  { key: 'seen', header: 'Last seen', render: (s) => ago(s.ts) },
                  { key: 'queue', header: 'Queued', numeric: true, render: (s) => num(s.queueDepth) },
                  {
                    key: 'dropped',
                    header: 'Dropped',
                    numeric: true,
                    render: (s) => num(Object.values(s.dropped).reduce((a, b) => a + b, 0)),
                  },
                  { key: 'failed', header: 'Failed sends', numeric: true, render: (s) => num(s.failedFlushes) },
                ]}
              />
            ) : (
              <p className="muted">No SDK has reported yet.</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
