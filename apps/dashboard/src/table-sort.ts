export interface Sort {
  key: string;
  dir: 'asc' | 'desc';
}

/** The sort after a click on a column's header: the same column flips, another starts in its own first direction. */
export function nextSort(current: Sort | undefined, key: string, firstDir: Sort['dir']): Sort {
  if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: firstDir };
}
