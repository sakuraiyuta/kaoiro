import { createHash } from "node:crypto";
import { BUILD_REPOSITORY_ID, parseLandingVersion, validateFrozenBuildIdentity } from "./build-identity.mjs";
import { RELEASE_ALIAS, RELEASE_DIGEST, RELEASE_UUID } from "./production-release-state.mjs";

const must = (value, message) => { if (!value) throw new Error(`release plan refused: ${message}`); };
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();

export function validateRuntimeHosts(pairs) {
  must(Array.isArray(pairs) && pairs.length >= 1 && pairs.length <= 16, "private host map bounds");
  const aliases = new Set();
  const real = new Set();
  for (const pair of pairs) {
    must(exact(pair, ["alias", "runtime_host_id"]) && RELEASE_ALIAS.test(pair.alias ?? "") &&
      typeof pair.runtime_host_id === "string" && pair.runtime_host_id.length >= 1 &&
      Buffer.byteLength(pair.runtime_host_id) <= 256 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(pair.runtime_host_id), "private host map entry");
    must(!aliases.has(pair.alias) && !real.has(pair.runtime_host_id), "duplicate host alias or runtime ID");
    aliases.add(pair.alias);
    real.add(pair.runtime_host_id);
  }
  const hashes = new Set(pairs.map(pair => createHash("sha256").update(pair.runtime_host_id).digest("hex").slice(0, 16)));
  must(pairs.every(pair => !real.has(pair.alias) && !hashes.has(pair.alias)), "alias reveals a runtime ID or its host-key hash");
  return pairs;
}

export function validatePlanAuthority(authority, hostIds) {
  must(exact(authority, ["server", "runners"]), "expected authority inventory");
  must(exact(authority.server, ["root", "sha256"]) && authority.server.root?.startsWith("/") &&
    RELEASE_DIGEST.test(authority.server.sha256 ?? ""), "server authority");
  must(Array.isArray(authority.runners) && authority.runners.length === hostIds.length, "runner authority inventory");
  const aliases = new Set();
  for (const runner of authority.runners) {
    must(exact(runner, ["alias", "root", "sha256"]) && hostIds.includes(runner.alias) && !aliases.has(runner.alias) &&
      runner.root?.startsWith("/") && RELEASE_DIGEST.test(runner.sha256 ?? ""), "runner authority");
    aliases.add(runner.alias);
  }
  return authority;
}

export function validateEnrollmentInventory(value) {
  must(exact(value, ["schema", "runtime_hosts", "authority"]) && value.schema === 1,
    "fixed enrollment inventory schema");
  validateRuntimeHosts(value.runtime_hosts);
  validatePlanAuthority(value.authority, value.runtime_hosts.map(pair => pair.alias));
  return value;
}

export function validateReleasePlan(plan, uuid) {
  must(plan?.schema === 1 && RELEASE_UUID.test(uuid ?? "") && plan.attempt_uuid === uuid, "attempt UUID binding");
  validateFrozenBuildIdentity(plan.identity);
  must(plan.identity.landing?.repository_id === BUILD_REPOSITORY_ID && parseLandingVersion(plan.identity.version) &&
    plan.identity.branch === "develop" && plan.identity.dirty === false, "clean landing target");
  must(Array.isArray(plan.host_ids) && plan.host_ids.length >= 1 && plan.host_ids.length <= 16 &&
    new Set(plan.host_ids).size === plan.host_ids.length && plan.host_ids.every(id => typeof id === "string" && RELEASE_ALIAS.test(id)), "public host aliases");
  must(Array.isArray(plan.codex_host_ids) && new Set(plan.codex_host_ids).size === plan.codex_host_ids.length &&
    plan.codex_host_ids.every(id => plan.host_ids.includes(id)), "Codex alias subset");
  must(typeof plan.created_at === "string" && Number.isFinite(Date.parse(plan.created_at)) &&
    new Date(plan.created_at).toISOString() === plan.created_at, "canonical start clock");
  if (plan.runtime_hosts !== undefined || plan.authority !== undefined) {
    validateRuntimeHosts(plan.runtime_hosts);
    must(JSON.stringify(plan.runtime_hosts.map(pair => pair.alias).sort()) === JSON.stringify([...plan.host_ids].sort()), "private/public inventory differs");
    validatePlanAuthority(plan.authority, plan.host_ids);
  }
  return plan;
}

export function projectReleasePlan(plan) {
  return {
    schema: plan.schema, attempt_uuid: plan.attempt_uuid, identity: plan.identity,
    host_ids: plan.host_ids, codex_host_ids: plan.codex_host_ids, created_at: plan.created_at,
    authority: plan.authority ? {
      server: { sha256: plan.authority.server.sha256 },
      runners: plan.authority.runners.map(({ alias, sha256 }) => ({ alias, sha256 })),
    } : null,
  };
}
