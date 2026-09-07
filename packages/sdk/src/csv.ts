export interface CsvField { from: number; to: number; value: string; column: number; row: number }
export interface CsvResult { rows: CsvField[][]; errors: { from: number; to: number; message: string }[] }
/** RFC-style quoted records, including escaped quotes and embedded CRLF. */
export function parseCsv(text: string): CsvResult {
  const rows: CsvField[][] = [], errors: CsvResult["errors"] = [];
  let row: CsvField[] = [], at = 0;
  while (at < text.length) {
    const from = at;
    let value = "";
    if (text[at] === '"') {
      at++;
      let closed = false;
      while (at < text.length) {
        if (text[at] !== '"') { value += text[at++]; continue; }
        if (text[at + 1] === '"') { value += '"'; at += 2; continue; }
        at++; closed = true; break;
      }
      if (!closed) errors.push({ from, to: at, message: "Unterminated quoted field" });
      if (at < text.length && !/[,\r\n]/.test(text[at])) {
        const start = at;
        while (at < text.length && !/[,\r\n]/.test(text[at])) at++;
        errors.push({ from: start, to: at, message: "Unexpected text after closing quote" });
      }
    } else {
      while (at < text.length && !/[,\r\n]/.test(text[at])) {
        if (text[at] === '"') errors.push({ from: at, to: at + 1, message: "Quote inside an unquoted field" });
        value += text[at++];
      }
    }
    row.push({ from, to: at, value, row: rows.length, column: row.length });
    if (text[at] === ",") {
      at++;
      if (at === text.length) row.push({ from: at, to: at, value: "", row: rows.length, column: row.length });
    } else {
      rows.push(row); row = [];
      if (text[at] === "\r" && text[at + 1] === "\n") at += 2;
      else if (at < text.length) at++;
    }
  }
  if (row.length) rows.push(row);
  const columns = rows[0]?.length;
  for (const record of rows.slice(1)) if (record.length !== columns) errors.push({ from: record[0].from, to: record.at(-1)!.to, message: `Expected ${columns} columns; found ${record.length}` });
  return { rows, errors };
}
