import { type ReactNode, useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { formatX, type Series, xRange } from '../chart-data';
import { count } from '../format';
import { DataTable } from './DataTable';
import { Empty, TableToggle } from './ui';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Categorical slots in their validated, fixed order: colour follows the series, never its rank. */
const seriesToken = (i: number) => `--series-${(i % 8) + 1}`;

const HEIGHT = 220;

function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const bump = () => setV((x) => x + 1);
    mq.addEventListener('change', bump);
    const obs = new MutationObserver(bump);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', bump);
      obs.disconnect();
    };
  }, []);
  return v;
}

function Legend(props: { names: string[] }) {
  if (props.names.length < 2) return null;
  return (
    <ul className="chart-legend">
      {props.names.map((n, i) => (
        <li key={n}>
          <span className="swatch" style={{ background: `var(${seriesToken(i)})` }} aria-hidden="true" />
          {n}
        </li>
      ))}
    </ul>
  );
}

/**
 * Time series (uPlot) with one y-axis, 2 px lines, a crosshair tooltip, a legend for 2+ series and a table view.
 * `x` are UTC seconds standing for wall-clock times in `timezone`.
 */
export function TimeChart(props: {
  label: string;
  x: number[];
  series: Series[];
  /** Pass a function defined once (such as `ms`), not an inline one: a new function rebuilds the chart. */
  format?: (v: number) => string;
  withTime?: boolean;
  timezone?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [asTable, setAsTable] = useState(false);
  const theme = useThemeVersion();
  const format = props.format ?? count;
  const withTime = props.withTime ?? false;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `theme` re-reads the colour tokens when the theme changes
  useEffect(() => {
    const el = box.current;
    if (!el || asTable || props.x.length === 0) return;
    const colors = props.series.map((_, i) => css(seriesToken(i)));
    const muted = css('--text-muted');
    const grid = css('--grid');
    const axis = css('--axis');
    const font = `12px ${css('--font') || 'system-ui'}`;
    const tooltip: uPlot.Plugin = {
      hooks: {
        setCursor: (u) => {
          const t = tip.current;
          if (!t) return;
          const idx = u.cursor.idx;
          const xv = idx === null || idx === undefined ? undefined : u.data[0][idx];
          if (
            idx === null ||
            idx === undefined ||
            xv === undefined ||
            u.cursor.left === undefined ||
            u.cursor.left < 0
          ) {
            t.style.display = 'none';
            return;
          }
          t.replaceChildren();
          const head = document.createElement('div');
          head.className = 't';
          head.textContent = formatX(xv, withTime) + (props.timezone ? ` (${props.timezone})` : '');
          t.append(head);
          props.series.forEach((s, i) => {
            const row = document.createElement('div');
            row.className = 'row';
            const name = document.createElement('span');
            const sw = document.createElement('span');
            sw.className = 'swatch';
            sw.style.background = colors[i] ?? '';
            sw.style.marginRight = '6px';
            name.append(sw, document.createTextNode(s.name));
            const val = document.createElement('span');
            const v = s.values[idx];
            val.textContent = v === null || v === undefined ? '—' : format(v);
            row.append(name, val);
            t.append(row);
          });
          t.style.display = 'block';
          const left = u.cursor.left + 12;
          t.style.left = `${Math.min(left, (el.clientWidth || 0) - 160)}px`;
          t.style.top = `${(u.cursor.top ?? 0) + 8}px`;
        },
      },
    };
    const plot = new uPlot(
      {
        width: el.clientWidth || 600,
        height: HEIGHT,
        tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC'),
        legend: { show: false },
        cursor: { drag: { x: false, y: false }, points: { size: 8, width: 2 } },
        scales: {
          x: { time: true, range: (_u, min, max) => xRange(props.x, min, max) },
          y: { range: (_u, _min, max) => [0, max > 0 ? max * 1.1 : 1] },
        },
        axes: [
          { stroke: muted, font, grid: { stroke: grid, width: 1 }, ticks: { stroke: axis, width: 1 } },
          {
            stroke: muted,
            font,
            size: 56,
            grid: { stroke: grid, width: 1 },
            ticks: { show: false },
            values: (_u, vals) => vals.map((v) => format(v)),
          },
        ],
        series: [
          {},
          ...props.series.map((s, i) => ({
            label: s.name,
            stroke: colors[i] ?? '',
            width: 2,
            // A line needs two points: a lone one is drawn as a dot.
            points: { show: props.x.length === 1, size: 6 },
          })),
        ],
        plugins: [tooltip],
      },
      [props.x, ...props.series.map((s) => s.values)] as uPlot.AlignedData,
      el,
    );
    const resize = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: HEIGHT }));
    resize.observe(el);
    const leave = () => {
      if (tip.current) tip.current.style.display = 'none';
    };
    el.addEventListener('mouseleave', leave);
    return () => {
      resize.disconnect();
      el.removeEventListener('mouseleave', leave);
      plot.destroy();
    };
  }, [props.x, props.series, asTable, theme, format, withTime, props.timezone]);

  if (props.x.length === 0) return <Empty>No data in this range yet.</Empty>;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Legend names={props.series.map((s) => s.name)} />
        <TableToggle pressed={asTable} onToggle={() => setAsTable((v) => !v)} />
      </div>
      {asTable ? (
        <DataTable
          caption={props.label}
          rowKey={(r: number) => String(r)}
          rows={props.x.map((_, i) => i)}
          columns={[
            { key: 't', header: 'Time', render: (i) => formatX(props.x[i] ?? 0, withTime), sort: (i) => props.x[i] },
            ...props.series.map((s) => ({
              key: s.name,
              header: s.name,
              numeric: true,
              render: (i: number) => {
                const v = s.values[i];
                return v === null || v === undefined ? '—' : format(v);
              },
              sort: (i: number) => s.values[i] ?? null,
            })),
          ]}
        />
      ) : (
        <div className="chart" role="img" aria-label={props.label}>
          <div ref={box} />
          <div ref={tip} className="chart-tooltip" style={{ display: 'none' }} />
        </div>
      )}
    </div>
  );
}

