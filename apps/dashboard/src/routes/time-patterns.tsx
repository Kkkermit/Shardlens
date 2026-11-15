import { useState } from 'react';
import { updating, useMeta, useSpec } from '../api';
import { Heatmap } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { PageHead, Panel, QueryBody, RangePicker } from '../components/ui';
import { commandLabel, dateTime, decimal, num } from '../format';
import { useRange } from '../range';

export function TimePage() {
  const r = useRange();
  const meta = useMeta();
  const tz = meta.data?.timezone ?? 'UTC';
  const [command, setCommand] = useState('');
  const commands = useSpec<{ rows: { command: string; runs: number; kinds: string[] }[] }>({
    kind: 'commands',
    range: r.range,
  });
  const ranked = (commands.data?.rows ?? []).filter((c) => c.runs > 0).slice(0, 50);
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
      <div className="stack" aria-busy={updating(heat, bursts) || undefined}>
        <Panel
          title="Busy hours"
          actions={
            <label className="inline-field">
              Command
              <select value={command} onChange={(e) => setCommand(e.target.value)}>
                <option value="">All commands</option>
                {ranked.map((c) => (
                  <option key={c.command} value={c.command}>
                    {commandLabel(c.command, c.kinds)}
                  </option>
                ))}
              </select>
            </label>
          }
        >
          <QueryBody query={heat}>
            <Heatmap label="Runs by hour of day and weekday" cells={heat.data?.cells ?? []} />
          </QueryBody>
        </Panel>
        <Panel title="Bursts" subtitle="Minutes with more than 5× the median minute (last 14 days at most)">
          <QueryBody query={bursts}>
            {(bursts.data?.rows ?? []).length === 0 ? (
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
                    render: (b) => (b.median ? `${decimal(b.runs / b.median, 1)}×` : '—'),
                  },
                ]}
              />
            )}
          </QueryBody>
        </Panel>
      </div>
    </>
  );
}
