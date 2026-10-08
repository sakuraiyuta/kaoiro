import assert from "node:assert/strict";
import { test } from "node:test";
import {
  declaredPolicyMounts, observedPolicyMounts, selectPolicyMount,
  validatePolicyComponents, isPlacementRecord, isPlacementReference,
} from "../kaoiro-delivery-policy-placement.mjs";

const state = { type: "volume", source: "state", target: "/var/lib/kaoiro", volume: {} };
const compose = extra => ({ services: { kaoiro: { volumes: [state], ...extra } }, volumes: { state: { name: "fixture_state" } } });
const file = "/var/lib/kaoiro/delivery_policies.dets";
const parent = { Type: "volume", Name: "fixture_state", Destination: "/var/lib/kaoiro", RW: false };

test("complete mount observations include service-key and long-form tmpfs", () => {
  for (const [extra, inspect] of [
    [{ tmpfs: ["/var/lib/kaoiro/shadow:rw,size=1048576"] },
      { Mounts: [parent], HostConfig: { Tmpfs: { "/var/lib/kaoiro/shadow": "rw,size=1048576" } } }],
    [{ volumes: [state, { type: "tmpfs", target: "/var/lib/kaoiro/shadow" }] },
      { Mounts: [parent, { Type: "tmpfs", Destination: "/var/lib/kaoiro/shadow", RW: true }], HostConfig: {} }],
  ]) {
    const declarations = declaredPolicyMounts(compose(extra), null);
    const mounts = observedPolicyMounts([inspect], declarations);
    assert.equal(mounts.length, 2);
    assert.throws(() => selectPolicyMount("/var/lib/kaoiro/shadow/policy.dets", mounts, "fixture_state"), /longest/);
  }
});

test("missing HostConfig is unknown, while a decoded absent Tmpfs key is valid", () => {
  const declared = declaredPolicyMounts(compose({}), null);
  assert.throws(() => observedPolicyMounts([{ Mounts: [parent] }], declared), /incomplete/);
  assert.equal(observedPolicyMounts([{ Mounts: [parent], HostConfig: {} }], declared).length, 1);
  assert.throws(() => observedPolicyMounts([{ Mounts: [], HostConfig: {} }], declared), /cover/);
  assert.throws(() => observedPolicyMounts([{ Mounts: [{ ...parent, RW: true }], HostConfig: {} }], declared), /writable/);
});

test("state-target image VOLUME overrides refuse without guessing precedence", () => {
  for (const target of ["/var/lib/kaoiro", "/var/lib/kaoiro/shadow", "/var/lib/kaoiro/unrelated"]) {
    assert.throws(() => declaredPolicyMounts(compose({}), { [target]: {} }), /image VOLUME/);
  }
  const declarations = declaredPolicyMounts(compose({}), { "/image-only": {} });
  const mounts = observedPolicyMounts([{ Mounts: [parent, { Type: "volume", Destination: "/image-only", Name: "anonymous", RW: true }], HostConfig: {} }], declarations);
  assert.equal(selectPolicyMount(file, mounts, "fixture_state").source, "fixture_state");
});

test("longest component prefix selects only the expected writable named state volume", () => {
  const mounts = declaredPolicyMounts(compose({}), null);
  assert.equal(selectPolicyMount(file, mounts, "fixture_state").target, "/var/lib/kaoiro");
  assert.throws(() => selectPolicyMount(file, mounts, "another_state"), /longest/);
  assert.throws(() => selectPolicyMount(file, [{ ...mounts[0], writable: false }], "fixture_state"), /longest/);
  assert.throws(() => selectPolicyMount("/var/lib/kaoiro-other/policy.dets", mounts, "fixture_state"), /outside/);
  for (const type of ["bind", "tmpfs", "volume"]) {
    assert.throws(() => selectPolicyMount("/var/lib/kaoiro/shadow/policy.dets",
      [...mounts, { type, target: "/var/lib/kaoiro/shadow", source: "other", writable: true }], "fixture_state"), /longest/);
  }
  assert.equal(selectPolicyMount(file, [...mounts, { type: "tmpfs", target: "/var/lib/kaoiro/sibling", source: null, writable: true }], "fixture_state").source, "fixture_state");
});

test("namespace observation accepts missing tails but refuses aliases and unreadable components", () => {
  const prefixes = ["/", "/var", "/var/lib", "/var/lib/kaoiro", file];
  const components = prefixes.map(path => ({ path, kind: path === file ? "missing" : "directory" }));
  validatePolicyComponents(file, components);
  for (const kind of ["symlink", "error", "regular"]) {
    const changed = structuredClone(components); changed[3].kind = kind;
    assert.throws(() => validatePolicyComponents(file, changed), /component/);
  }
  assert.throws(() => validatePolicyComponents(file, components.slice(1)), /incomplete/);
  for (const value of ["/tmp/policy.dets", "/var/lib/kaoiro/../policy.dets", "/var/lib/kaoiro//policy.dets"]) {
    assert.throws(() => selectPolicyMount(value, declaredPolicyMounts(compose({}), null), "fixture_state"));
  }
});

test("placement record and references reject malformed optional fields", () => {
  assert.equal(isPlacementReference({ path: "x", sha256: "a".repeat(64) }), true);
  for (const value of [null, {}, { path: "x", sha256: "bad" }]) assert.equal(isPlacementReference(value), false);
  assert.equal(isPlacementRecord({}), false);
});
