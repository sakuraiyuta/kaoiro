# Pre-P3 journal readers

These unmodified modules are the real reader dependency closure from the commit
in `provenance.json`. Each copy was compared byte-for-byte with `git show` at
creation. The compatibility test verifies every stored SHA-256 and imports the
fixture itself, so shallow CI needs no Git history.

`invocation.release_authority: null` remains a permanent compatibility literal
in the current writer. It carries no enrollment or authorization meaning.
