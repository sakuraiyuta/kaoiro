# Frozen pre-N2 state reader

Exact `runner/deploy/kaoiro-runner-codex-state.mjs` from
`d3a0801370a11c6e84d566f92a549154369dbac2`, compressed with gzip (mtime 0).
Decompressed SHA-256: `69256ebce16c669b3aeb2c0bc71089aa0eef258b0b66218f874ca7b159213f51`.

The release-prune regression installs this historical reader in a disposable
dirty tool release through the real installer. It checks that an in-progress
updater's common prune uses its checked activated release rather than newly
reading the replaced tool. This fixture is test-only; it does not implement
or route any product compatibility engine.
