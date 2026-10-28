import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const listing = spawnSync('git', ['ls-files', '-z', '--', 'scripts/test', 'server/deploy/test'], { encoding: 'utf8' });
if (listing.status !== 0) throw new Error('git ls-files failed');
const paths = listing.stdout.split('\0').filter(p => p.endsWith('.test.mjs') && !p.includes('/fixtures/')).sort();
if (paths.length !== 25) throw new Error(`expected 25 entries, found ${paths.length}`);
const files = paths.map(p => resolve(p));
const env = { ...process.env, PROBE_FILES: JSON.stringify(files) };
delete env.KAOIRO_PREGATE_REAL;
const started = performance.now();
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=./.github/issue-856-reporter.mjs', ...files], { env, stdio: 'inherit' });
console.log(`PROBE_TOTAL ${JSON.stringify({ files: files.length, duration_ms: performance.now() - started, exit: result.status, signal: result.signal })}`);
if (result.error || result.status !== 0) process.exitCode = 1;
