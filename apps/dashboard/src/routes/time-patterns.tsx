import { useState } from 'react';
import { useMeta, useSpec } from '../api';
import { Heatmap } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { ErrorNote, Loading, PageHead, Panel, RangePicker } from '../components/ui';
import { dateTime, num } from '../format';
import { useRange } from '../range';

export function TimePage() {
  const r = useRange();
  const meta = useMeta();
  const tz = meta.data?.timezone ?? 'UTC';
  const [command, setCommand] = useState('');
  const commands = useSpec<{ rows: { key: string; count: number }[] }>({
    kind: 'top',
    metric: 'interactions',
    range: r.range,
    groupBy: 'command',
    limit: 50,
  });
  const heat = useSpec<{ cells: { weekday: number; hour: number; value: number }[] }>({
    kind: 'heatmap',
    range: r.range,
    timezone: tz,
    filters: command ? [{ field: 'command', value: command }] : [],
  });
  const bursts = useSpec<{ rows: { minute: string; runs: number; median: number }[] }>({
    kind: 'bursts',
    range: r.range,
  });
  return (
    <>
      <PageHead
        title="Time patterns"
        description={`All times in ${tz}.`}
        actions={<RangePicker value={r.id} onChange={r.setId} />}
      />
      <div className="stack">
        <Panel
          title="Busy hours"
          actions={
            <label className="muted">
              Command{' '}
              <select value={command} onChange={(e) => setCommand(e.target.value)}>
                <option value="">All commands</option>
                {(commands.data?.rows ?? []).map((c) => (
                  <option key={c.key} value={c.key}>
                    /{c.key}
                  </option>
                ))}
              </select>
            </label>
          }
        >
          {heat.isLoading ? (
            <Loading />
          ) : heat.error ? (
            <ErrorNote error={heat.error} />
          ) : (
            <Heatmap label="Runs by hour of day and weekday" cells={heat.data?.cells ?? []} />
          )}
        </Panel>
        <Panel title="Bursts" subtitle="Minutes with more than 5× the median minute (last 14 days at most)">
          {bursts.isLoading ? (
            <Loading />
          ) : bursts.error ? (
            <ErrorNote error={bursts.error} />
          ) : (bursts.data?.rows ?? []).length === 0 ? (
            <p className="muted">No bursts found.</p>
          ) : (
            <DataTable
              caption="Bursts"
              rowKey={(b) => b.minute}
              rows={bursts.data?.rows ?? []}
              columns={[
                { key: 'minute', header: 'Minute', render: (b) => dateTime(b.minute, tz), sort: (b) => b.minute },
                { key: 'runs', header: 'Runs', numeric: true, render: (b) => num(b.runs), sort: (b) => b.runs },
                {
                  key: 'x',
                  header: '× median',
                  numeric: true,
                  render: (b) => (b.median ? `${(b.runs / b.median).toFixed(1)}×` : '—'),
                },
              ]}
            />
          )}
        </Panel>
      </div>
    </>
  );
}
