import { useMemo } from 'react';
import { updating, useSpec } from '../api';
import { dayX } from '../chart-data';
import { BarList, TimeChart } from '../components/charts';
import { ErrorNote, Loading, PageHead, Panel, RangePicker, Tile } from '../components/ui';
import { label, num, pct } from '../format';
import { useRange } from '../range';

interface Audience {
  daily: { day: string; users: number; newUsers: number }[];
  weekly: { week: string; users: number }[];
  periods: { period: string; users: number; final: boolean }[];
  stickiness: number | null;
  splits: Record<string, { key: string | null; value: number }[]>;
  premiumShare: number | null;
}

export function AudiencePage() {
  const r = useRange();
  const q = useSpec<Audience>({ kind: 'audience', range: r.range });
  const a = q.data;
  const dau = useMemo(
    () => ({
      x: (a?.daily ?? []).map((d) => dayX(d.day)),
      series: [
        { name: 'New', values: (a?.daily ?? []).map((d) => d.newUsers) },
        { name: 'Returning', values: (a?.daily ?? []).map((d) => d.users - d.newUsers) },
      ],
    }),
    [a],
  );
  const latestPeriod = a?.periods.at(-1);
  const latestWeek = a?.weekly.at(-1);
  const split = (dim: string) =>
    (a?.splits[dim] ?? []).map((s) => ({ key: String(s.key), name: label(dim, s.key), value: s.value }));
  return (
    <>
      <PageHead
        title="Audience"
        description="Counts only. Users are pseudonymous hashes that cannot be linked across salt periods."
        actions={<RangePicker value={r.id} onChange={r.setId} />}
      />
      {q.error ? (
        <ErrorNote error={q.error} retry={() => void q.refetch()} />
      ) : (
        <div className="stack" aria-busy={updating(q) || undefined}>
          <div className="grid tiles">
            <Tile label="Daily users (latest)" value={num(a?.daily.at(-1)?.users)} />
            <Tile
              label="Weekly users"
              value={num(latestWeek?.users)}
              sub={latestWeek ? `Week of ${latestWeek.week}` : undefined}
            />
            <Tile
              label="Users this period"
              value={num(latestPeriod?.users)}
              sub={latestPeriod ? `Since ${latestPeriod.period}` : undefined}
            />
            <Tile label="Stickiness" value={pct(a?.stickiness)} sub="Average daily ÷ period users" />
            <Tile label="Premium share" value={pct(a?.premiumShare)} sub="Of runs" />
          </div>
          <Panel title="Daily users" subtitle="New = first seen in the current salt period · UTC days">
            {q.isLoading ? (
              <Loading />
            ) : (
              <TimeChart label="Daily new and returning users" x={dau.x} series={dau.series} />
            )}
          </Panel>
          <div className="grid two">
            <Panel title="Languages" subtitle="Discord app language, not location">
              <BarList label="Runs by language" rows={split('locale')} />
            </Panel>
            <Panel title="Install type">
              <BarList label="Runs by install type" rows={split('install')} />
            </Panel>
            <Panel title="Where commands run">
              <BarList label="Runs by context" rows={split('context')} />
            </Panel>
            <Panel title="Member tier">
              <BarList label="Runs by member tier" rows={split('tier')} />
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
