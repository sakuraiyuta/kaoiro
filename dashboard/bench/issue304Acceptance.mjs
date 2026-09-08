const modes = ["ascii", "ime"];
const scenarios = ["h1000-expanded", "h5000-tail", "h1000-tail"];

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, median: null, p95: null, max: null };
  return {
    count: sorted.length,
    median: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1),
  };
}

export function validateIssue304Acceptance(results) {
  const afterResults = results.filter((result) => result.variant === "after");
  const advisories = [];
  for (const result of afterResults) {
    const p95 = result.primary.dispatchToInput.p95;
    if (p95 === null || p95 > 35 || result.longTasks.length > 1) {
      throw new Error(`acceptance failure for ${result.variant}/${result.scenario}/${result.mode}/run${result.run}`);
    }
  }
  for (const mode of modes) {
    for (const scenario of scenarios) {
      const group = afterResults.filter(
        (result) => result.mode === mode && result.scenario === scenario,
      );
      const p95s = group.map((result) => result.primary.dispatchToInput.p95);
      const longtaskCounts = group.map((result) => result.longTasks.length);
      if (stats(p95s).median > 25) {
        throw new Error(`p95 median acceptance failure for after/${scenario}/${mode}`);
      }
      if (stats(longtaskCounts).median !== 0) {
        throw new Error(`longtask median acceptance failure for after/${scenario}/${mode}`);
      }
    }
    const expanded = stats(
      afterResults
        .filter((result) => result.mode === mode && result.scenario === "h1000-expanded")
        .map((result) => result.primary.dispatchToInput.p95),
    ).median;
    const tail = stats(
      afterResults
        .filter((result) => result.mode === mode && result.scenario === "h1000-tail")
        .map((result) => result.primary.dispatchToInput.p95),
    ).median;
    if (expanded === null || tail === null || expanded > tail + 8) {
      advisories.push({
        name: "expanded-tail-p95-delta",
        variant: "after",
        mode,
        expanded,
        tail,
        limit: tail === null ? null : tail + 8,
        delta: tail === null ? null : expanded - tail,
      });
    }
  }
  return advisories;
}
