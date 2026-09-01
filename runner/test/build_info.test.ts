import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatBuildIdentity,
  formatBuildRevision,
  loadBuildInfo,
} from "../src/build_info.js";

describe("loadBuildInfo (issue #228)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("well-formed な build-info.json を読み取る", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        built_at: "2026-08-12T00:00:00.000Z",
      }),
    );
    const info = loadBuildInfo(tmpDir);
    expect(info).toEqual({
      revision: "0123456789abcdef0123456789abcdef01234567",
      dirty: false,
      built_at: "2026-08-12T00:00:00.000Z",
    });
  });

  it("dirty=true も正しく読み取る", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: true,
        built_at: "2026-08-12T00:00:00.000Z",
      }),
    );
    expect(loadBuildInfo(tmpDir).dirty).toBe(true);
  });

  it("CalVer version/channel を持つ生成済み build-info を読み取る", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        built_at: "2026-08-12T00:00:00.000Z",
        version: "2026.9.0",
        channel: "release",
      }),
    );
    expect(loadBuildInfo(tmpDir)).toEqual({
      revision: "0123456789abcdef0123456789abcdef01234567",
      dirty: false,
      built_at: "2026-08-12T00:00:00.000Z",
      version: "2026.9.0",
      channel: "release",
    });
  });

  it("version/channel が片方だけの build-info は unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        built_at: "2026-08-12T00:00:00.000Z",
        version: "2026.9.0",
      }),
    );
    expect(loadBuildInfo(tmpDir)).toEqual({
      revision: "unknown",
      dirty: false,
      built_at: "unknown",
    });
  });

  it("version/channel が値域外の build-info は unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        built_at: "2026-08-12T00:00:00.000Z",
        version: "2026.99.0",
        channel: "release",
      }),
    );
    expect(loadBuildInfo(tmpDir)).toEqual({
      revision: "unknown",
      dirty: false,
      built_at: "unknown",
    });
  });

  it("release が unknown revision または dirty を伴う build-info は unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "unknown",
        dirty: true,
        built_at: "2026-08-12T00:00:00.000Z",
        version: "2026.9.0",
        channel: "release",
      }),
    );
    expect(loadBuildInfo(tmpDir)).toEqual({
      revision: "unknown",
      dirty: false,
      built_at: "unknown",
    });
  });

  // ファイルが無い経路 (tarball 配布外・pnpm build を経ていない dev 実行)
  // が "unknown" へ fail-soft することを pin する — 起動を止めてはならない。
  it("build-info.json が存在しない場合は unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    const info = loadBuildInfo(tmpDir);
    expect(info).toEqual({ revision: "unknown", dirty: false, built_at: "unknown" });
  });

  it("壊れた JSON も unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(join(tmpDir, "build-info.json"), "{ not json");
    const info = loadBuildInfo(tmpDir);
    expect(info).toEqual({ revision: "unknown", dirty: false, built_at: "unknown" });
  });

  // 型が壊れている (revision が数値、dirty が文字列など) 場合も fail-soft
  // する — 生成側のバグや将来のスキーマ変更で読み手がクラッシュしない。
  it("形が違う JSON (型不一致) も unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({ revision: 12345, dirty: "yes", built_at: null }),
    );
    const info = loadBuildInfo(tmpDir);
    expect(info).toEqual({ revision: "unknown", dirty: false, built_at: "unknown" });
  });

  it("フィールドが一部欠けている JSON も unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(join(tmpDir, "build-info.json"), JSON.stringify({ revision: "abc" }));
    const info = loadBuildInfo(tmpDir);
    expect(info).toEqual({ revision: "unknown", dirty: false, built_at: "unknown" });
  });

  // issue #228 round 2 MF-3 (ふじ 差し戻し): revision は string 型だけで
  // なく値域 (40 桁 lowercase hex または "unknown") も検証する — round 1
  // は typeof のみで、"abc" のような短すぎる/16進以外の文字列も
  // BuildInfo として受理していた。
  it("revision が値域外 (40 桁 lowercase hex でも unknown でもない) 文字列も unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "not-a-real-sha",
        dirty: false,
        built_at: "2026-08-12T00:00:00.000Z",
      }),
    );
    const info = loadBuildInfo(tmpDir);
    expect(info).toEqual({ revision: "unknown", dirty: false, built_at: "unknown" });
  });

  it("revision がアッパーケース hex (ロワーケース限定の値域外) も unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "0123456789ABCDEF0123456789ABCDEF01234567",
        dirty: false,
        built_at: "2026-08-12T00:00:00.000Z",
      }),
    );
    const info = loadBuildInfo(tmpDir);
    expect(info).toEqual({ revision: "unknown", dirty: false, built_at: "unknown" });
  });

  // issue #228 round 3 MF-4 (ふじ 差し戻し): built_at is diagnostic-only,
  // but "diagnostic" does not mean "any string" — round 2 checked only
  // typeof === "string", letting "tomorrow" or "" through as a valid
  // built_at.
  it("built_at が非 ISO 文字列 (\"tomorrow\") なら unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        built_at: "tomorrow",
      }),
    );
    const info = loadBuildInfo(tmpDir);
    expect(info).toEqual({ revision: "unknown", dirty: false, built_at: "unknown" });
  });

  it("built_at が空文字なら unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        built_at: "",
      }),
    );
    const info = loadBuildInfo(tmpDir);
    expect(info).toEqual({ revision: "unknown", dirty: false, built_at: "unknown" });
  });

  it("built_at が literal \"unknown\" なら受理する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        built_at: "unknown",
      }),
    );
    const info = loadBuildInfo(tmpDir);
    expect(info).toEqual({
      revision: "0123456789abcdef0123456789abcdef01234567",
      dirty: false,
      built_at: "unknown",
    });
  });

  // issue #228 round 4 (ふじ 差し戻し): a shape-only regex checks DIGIT
  // POSITIONS, not whether the date is calendrically real — "2026-99-99T
  // 99:99:99.999Z" matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`
  // syntactically but is not a value `toISOString()` could ever produce.
  // The round-trip check (parse -> finiteness -> re-serialize -> compare)
  // is what actually catches this.
  it("built_at が桁の形だけ整っている暦的に不正な日付 (\"2026-99-99T99:99:99.999Z\") なら unknown へ fail-soft する", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaoiro-build-info-"));
    writeFileSync(
      join(tmpDir, "build-info.json"),
      JSON.stringify({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        built_at: "2026-99-99T99:99:99.999Z",
      }),
    );
    const info = loadBuildInfo(tmpDir);
    expect(info).toEqual({ revision: "unknown", dirty: false, built_at: "unknown" });
  });
});

