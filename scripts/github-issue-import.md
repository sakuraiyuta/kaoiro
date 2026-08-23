GitHub issue migration scripts

`github-issue-import.mjs` imports a reviewed local JSON bundle. It never
contacts Gitea, so acquire and freeze the bundle before invoking it. Its only
GitHub credential path is the current `gh auth token` session.

Example dry run:

```sh
node scripts/github-issue-import.mjs \
  --repo OWNER/REPO \
  --issues-glob '/secure/freeze/issues-*.json' \
  --comments-glob '/secure/freeze/comments-*.json' \
  --issue-list /secure/approved-issues.json \
  --redact-map /secure/redact-map.json \
  --state-dir /secure/import-state \
  --attachments-output /secure/attachments.json \
  --canary 3 \
  --dry-run
```

The issue list is the complete approved JSON array of Gitea issue numbers. For
a deliberately chosen canary subset, pass `--canary-list` with a JSON array
that is wholly contained in that full list; `--canary N` then limits that
selection. The redact map is a JSON
array of `{kind, pattern, replacement}` objects, where `kind` is `literal` or
`regex`; regex entries may also have JavaScript regex `flags`. Invalid input or
regexes stop the import before any GitHub API request.

For a live import, omit `--dry-run`. The importer appends a durable journal in
`--state-dir` before and after each create request and writes `old-to-new.json`
and `old-to-new-comments.json`.
If an interrupted run has a pending create record, it stops rather than risk a
duplicate. A missing journal entry uses the migration footer as a secondary
search check; multiple hits stop the run. Keep this state directory until the
post-import check succeeds.

Both map files are JSON objects. Their keys are source IDs serialized as JSON
strings; their values are GitHub numeric IDs. `old-to-new.json` maps source
issue numbers to GitHub issue numbers, while `old-to-new-comments.json` maps
source Gitea comment IDs to GitHub comment IDs.

The first pass creates issues and comments in source timestamp order. The
second pass rewrites references to selected source issue numbers and source
URLs using the completed old-to-new map, then closes issues whose source state
was closed. `/attachments/` URLs become a fixed placeholder and are emitted to
`--attachments-output` for the separate upload stage.

Run the fail-closed conservation check after a live import:

```sh
node scripts/check-github-issue-import.mjs \
  --repo OWNER/REPO \
  --issues-glob '/secure/freeze/issues-*.json' \
  --comments-glob '/secure/freeze/comments-*.json' \
  --issue-list /secure/approved-issues.json \
  --map /secure/import-state/old-to-new.json \
  --attachments /secure/attachments.json
```

It exits nonzero unless GitHub's migrated issue count, comment count, and
attachment-placeholder count all exactly match the frozen source inputs.

For the production import, use the full approved list (not a canary subset)
and add `--require-no-pending`. This makes a remaining `migration pending`
reference a nonzero conservation failure. Do not use that flag for a subset
canary: references to approved issues outside the subset are intentionally
marked pending.
