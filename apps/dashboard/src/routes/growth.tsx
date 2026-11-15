import { useMemo } from 'react';
import { updating, useMeta, useSpec } from '../api';
import { dayX } from '../chart-data';
import { BarList, TimeChart } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { ErrorNote, Loading, PageHead, Panel, QueryBody, RangePicker, Tile } from '../components/ui';
import { num, pct } from '../format';
import { useRange } from '../range';

interface Growth {
  daily: {
    day: string;
    joins: number | null;
    leaves: number | null;
    joinsDetected: number | null;
    leavesDetected: number | null;
  }[];
  sizeAtInstall: { bucket: string; servers: number }[];
  activation: { joined?: number; activated?: number; rate: number | null };
  installs: { active: number; inactive: number } | undefined;
  cohorts: { cohort: string; week: number; servers: number }[];
  lifetimes: { bucket: string; servers: number }[];
  serverCount: { ours: number; discord: number | null; drift: number | null; warn: boolean };
}

const SIZE_ORDER = ['1-10', '11-100', '101-1k', '1k-10k', '10k+'];
const LIFE_ORDER = ['<1d', '1-7d', '7-30d', '30-90d', '90d+'];

export function GrowthPage() {
  const r = useRange();
  const meta = useMeta();
  const tz = meta.data?.timezone ?? 'UTC';
  const q = useSpec<Growth>({ kind: 'growth', range: r.range, timezone: tz });
  const inst = useSpec<{
    daily: { day: string; userInstalls: number; userRemovals: number; serverInstalls: number }[];
    webhookStatus: number | null;
  }>({ kind: 'installs', range: r.range, timezone: tz });
  const userChart = useMemo(
    () => ({
      x: (inst.data?.daily ?? []).map((d) => dayX(d.day)),
      series: [
        { name: 'User installs', values: (inst.data?.daily ?? []).map((d) => d.userInstalls) },
        { name: 'Removed', values: (inst.data?.daily ?? []).map((d) => d.userRemovals) },
      ],
    }),
    [inst.data],
  );
  const g = q.data;
  const chart = useMemo(
    () => ({
      x: (g?.daily ?? []).map((d) => dayX(d.day)),
      series: [
        { name: 'Added', values: (g?.daily ?? []).map((d) => d.joins ?? 0) },
        { name: 'Removed', values: (g?.daily ?? []).map((d) => d.leaves ?? 0) },
      ],
    }),
    [g],
  );
  const added = (g?.daily ?? []).reduce((a, d) => a + (d.joins ?? 0), 0);
  const removed = (g?.daily ?? []).reduce((a, d) => a + (d.leaves ?? 0), 0);
  const detected = (g?.daily ?? []).reduce((a, d) => a + (d.joinsDetected ?? 0) + (d.leavesDetected ?? 0), 0);
  const cohorts = useMemo(() => {
    const byCohort = new Map<string, Map<number, number>>();
    for (const c of g?.cohorts ?? []) {
      const m = byCohort.get(c.cohort) ?? new Map<number, number>();
      m.set(c.week, c.servers);
      byCohort.set(c.cohort, m);
    }
    return [...byCohort.entries()].map(([cohort, weeks]) => ({ cohort, weeks }));
  }, [g]);
  const maxWeek = Math.min(8, Math.max(0, ...(g?.cohorts ?? []).map((c) => c.week)));

  return (
    <>
      <PageHead
        title="Growth"
        description="Servers adding and removing your bot."
        actions={<RangePicker value={r.id} onChange={r.setId} />}
      />
      {q.error ? <ErrorNote error={q.error} retry={() => void q.refetch()} /> : null}
      {!q.error && g?.serverCount.warn ? (
        <div className="notice" role="note">
          Our server count ({num(g.serverCount.ours)}) differs from Discord's approximate count (
          {num(g.serverCount.discord)}) by {pct(Math.abs(g.serverCount.drift ?? 0))}. Some shards may not be reporting.
        </div>
      ) : null}
      {q.error ? null : (
        <div className="stack" aria-busy={updating(q, inst) || undefined}>
          <div className="grid tiles">
            <Tile label="Added" value={num(added)} />
            <Tile label="Removed" value={num(removed)} />
            <Tile label="Net" value={num(added - removed)} />
            <Tile
              label="Activated within 24 h"
              value={pct(g?.activation.rate)}
              sub={`${num(g?.activation.activated)} of ${num(g?.activation.joined)} new servers`}
            />
            <Tile
              label="Inactive installs"
              value={num(g?.installs?.inactive)}
              sub={`of ${num(g?.installs?.active)} installed, no commands in 30 days`}
            />
            <Tile label="Found at startup" value={num(detected)} sub="Changes while the bot was offline" />
          </div>
          <Panel title="Servers added and removed" subtitle={`Per day · ${tz}`}>
            {q.isLoading ? (
              <Loading />
            ) : (
              <TimeChart label="Servers added and removed per day" x={chart.x} series={chart.series} timezone={tz} />
            )}
          </Panel>
          <div className="grid three">
            <Panel title="Size when added" subtitle="Members at install">
              <BarList
                label="Server size when added"
                rows={SIZE_ORDER.map((b) => ({
                  key: b,
                  name: `${b} members`,
                  value: g?.sizeAtInstall.find((s) => s.bucket === b)?.servers ?? 0,
                }))}
              />
            </Panel>
            <Panel title="Lifetime of removed servers">
              <BarList
                label="Lifetime of removed servers"
                rows={LIFE_ORDER.map((b) => ({
                  key: b,
                  name: b,
                  value: g?.lifetimes.find((s) => s.bucket === b)?.servers ?? 0,
                }))}
              />
            </Panel>
            <Panel title="Server count">
              <dl className="dl">
                <dt>Shardlens</dt>
                <dd>{num(g?.serverCount.ours)}</dd>
                <dt>Discord (approx.)</dt>
                <dd>{num(g?.serverCount.discord)}</dd>
                <dt>Difference</dt>
                <dd>{g?.serverCount.drift == null ? '—' : pct(g.serverCount.drift)}</dd>
              </dl>
            </Panel>
          </div>
          <Panel
            title="User installs"
            subtitle="From Discord webhook events (user installs are not visible over the gateway)"
          >
            <QueryBody query={inst}>
              {inst.data && inst.data.daily.length > 0 ? (
                <TimeChart
                  label="User installs and removals per day"
                  x={userChart.x}
                  series={userChart.series}
                  timezone={tz}
                />
              ) : (
                <p className="muted">
                  No user installs recorded yet. To track them, set <code>DISCORD_PUBLIC_KEY</code> on the collector and
                  point Developer Portal → Webhooks at <code>{`${window.location.origin}/v1/discord/events`}</code>.
                </p>
              )}
            </QueryBody>
          </Panel>
          <Panel title="Weekly retention" subtitle="Servers still running commands N weeks after they added the bot">
            {cohorts.length === 0 ? (
              <p className="muted">Cohorts appear once new servers add the bot.</p>
            ) : (
              <DataTable
                caption="Weekly retention cohorts"
                rowKey={(c) => c.cohort}
                rows={cohorts}
                columns={[
                  { key: 'cohort', header: 'Week added', render: (c) => c.cohort },
                  ...Array.from({ length: maxWeek + 1 }, (_, w) => ({
                    key: `w${w}`,
                    header: `Week ${w}`,
                    numeric: true,
                    render: (c: { weeks: Map<number, number> }) => {
                      const base = c.weeks.get(0);
                      const v = c.weeks.get(w);
                      if (v === undefined) return '—';
                      return base ? `${num(v)} (${pct(v / base, 0)})` : num(v);
                    },
                  })),
                ]}
              />
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