describe("formatBuildRevision (issue #228)", () => {
  it("clean な build はそのまま SHA を返す", () => {
    expect(
      formatBuildRevision({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        built_at: "2026-08-12T00:00:00.000Z",
      }),
    ).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("dirty な build は -dirty サフィックスを付ける", () => {
    expect(
      formatBuildRevision({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: true,
        built_at: "2026-08-12T00:00:00.000Z",
      }),
    ).toBe("0123456789abcdef0123456789abcdef01234567-dirty");
  });

  it("unknown な revision も -dirty サフィックス規則は同じ", () => {
    expect(
      formatBuildRevision({
        revision: "unknown",
        dirty: true,
        built_at: "2026-08-12T00:00:00.000Z",
      }),
    ).toBe("unknown-dirty");
  });
});

describe("formatBuildIdentity (issue #288)", () => {
  it("runner の CalVer identity は short hash を含む", () => {
    expect(
      formatBuildIdentity({
        revision: "0123456789abcdef0123456789abcdef01234567",
        dirty: false,
        built_at: "2026-08-12T00:00:00.000Z",
        version: "2026.9.0",
        channel: "release",
      }),
    ).toBe("kaoiro release runner v2026.9.0 / 0123456");
  });

  it("legacy build-info は unknown/dev として明示する", () => {
    expect(
      formatBuildIdentity({
        revision: "unknown",
        dirty: false,
        built_at: "unknown",
      }),
    ).toBe("kaoiro dev runner vunknown / unknown");
  });

  it("表記が変わっても revision の短縮形は必ず運ぶ (issue #290)", () => {
    // kaoiro-runner-update.sh reads the revision back OUT of this label to
    // decide whether the host is serving the release it just installed. The
    // wording above is free to change — rewording it updates that exact
    // string and nothing notices — but a label that stopped carrying the
    // hash would leave the post-start check with nothing to verify, and it
    // fails closed.
    //
    // The consumer splits on non-hex characters, so mere containment is not
    // the property it needs: a hex character written flush against the short
    // hash (`build b0123456`) fuses into one token that no longer prefixes
    // the revision, and the check false-rejects a correct rollout. Assert the
    // delimiters, not the substring.
    const revision = "0123456789abcdef0123456789abcdef01234567";
    expect(
      formatBuildIdentity({
        revision,
        dirty: false,
        built_at: "2026-08-12T00:00:00.000Z",
        version: "2026.9.0",
        channel: "dev",
      }),
    ).toMatch(new RegExp(`(^|[^0-9a-f])${revision.slice(0, 7)}([^0-9a-f]|$)`));
  });
});
