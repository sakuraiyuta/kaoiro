import { relative } from 'node:path';

export default async function* report(source) {
  const files = JSON.parse(process.env.PROBE_FILES);
  const rows = new Map(files.map(file => [file, { file: relative(process.cwd(), file), pass: 0, skip: 0, todo: 0, fail: 0, synthetic: 0, events: 0, duration_ms: 0 }]));
  for await (const event of source) {
    const data = event.data;
    const row = rows.get(data.file);
    if (!row) continue;
    row.events++;
    if (event.type === 'test:fail') {
      row.fail++;
      yield `FAIL ${row.file} ${data.name}: ${data.details?.error?.message ?? 'unknown'}\n`;
    }
    if (event.type !== 'test:pass') continue;
    if (data.nesting === 0 && data.name === data.file && data.line === 1 && data.column === 1) row.synthetic++;
    else if (data.skip) row.skip++;
    else if (data.todo) row.todo++;
    else row.pass++;
    row.duration_ms += data.details?.duration_ms ?? 0;
  }
  for (const row of rows.values()) yield `PROBE_FILE ${JSON.stringify(row)}\n`;
}
