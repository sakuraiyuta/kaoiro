import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const file = process.argv[1] && resolve(process.argv[1]);
const files = JSON.parse(process.env.PROBE_FILES ?? '[]');
if (process.env.NODE_TEST_CONTEXT && files.includes(file)) {
  delete process.env.NODE_OPTIONS;
  const start = performance.now();
  process.on('exit', () => appendFileSync(process.env.PROBE_TIMINGS, JSON.stringify({ file, elapsed_ms: performance.now() - start }) + '\n'));
}
