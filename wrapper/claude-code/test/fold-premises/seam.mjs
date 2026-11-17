// The sole active instrumentation delta: merge a diagnostic native input without
// asking AgentHost to replace its owner. All host admission guards are unchanged.
export function seam(prompt, register) {
  const source = prompt[Symbol.asyncIterator]();
  let extra = [], wake;
  register(value => { extra.push(value); wake?.(); });
  return (async function* () {
    let next = source.next();
    for (;;) {
      if (extra.length) { yield extra.shift(); continue; }
      const outcome = await Promise.race([next.then(value => ({source:value})), new Promise(resolve => {wake=()=>resolve({extra:true});})]);
      wake=undefined;
      if (outcome.extra) continue;
      if (outcome.source.done) return;
      yield outcome.source.value;
      next=source.next();
    }
  })();
}
