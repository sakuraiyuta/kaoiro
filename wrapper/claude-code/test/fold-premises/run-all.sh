#!/bin/sh
# Container driver for the E1..E4 re-measurement (kaoiro issue 1044).
# Runs the five schedules, the extractor, the judge, and every negative
# control, then prints one summary line.  Fails closed.
set -eu
E=/w/e
OUT=/w/out
mkdir -p "$OUT" /w/scratch

say() { printf '\n########## %s ##########\n' "$1"; }

say 'environment'
echo "uid=$(id -u) gid=$(id -g) HOME=${HOME:-unset} CI=${CI:-unset} PWD=$(pwd)"
echo "node=$(command -v node) version=$(node --version)"
echo "PATH=$PATH"
echo "repo HEAD=$(git -C /w/repo rev-parse HEAD)"
echo "sdk version=$(node -e "console.log(require('/w/repo/wrapper/claude-code/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version)")"
echo "bundled CLI (manifest)=$(node -e "console.log(require('/w/repo/wrapper/claude-code/node_modules/@anthropic-ai/claude-agent-sdk/manifest.json').version)")"
NATIVE=/w/repo/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@"$(node -p "require('/w/repo/wrapper/claude-code/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version")"/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
echo "native self-report=$("$NATIVE" --version 2>&1 | head -1)"
echo "native sha256=$(sha256sum "$NATIVE" | cut -d' ' -f1)"
echo "sdk.mjs sha256=$(sha256sum /w/repo/wrapper/claude-code/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs | cut -d' ' -f1)"

say 'harness identity'
(cd "$E" && sha256sum -c harness.sha256)

say 'probe runs'
for label in B0 F1 T1 P1 F2; do
  echo "--- $label ---"
  (cd "$E" && node probe.mjs "$label") && echo "probe $label exit=0" || echo "probe $label exit=$?"
  tail -1 "$OUT/$label.events.jsonl"
done

say 'extractor (checker.mjs) -- writes .check.json, asserts nothing'
(cd "$E" && node checker.mjs --selftest)
for label in B0 F1 T1 P1 F2; do (cd "$E" && node checker.mjs "$label" > "$OUT/$label.checker.log"); done
set -- "$OUT"/*.check.json
echo "check.json written: $#"

say 'judge selftest and the N7 mutation'
node "$E/judge.mjs" --selftest
if JUDGE_MUTATE_BYTES=1 node "$E/judge.mjs" --selftest; then
  echo 'N7 FAILED TO BE CAUGHT'; exit 1
fi
echo 'N7 ok: the always-true byte predicate fails the judge selftest'

say 'expectation'
node "$E/judge.mjs" --mkexpect "$OUT" "$OUT/expect.json"
cat "$OUT/expect.json"

say 'judgement'
judge_exit=0
node "$E/judge.mjs" "$OUT" "$OUT/expect.json" > "$OUT/judge.log" 2>&1 || judge_exit=$?
cat "$OUT/judge.log"
echo "judge exit=$judge_exit"

say 'negative controls on the expectation side'
fail=0
check_neg() {
  name=$1; shift
  node "$E/judge.mjs" --mutate "$name" "$OUT/expect.json" "$OUT/expect-$name.json" >/dev/null
  if node "$E/judge.mjs" "$OUT" "$OUT/expect-$name.json" > "$OUT/neg-$name.log" 2>&1; then
    echo "$name: JUDGE STILL PASSED -- control did not bite"; fail=1; return
  fi
  for id in "$@"; do
    if grep -q "^FAIL .* $id " "$OUT/neg-$name.log"; then :; else
      echo "$name: expected $id to fail but it did not"; fail=1
    fi
  done
  echo "$name: ok -- $(grep -c '^FAIL' "$OUT/neg-$name.log") failing judgements: $(grep '^FAIL' "$OUT/neg-$name.log" | awk '{print $2"/"$3}' | tr '\n' ' ')"
}
check_neg N1 J2
check_neg N2 J2
check_neg N3 J5
check_neg N4 J10 J15
check_neg N5a J24
check_neg N5b J25
check_neg N5c J26
check_neg N6 J14 J18
check_neg N9 J27

say 'N8 -- bypass the extractor byte predicate'
mkdir -p /w/n8
cp "$OUT"/*.events.jsonl "$OUT"/*.requests.jsonl /w/n8/
sed -e "s|const base='/w/out'|const base='/w/n8'|" \
    -e "s|const includesBytes=(text,input)=>Buffer.from(text,'utf8').includes(Buffer.from(input,'utf8'));|const includesBytes=(text,input)=>true;|" \
    "$E/checker.mjs" > "$E/checker-mutant.mjs"
if diff -q "$E/checker.mjs" "$E/checker-mutant.mjs" >/dev/null; then
  echo 'N8 mutation changed nothing'; exit 1
fi
for label in B0 F1 T1 P1 F2; do (cd "$E" && node checker-mutant.mjs "$label" >/dev/null); done
node "$E/judge.mjs" --mkexpect /w/n8 /w/n8/expect.json >/dev/null
if node "$E/judge.mjs" /w/n8 /w/n8/expect.json > "$OUT/neg-N8.log" 2>&1; then
  echo 'N8: JUDGE STILL PASSED -- control did not bite'; fail=1
else
  # Measured 2026-11-07: bypassing the extractor's byte predicate reaches J3
  # only.  hook_predictions is built with exact() and ===, not that predicate,
  # so J7 is unaffected here; N3 is what falsifies J7 (see its line above).
  grep -q '^FAIL .* J3 ' "$OUT/neg-N8.log" || { echo 'N8: expected J3 to fail'; fail=1; }
  grep -q "^FAIL .* J7 " "$OUT/neg-N3.log" || { echo 'N8: J7 is not pinned by N3 either'; fail=1; }
  echo "N8: ok -- failing: $(grep '^FAIL' "$OUT/neg-N8.log" | awk '{print $2"/"$3}' | tr '\n' ' ')(J7 is pinned by N3)"
fi

say 'N10 -- a run cut before request 2'
mkdir -p /w/n10
cut=$(grep -n '"type":"model_request"' "$OUT/F1.events.jsonl" | sed -n '2p' | cut -d: -f1)
[ -n "$cut" ] || { echo 'N10: could not locate the second model_request'; exit 1; }
head -n $((cut - 1)) "$OUT/F1.events.jsonl" > /w/n10/F1.events.jsonl
head -n 1 "$OUT/F1.requests.jsonl" > /w/n10/F1.requests.jsonl
cp "$OUT/F1.check.json" /w/n10/
node "$E/judge.mjs" --mkexpect /w/n10 /w/n10/expect.json >/dev/null
node "$E/judge.mjs" /w/n10 /w/n10/expect.json > "$OUT/neg-N10.log" 2>&1 || true
grep -q '^FAIL F1 J0 ' "$OUT/neg-N10.log" || { echo 'N10: expected F1 J0 to fail'; fail=1; }
grep -q '^SKIP F1 ' "$OUT/neg-N10.log" || { echo 'N10: expected F1 to be skipped'; fail=1; }
if grep -qE '^(PASS|FAIL) F1 J(1|2|4|5|6|24) ' "$OUT/neg-N10.log"; then
  echo 'N10: a premise verdict was drawn from a run that was not established'; fail=1
fi
echo "N10: ok -- $(grep '^FAIL F1' "$OUT/neg-N10.log" | awk '{print $3}' | tr '\n' ' ')and then skipped"

say 'positive controls for the absence claims (J1, J8, J22)'
# Same expressions the judge uses, applied where the thing IS present.
# shellcheck disable=SC2016
node -e '
const fs=require("node:fs");
const rd=p=>fs.existsSync(p)?fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse):[];
const inc=(t,i)=>Buffer.from(t,"utf8").includes(Buffer.from(i,"utf8"));
const texts=n=>{const o=[];const w=x=>{if(Array.isArray(x))return x.forEach(w);if(!x||typeof x!=="object")return;
 if(typeof x.text==="string")o.push(x.text);if(typeof x.content==="string")o.push(x.content);
 if(Array.isArray(x.content))w(x.content);};w(n);return o;};
for(const run of ["B0","F1","T1","P1","F2"]){
 const ev=rd(`/w/out/${run}.events.jsonl`), rq=rd(`/w/out/${run}.requests.jsonl`);
 const push=ev.find(e=>e.type==="seam_push"), setup=ev.find(e=>e.type==="setup");
 const payload=(push??setup)?.payload;
 const hits=rq.map(r=>`${r.request}:${payload?texts(r.body.messages).some(t=>inc(t,payload)):"n/a"}`);
 const tu=ev.filter(e=>e.type==="sdk_frame"&&Array.isArray(e.frame.message?.content)
   &&e.frame.message.content.some(b=>b?.type==="tool_use")).length;
 console.log(`${run}: payload byte hits per request [${hits.join(" ")}]  frames with a tool_use block=${tu}`);
}'

say 'raw file identity'
(cd "$OUT" && sha256sum ./*.events.jsonl ./*.requests.jsonl ./*.responses.jsonl ./*.check.json expect.json)

say 'summary'
[ "$fail" = 0 ] || { echo 'NEGATIVE CONTROLS INCOMPLETE'; exit 1; }
echo 'ALL NEGATIVE CONTROLS BIT'
echo "judge exit on the unmutated expectation=$judge_exit"
[ "$judge_exit" = 0 ] || { echo 'PREMISES NOT ALL ESTABLISHED; read judge.log'; exit 1; }
echo 'J0 and J1..J27 all PASS on the unmutated expectation'
