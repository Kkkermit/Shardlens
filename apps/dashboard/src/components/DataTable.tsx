import { type MouseEvent, type ReactNode, useMemo, useState } from 'react';
import { nextSort, type Sort } from '../table-sort';

export interface Column<T> {
  key: string;
  header: string;
  /** Cell content. Discord-sourced text must be rendered as text (React escapes it). */
  render: (row: T) => ReactNode;
  /** Sort value; omit to make the column unsortable. */
  sort?: (row: T) => number | string | null | undefined;
  /** The direction of a first click: numbers and dates sort largest first, text A to Z. */
  firstDir?: Sort['dir'];
  numeric?: boolean;
  /** Keep the header for screen readers but hide it visually (for example an actions column). */
  hideHeader?: boolean;
}

/** A click on a control inside a row is that control's, not the row's. */
const onControl = (e: MouseEvent) => (e.target as Element).closest('a, button, input, select, label') !== null;

/** An accessible, sortable table: real `<th scope>` headers, `aria-sort`, keyboard-reachable sort buttons. */
export function DataTable<T>(props: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  initialSort?: Sort;
  /** The sort, when the page keeps it (in the address): sorting then happens on the server, through `onSort`. */
  sort?: Sort;
  onSort?: (key: string, dir: Sort['dir']) => void;
  /**
   * A mouse shortcut for a row. The row must also hold a link or button that does the same, for the keyboard and
   * screen readers: a clickable row is not a control.
   */
  onRowClick?: (row: T) => void;
  /** Shown in place of rows when there are none. */
  empty?: ReactNode;
}) {
  const [own, setOwn] = useState(props.initialSort);
  const sort = props.sort ?? own;
  const sorted = useMemo(() => {
    if (!sort || props.onSort) return props.rows;
    const col = props.columns.find((c) => c.key === sort.key);
    if (!col?.sort) return props.rows;
    const value = col.sort;
    return [...props.rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const r = x < y ? -1 : 1;
      return sort.dir === 'asc' ? r : -r;
    });
  }, [props.rows, props.columns, sort, props.onSort]);

  const toggle = (column: Column<T>) => {
    const next = nextSort(sort, column.key, column.firstDir ?? (column.numeric ? 'desc' : 'asc'));
    setOwn(next);
    props.onSort?.(next.key, next.dir);
  };

  return (
    // Focusable, so a table wider than its panel can be scrolled from the keyboard, and named for when it gets focus.
    // A group, not a region: a landmark per table would repeat its panel's name.
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling area must be reachable without a mouse (WCAG 2.1.1)
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls, and its min-width stops the scrolling
    <div className="table-wrap" role="group" aria-label={props.caption} tabIndex={0}>
      <table>
        <caption className="visually-hidden">{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={c.numeric ? 'num' : undefined}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.sort ? (
                    <button type="button" onClick={() => toggle(c)}>
                      {c.header}
                      <span aria-hidden="true">{active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</span>
                    </button>
                  ) : c.hideHeader ? (
                    <span className="visually-hidden">{c.header}</span>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={props.columns.length} className="table-empty">
                {props.empty ?? 'Nothing here yet.'}
              </td>
            </tr>
          ) : null}
          {sorted.map((row) => (
            <tr
              key={props.rowKey(row)}
              className={props.onRowClick ? 'clickable' : undefined}
              onClick={
                props.onRowClick
                  ? (e) => {
                      if (!onControl(e)) props.onRowClick?.(row);
                    }
                  : undefined
              }
            >
              {props.columns.map((c) => (
                <td key={c.key} className={c.numeric ? 'num' : undefined}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
