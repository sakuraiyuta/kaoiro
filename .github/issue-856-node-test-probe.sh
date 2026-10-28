#!/bin/sh
# Reproduces the node --test observations in design-review-r1.md. Usage: sh node-test-probe.sh
set -u
P=$(mktemp -d /tmp/node-test-probe.XXXXXX); trap 'rm -rf "$P"' EXIT
printf 'import { test } from "node:test";\nconst skip = process.env.X === "1" ? false : "set X=1";\ntest("a", { skip }, () => {});\ntest("b", { skip }, () => {});\n' > "$P/allskip.test.mjs"
printf 'import "node:test";\n' > "$P/zero.test.mjs"
printf 'import { test } from "node:test";\ntest("ok", () => {});\n' > "$P/ok.test.mjs"
printf 'export default async function* (s) { for await (const e of s) if (e.type === "test:pass") { const { details, ...d } = e.data; yield JSON.stringify({ ...d, file: d.file?.split("/").pop(), detailsType: details?.type }) + "\\n"; } }\n' > "$P/rep.mjs"
node --version
for args in "allskip.test.mjs" "zero.test.mjs" "missing.test.mjs" "ok.test.mjs missing.test.mjs" "nomatch/*.test.mjs"; do
  # shellcheck disable=SC2086
  (cd "$P" && node --test $args > out 2>&1; echo "[$args] exit=$?"; grep -E '^# (tests|pass|skipped)|Could not' out | tr '\n' ' '; echo)
done
(cd "$P" && node --test --test-reporter=./rep.mjs zero.test.mjs ok.test.mjs)
