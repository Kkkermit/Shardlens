import { useMemo, useState } from 'react';
import { useMeta, useSpec } from '../api';
import { BarList } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { ErrorNote, Loading, PageHead, Panel, RangePicker, Segmented } from '../components/ui';
import { ago, num, pct } from '../format';
import { useRange } from '../range';

interface EventRow {
  name: string;
  count: number;
  users: number;
  lastSeen: string;
}

interface FunnelResult {
  windowHours: number;
  steps: { label: string; users: number; medianSeconds: number | null }[];
  cohorts: { day: string; users: number[] }[];
}

interface RetentionResult {
  interval: 'day' | 'week';
  periods: number;
  cohorts: { cohort: string; size: number; retained: number[] }[];
}

/** A step is stored as `event:<name>` or `command:<name>` in the selects. */
type StepValue = string;
const toStep = (value: StepValue) => {
  const [type, ...rest] = value.split(':');
  return { type: type === 'command' ? 'command' : 'event', name: rest.join(':') };
};

const COHORT_SIZES = [
  { id: 'day', label: 'Daily' },
  { id: 'week', label: 'Weekly' },
] as const;

const WINDOWS = [
  { hours: 1, label: '1 hour' },
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
];

function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

function StepSelect(props: {
  id: string;
  label: string;
  value: StepValue;
  onChange: (v: StepValue) => void;
  events: string[];
  commands: string[];
  allowAny?: boolean;
}) {
  return (
    <label htmlFor={props.id}>
      {props.label}
      <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.allowAny ? <option value="any">Any activity</option> : null}
        <optgroup label="Custom events">
          {props.events.map((e) => (
            <option key={`event:${e}`} value={`event:${e}`}>
              {e}
            </option>
          ))}
        </optgroup>
        <optgroup label="Commands">
          {props.commands.map((c) => (
            <option key={`command:${c}`} value={`command:${c}`}>
              /{c}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}

export function EventsPage() {
  const r = useRange();
  const meta = useMeta();
  const tz = meta.data?.timezone ?? 'UTC';
  const list = useSpec<{ rows: EventRow[] }>({ kind: 'events', range: r.range });
  const commandList = useSpec<{ rows: { command: string; runs: number }[] }>({ kind: 'commands', range: r.range });
  const events = useMemo(() => (list.data?.rows ?? []).map((e) => e.name), [list.data]);
  const commands = useMemo(
    () => (commandList.data?.rows ?? []).filter((c) => c.runs > 0).map((c) => c.command),
    [commandList.data],
  );
  const options = useMemo(
    () => [...events.map((e) => `event:${e}`), ...commands.map((c) => `command:${c}`)],
    [events, commands],
  );

  const [selected, setSelected] = useState<string>();
  const current = selected ?? events[0];
  const keys = useSpec<{ keys: { key: string; count: number }[] }>(
    current ? { kind: 'eventProps', name: current, range: r.range } : null,
  );
  const [prop, setProp] = useState<string>();
  const currentProp = prop && keys.data?.keys.some((k) => k.key === prop) ? prop : keys.data?.keys[0]?.key;
  const values = useSpec<{ values: { value: string; count: number }[] }>(
    current && currentProp ? { kind: 'eventProps', name: current, prop: currentProp, range: r.range } : null,
  );

  const [stepsState, setSteps] = useState<StepValue[]>([]);
  const steps = stepsState.length >= 2 ? stepsState : options.slice(0, 2);
  const [windowHours, setWindowHours] = useState(24);
  const funnelReady = steps.length >= 2 && steps.every((s) => options.includes(s));
  const funnel = useSpec<FunnelResult>(
    funnelReady ? { kind: 'funnel', steps: steps.map(toStep), range: r.range, windowHours, timezone: tz } : null,
  );
  const setStep = (i: number, v: StepValue) => setSteps(steps.map((s, j) => (j === i ? v : s)));

  const [startState, setStart] = useState<StepValue>();
  const start = startState ?? options[0];
  const [back, setBack] = useState<StepValue>('any');
  const [cohortSize, setCohortSize] = useState<'day' | 'week'>('week');
  const retention = useSpec<RetentionResult>(
    start
      ? {
          kind: 'retention',
          start: toStep(start),
          return: back === 'any' ? 'any' : toStep(back),
          range: r.range,
          interval: cohortSize,
          timezone: tz,
        }
      : null,
  );
  const shownPeriods = Math.min(
    retention.data?.periods ?? 0,
    Math.max(1, ...(retention.data?.cohorts ?? []).map((c) => c.retained.findLastIndex((v) => v > 0) + 1)),
  );

  const first = funnel.data?.steps[0]?.users ?? 0;

  return (
    <>
      <PageHead
        title="Custom events"
        description="Events from track(), funnels across events and commands, and retention cohorts. Counts only."
        actions={<RangePicker value={r.id} onChange={r.setId} />}
      />
      <div className="notice" role="note">
        Funnels and cohorts match a person's steps by their salted hash inside the collector; only counts leave it. A
        journey that crosses into a new salt period counts as a new person, and only raw-retention days are covered.
      </div>
      <div className="stack">
        <Panel title="Events" subtitle="Select one to see its properties">
          {list.error ? (
            <ErrorNote error={list.error} />
          ) : list.isLoading ? (
            <Loading />
          ) : (
            <DataTable
              caption="Custom events"
              rowKey={(e) => e.name}
              rows={list.data?.rows ?? []}
              onRowClick={(e) => setSelected(e.name)}
              initialSort={{ key: 'count', dir: 'desc' }}
              empty="No custom events in this range. Record them with lens.track()."
              columns={[
                {
                  key: 'name',
                  header: 'Event',
                  render: (e) => (e.name === current ? <strong>{e.name}</strong> : e.name),
                  sort: (e) => e.name,
                },
                { key: 'count', header: 'Count', numeric: true, render: (e) => num(e.count), sort: (e) => e.count },
                { key: 'users', header: 'People', numeric: true, render: (e) => num(e.users), sort: (e) => e.users },
                { key: 'last', header: 'Last seen', render: (e) => ago(e.lastSeen), sort: (e) => e.lastSeen },
              ]}
            />
          )}
        </Panel>

        {current ? (
          <div className="grid two">
            <Panel title={`Properties of ${current}`} subtitle="How often each key is set">
              {keys.isLoading ? (
                <Loading />
              ) : (
                <BarList
                  label={`Properties of ${current}`}
                  rows={(keys.data?.keys ?? []).map((k) => ({ key: k.key, name: k.key, value: k.count }))}
                  empty="This event has no properties."
                />
              )}
            </Panel>
            <Panel
              title="Values"
              actions={
                (keys.data?.keys.length ?? 0) > 0 ? (
                  <label>
                    <span className="visually-hidden">Property</span>
                    <select value={currentProp ?? ''} onChange={(e) => setProp(e.target.value)}>
                      {(keys.data?.keys ?? []).map((k) => (
                        <option key={k.key} value={k.key}>
                          {k.key}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null
              }
            >
              {values.isLoading ? (
                <Loading />
              ) : (
                <BarList
                  label={`Values of ${currentProp ?? ''}`}
                  rows={(values.data?.values ?? []).map((v) => ({ key: v.value, name: v.value, value: v.count }))}
                  empty="Pick an event with properties."
                />
              )}
            </Panel>
          </div>
        ) : null}

        <Panel title="Funnel" subtitle="People who did each step in order, within the window of the first">
          {options.length < 2 ? (
            <p className="muted">Funnels need at least two custom events or commands in this range.</p>
          ) : (
            <>
              <div className="filters">
                {steps.map((s, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a step is its position, as the same event can appear twice
                  <span key={i} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <StepSelect
                      id={`funnel-step-${i}`}
                      label={`Step ${i + 1}`}
                      value={s}
                      onChange={(v) => setStep(i, v)}
                      events={events}
                      commands={commands}
                    />
                    {steps.length > 2 ? (
                      <button
                        type="button"
                        className="ghost"
                        aria-label={`Remove step ${i + 1}`}
                        onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                ))}
                {steps.length < 5 ? (
                  <button type="button" onClick={() => setSteps([...steps, options[0] ?? ''])}>
                    Add step
                  </button>
                ) : null}
                <label htmlFor="funnel-window">
                  Within
                  <select
                    id="funnel-window"
                    value={windowHours}
                    onChange={(e) => setWindowHours(Number(e.target.value))}
                  >
                    {WINDOWS.map((w) => (
                      <option key={w.hours} value={w.hours}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {funnel.error ? (
                <ErrorNote error={funnel.error} />
              ) : funnel.isLoading || !funnel.data ? (
                <Loading />
              ) : (
                <>
                  <BarList
                    label="Funnel"
                    rows={funnel.data.steps.map((s, i) => ({
                      key: String(i),
                      name: `${i + 1}. ${s.label}`,
                      value: s.users,
                    }))}
                    format={(v) => `${num(v)}${first > 0 ? ` · ${pct(v / first, 0)}` : ''}`}
                  />
                  <DataTable
                    caption="Funnel steps"
                    rowKey={(s) => String(s.i)}
                    rows={funnel.data.steps.map((s, i) => ({ ...s, i }))}
                    columns={[
                      { key: 'step', header: 'Step', render: (s) => `${s.i + 1}. ${s.label}` },
                      { key: 'users', header: 'People', numeric: true, render: (s) => num(s.users) },
                      {
                        key: 'total',
                        header: 'Of step 1',
                        numeric: true,
                        render: (s) => (first > 0 ? pct(s.users / first, 1) : '—'),
                      },
                      {
                        key: 'prev',
                        header: 'Of previous',
                        numeric: true,
                        render: (s) => {
                          const prev = funnel.data?.steps[s.i - 1]?.users;
                          return s.i === 0 || !prev ? '—' : pct(s.users / prev, 1);
                        },
                      },
                      {
                        key: 'median',
                        header: 'Median time from step 1',
                        numeric: true,
                        render: (s) => (s.i === 0 ? '—' : duration(s.medianSeconds)),
                      },
                    ]}
                  />
                  <h3 style={{ margin: '16px 0 8px' }}>By day people entered</h3>
                  <DataTable
                    caption="Funnel by entry day"
                    rowKey={(c) => c.day}
                    rows={funnel.data.cohorts}
                    empty="Nobody entered this funnel in the range."
                    columns={[
                      { key: 'day', header: 'Day', render: (c) => c.day },
                      ...funnel.data.steps.map((s, i) => ({
                        key: `s${i}`,
                        header: s.label,
                        numeric: true,
                        render: (c: { users: number[] }) => {
                          const v = c.users[i] ?? 0;
                          const base = c.users[0] ?? 0;
                          return i === 0 || base === 0 ? num(v) : `${num(v)} (${pct(v / base, 0)})`;
                        },
                      })),
                    ]}
                  />
                </>
              )}
            </>
          )}
        </Panel>

        <Panel title="Cohorts" subtitle="People grouped by when they first did something, and who came back">
          {!start ? (
            <p className="muted">Cohorts appear once custom events or commands are recorded.</p>
          ) : (
            <>
              <div className="filters">
                <StepSelect
                  id="cohort-start"
                  label="Started with"
                  value={start}
                  onChange={setStart}
                  events={events}
                  commands={commands}
                />
                <StepSelect
                  id="cohort-return"
                  label="Came back for"
                  value={back}
                  onChange={setBack}
                  events={events}
                  commands={commands}
                  allowAny
                />
                <Segmented label="Cohort size" options={COHORT_SIZES} value={cohortSize} onChange={setCohortSize} />
              </div>
              {retention.error ? (
                <ErrorNote error={retention.error} />
              ) : retention.isLoading || !retention.data ? (
                <Loading />
              ) : (
                <DataTable
                  caption="Retention cohorts"
                  rowKey={(c) => c.cohort}
                  rows={retention.data.cohorts}
                  empty="Nobody started in this range."
                  columns={[
                    { key: 'cohort', header: cohortSize === 'day' ? 'Day' : 'Week of', render: (c) => c.cohort },
                    { key: 'size', header: 'People', numeric: true, render: (c) => num(c.size) },
                    ...Array.from({ length: shownPeriods }, (_, p) => ({
                      key: `p${p + 1}`,
                      header: `${cohortSize === 'day' ? 'Day' : 'Week'} ${p + 1}`,
                      numeric: true,
                      render: (c: { cohort: string; size: number; retained: number[] }) => {
                        // A period that hasn't started yet has no data, not zero people.
                        const periodStart =
                          Date.parse(`${c.cohort}T00:00:00Z`) + (p + 1) * (cohortSize === 'day' ? 1 : 7) * 86_400_000;
                        if (periodStart > Date.now()) return '—';
                        const v = c.retained[p] ?? 0;
                        return c.size > 0 ? `${num(v)} (${pct(v / c.size, 0)})` : num(v);
                      },
                    })),
                  ]}
                />
              )}
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
