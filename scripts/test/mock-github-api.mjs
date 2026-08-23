#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.MOCK_GH_STATE;
if (!statePath) throw new Error('MOCK_GH_STATE is required');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { labels: [], milestones: [], issues: {}, comments: {}, nextIssue: 100, nextComment: 900 };
const args = process.argv.slice(3); // node, script, api
const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
const endpoint = args.find((x) => !x.startsWith('-') && x !== 'api' && x !== method && x !== 'POST' && x !== 'PATCH')?.split('?')[0];
const body = args.includes('--input') ? JSON.parse(readFileSync(0, 'utf8')) : undefined;
function save() { writeFileSync(statePath, `${JSON.stringify(state)}\n`); }
function out(value) { save(); process.stdout.write(JSON.stringify(value)); }
function notFound() { console.error(`not found: ${method} ${endpoint}`); process.exit(1); }
const parts = endpoint?.split('/') ?? [];
if (method === 'GET' && /\/labels$/.test(endpoint)) out(state.labels);
else if (method === 'POST' && /\/labels$/.test(endpoint)) { const label = { ...body, id: state.labels.length + 1 }; state.labels.push(label); out(label); }
else if (method === 'GET' && /\/milestones$/.test(endpoint)) out(state.milestones);
else if (method === 'POST' && /\/milestones$/.test(endpoint)) { const milestone = { ...body, number: state.milestones.length + 1 }; state.milestones.push(milestone); out(milestone); }
else if (method === 'GET' && endpoint === 'search/issues') { const query = decodeURIComponent(process.argv.at(-1).split('q=')[1] ?? ''); const match = query.match(/issue (\d+)/); const marker = match ? `Migrated from private Gitea issue ${match[1]}` : ''; out({ items: Object.values(state.issues).filter((x) => x.body.includes(marker)) }); }
else if (method === 'POST' && /\/issues$/.test(endpoint)) { const number = state.nextIssue++; const issue = { ...body, number, state: 'open' }; state.issues[number] = issue; state.comments[number] = []; out(issue); }
else if (method === 'GET' && /\/issues\/\d+$/.test(endpoint)) { const issue = state.issues[Number(parts.at(-1))]; if (!issue) notFound(); else out(issue); }
else if (method === 'PATCH' && /\/issues\/\d+$/.test(endpoint)) { const issue = state.issues[Number(parts.at(-1))]; if (!issue) notFound(); else { Object.assign(issue, body); out(issue); } }
else if (method === 'GET' && /\/issues\/\d+\/comments$/.test(endpoint)) out(state.comments[Number(parts.at(-2))] ?? []);
else if (method === 'POST' && /\/issues\/\d+\/comments$/.test(endpoint)) { const issue = Number(parts.at(-2)); const comment = { ...body, id: state.nextComment++ }; state.comments[issue].push(comment); out(comment); }
else if (method === 'PATCH' && /\/issues\/comments\/\d+$/.test(endpoint)) { const id = Number(parts.at(-1)); const comment = Object.values(state.comments).flat().find((x) => x.id === id); if (!comment) notFound(); else { Object.assign(comment, body); out(comment); } }
else notFound();
