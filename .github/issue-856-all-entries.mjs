import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const listing = spawnSync('git', ['ls-files', '-z', '--', 'scripts/test', 'server/deploy/test'], { encoding: 'utf8' });
if (listing.status !== 0) throw new Error('git ls-files failed');
const paths = listing.stdout.split('\0').filter(p => p.endsWith('.test.mjs') && !p.includes('/fixtures/')).sort();
if (paths.length !== 25) throw new Error(`expected 25 entries, found ${paths.length}`);
const files = paths.map(p => resolve(p));
const scratch = mkdtempSync(join(tmpdir(), 'momo-856-timing-'));
const timing = join(scratch, 'times.jsonl');
const env = { ...process.env, PROBE_FILES: JSON.stringify(files), PROBE_TIMINGS: timing, NODE_OPTIONS: `--import=${pathToFileURL(resolve('.github/issue-856-timer.mjs')).href}` };
delete env.KAOIRO_PREGATE_REAL;
const started = performance.now();
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=./.github/issue-856-reporter.mjs', ...files], { env, stdio: 'inherit' });
const rows = readFileSync(timing, 'utf8').trim().split('\n').map(JSON.parse);
for (const row of rows) console.log(`PROBE_WALL ${JSON.stringify({ file: row.file.slice(process.cwd().length + 1), elapsed_ms: row.elapsed_ms })}`);
if (rows.length !== files.length || new Set(rows.map(row => row.file)).size !== files.length) { console.error('timing records missing or duplicated'); process.exitCode = 1; }
rmSync(scratch, { recursive: true, force: true });
console.log(`PROBE_TOTAL ${JSON.stringify({ files: files.length, duration_ms: performance.now() - started, exit: result.status, signal: result.signal })}`);
if (result.error || result.status !== 0) process.exitCode = 1;