/** Horizontal bars for ranked categories: one hue, values labelled, accessible as a list. */
export function BarList(props: {
  label: string;
  rows: { key: string; name: ReactNode; value: number }[];
  format?: (v: number) => string;
  limit?: number;
  empty?: ReactNode;
}) {
  const rows = props.rows.slice(0, props.limit ?? 10);
  const max = Math.max(0, ...rows.map((r) => r.value));
  const format = props.format ?? count;
  if (rows.length === 0) return <Empty>{props.empty ?? 'Nothing recorded in this range.'}</Empty>;
  return (
    <ul className="bars" aria-label={props.label}>
      {rows.map((r) => (
        <li key={r.key}>
          <span className="name">{r.name}</span>
          <span className="track" aria-hidden="true">
            <span className="fill" style={{ display: 'block', width: `${max > 0 ? (r.value / max) * 100 : 0}%` }} />
          </span>
          <span className="v">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** Hour-of-day × weekday heatmap on a single blue ramp, with a table view. */
export function Heatmap(props: { label: string; cells: { weekday: number; hour: number; value: number }[] }) {
  const [asTable, setAsTable] = useState(false);
  const value = (d: number, h: number) => props.cells.find((c) => c.weekday === d && c.hour === h)?.value ?? 0;
  const max = Math.max(0, ...props.cells.map((c) => c.value));
  const step = (v: number) => {
    if (v <= 0 || max === 0) return 'var(--surface-2)';
    const s = Math.min(7, Math.max(1, Math.ceil((v / max) * 7)));
    return `var(--seq-${s}00)`;
  };
  if (props.cells.length === 0) return <Empty>No activity in this range yet.</Empty>;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span className="heat-legend" aria-hidden="true">
          Fewer
          {[1, 2, 3, 4, 5, 6, 7].map((s) => (
            <span key={s} className="cell" style={{ background: `var(--seq-${s}00)` }} />
          ))}
          More · peak {count(max)} runs per slot
        </span>
        <TableToggle pressed={asTable} onToggle={() => setAsTable((v) => !v)} />
      </div>
      {asTable ? (
        <DataTable
          caption={props.label}
          rowKey={(d: number) => String(d)}
          rows={[1, 2, 3, 4, 5, 6, 7]}
          columns={[
            { key: 'day', header: 'Day', render: (d) => DAYS[d - 1] },
            ...Array.from({ length: 24 }, (_, h) => ({
              key: String(h),
              header: `${h}`,
              numeric: true,
              render: (d: number) => count(value(d, h)),
            })),
          ]}
        />
      ) : (
        <div className="heatmap" role="img" aria-label={props.label}>
          <span />
          {HOURS.map((h) => (
            <span key={`h${h}`} className="collabel">
              {h % 3 === 0 ? h : ''}
            </span>
          ))}
          {DAYS.map((name, i) => (
            <Row key={name} name={name} values={Array.from({ length: 24 }, (_, h) => value(i + 1, h))} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row(props: { name: string; values: number[]; step: (v: number) => string }) {
  return (
    <>
      <span className="rowlabel">{props.name}</span>
      {HOURS.map((h) => (
        <span
          key={h}
          className="cell"
          title={`${props.name} ${String(h).padStart(2, '0')}:00 · ${count(props.values[h] ?? 0)} runs`}
          style={{ background: props.step(props.values[h] ?? 0) }}
        />
      ))}
    </>
  );
}
