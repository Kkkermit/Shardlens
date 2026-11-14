/**
 * Formats one CSV cell, neutralising spreadsheet formulas: cells starting with `=`, `+`, `-`, `@`, tab or carriage
 * return get a leading apostrophe. Server names and custom IDs are untrusted text.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
