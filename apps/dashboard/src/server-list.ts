export const SIZES = ['1-10', '11-100', '101-1k', '1k-10k', '10k+'] as const;
const SORTS = ['name', 'members', 'runs', 'last_active', 'joined'] as const;

/** The server list's filters, sort and page, kept in the address so Back and shared links restore them. */
export interface ServerListSearch {
  q?: string;
  status?: 'left' | 'all';
  size?: (typeof SIZES)[number];
  inactive?: true;
  missing?: true;
  sort?: (typeof SORTS)[number];
  dir?: 'asc';
  /** 1-based; omitted on the first page. */
  page?: number;
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/** Reads the list's search parameters, dropping anything unknown or out of range (the address is anyone's to write). */
export function parseServerListSearch(raw: Record<string, unknown>): ServerListSearch {
  const out: ServerListSearch = {};
  if (typeof raw.q === 'string' && raw.q.trim() !== '') out.q = raw.q.slice(0, 100);
  if (raw.status === 'left' || raw.status === 'all') out.status = raw.status;
  if (oneOf(SIZES, raw.size)) out.size = raw.size;
  if (raw.inactive === true || raw.inactive === 'true') out.inactive = true;
  if (raw.missing === true || raw.missing === 'true') out.missing = true;
  if (oneOf(SORTS, raw.sort) && raw.sort !== 'members') out.sort = raw.sort;
  if (raw.dir === 'asc') out.dir = 'asc';
  const page = Number(raw.page);
  if (Number.isInteger(page) && page > 1 && page <= 10_000) out.page = page;
  return out;
}
