/**
 * Runs matching `condition`: 0 when none did, `null` only when nothing ran at all. A plain `sum() FILTER` is `null` for
 * no matching rows, which read as "unknown" next to runs that did happen. SQL fragments from code only.
 */
export const countWhenRan = (condition: string) =>
  `(CASE WHEN count(*) > 0 THEN coalesce(sum(weight) FILTER (WHERE ${condition}), 0) END)::float8`;

/** The share of runs matching `condition` among those matching `of`, 0 to 1; `null` when none match `of`. */
export const share = (condition: string, of: string) =>
  `(coalesce(sum(weight) FILTER (WHERE ${condition}), 0) / nullif(sum(weight) FILTER (WHERE ${of}), 0))::float8`;
