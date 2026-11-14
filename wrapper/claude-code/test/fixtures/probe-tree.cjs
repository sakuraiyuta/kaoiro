const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const cwd = process.argv[process.argv.indexOf('--probe-cwd') + 1];
const child = spawn(process.execPath, ['-e', `
  process.on('SIGTERM', () => {});
  console.log(process.pid);
  setInterval(() => {}, 1000);
`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => {
  writeFileSync(process.env.FUJI762_TREE_MARKER, JSON.stringify({
    leader: process.pid, grandchild: child.pid, cwd,
  }));
});
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
