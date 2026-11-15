import { type ReactNode, useMemo, useState } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  /** Cell content. Discord-sourced text must be rendered as text (React escapes it). */
  render: (row: T) => ReactNode;
  /** Sort value; omit to make the column unsortable. */
  sort?: (row: T) => number | string | null | undefined;
  numeric?: boolean;
  /** Keep the header for screen readers but hide it visually (for example an actions column). */
  hideHeader?: boolean;
}

/** An accessible, sortable table: real `<th scope>` headers, `aria-sort`, keyboard-reachable sort buttons. */
export function DataTable<T>(props: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;
  /** Sorting happens on the server (paged tables). */
  onSort?: (key: string, dir: 'asc' | 'desc') => void;
  /** Shown in place of rows when there are none. */
  empty?: ReactNode;
}) {
  const [sort, setSort] = useState(props.initialSort);
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

  const toggle = (key: string) => {
    const dir: 'asc' | 'desc' = sort?.key === key && sort.dir === 'desc' ? 'asc' : 'desc';
    setSort({ key, dir });
    props.onSort?.(key, dir);
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
                    <button type="button" onClick={() => toggle(c.key)}>
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
              <td
                colSpan={props.columns.length}
                className="muted"
                style={{ textAlign: 'center', padding: '20px 10px' }}
              >
                {props.empty ?? 'Nothing here yet.'}
              </td>
            </tr>
          ) : null}
          {sorted.map((row) => (
            <tr
              key={props.rowKey(row)}
              className={props.onRowClick ? 'clickable' : undefined}
              onClick={props.onRowClick ? () => props.onRowClick?.(row) : undefined}
              onKeyDown={
                props.onRowClick
                  ? (e) => {
                      if (e.key === 'Enter') props.onRowClick?.(row);
                    }
                  : undefined
              }
              tabIndex={props.onRowClick ? 0 : undefined}
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
