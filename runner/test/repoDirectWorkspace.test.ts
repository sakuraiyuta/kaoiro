// The repo-direct profile, measured on the LAYOUT PRODUCTION ACTUALLY HAS.
//
// verify-release.mjs supports two profiles: a built release, and a repo-direct
// checkout (no VERSION, no MANIFEST.json — the four sentinels only). The
// second one could never pass. pnpm links a workspace member into its
// dependents by a relative path that leaves the dependent, so every sentinel
// under runner/node_modules/@kaoiro/ resolved OUTSIDE runner/ and the
// containment check rejected it. The service went to exit 78 on the first
// restart after the check reached production, on a tree whose builds were
// current.
//
// releaseFixture.ts could not catch that, and still cannot: it writes
// node_modules/@kaoiro/* as real directories inside the release root, which is
// what a BUILT RELEASE looks like. The repo-direct test that ran against it
// was therefore measuring the fixture's own shape, not the shape it named. So
// this file does two things the other one cannot:
//
//   1. stages the workspace link topology itself — wrappers in sibling
//      members, reached through the same relative links pnpm writes — and
//      starts the real shim on it;
//   2. pins pnpm's layout as an explicit premise against the REAL checkout, so
//      a fixture that stops mirroring reality fails here rather than passing
//      quietly.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revisionOf, runScript, writeWorkspaceCheckout } from "./releaseFixture.js";

const REVISION = revisionOf("repo-direct-workspace");

/** The checkout this file's fixture stands in for: runner/test/ -> repo root. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** pnpm's own spelling, relative to the link's own directory
 *  (`<ws>/runner/node_modules/@kaoiro/`). Copied from the live checkout rather
 *  than composed: the premise test below is what keeps the two equal. */
const linkTarget = (wrapper: string): string => `../../../wrapper/${wrapper}`;

describe("repo-direct な workspace checkout の起動検証", () => {
  let dir: string;
  let ws: string;
  let runner: string;
  let confDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaoiro-repo-direct-"));
    ws = join(dir, "workspace");
    mkdirSync(ws, { recursive: true });
    // writeWorkspaceCheckout (issue #259) stages the REAL pnpm workspace link
    // topology this file's tests actually need — the runner tree in
    // `runner/`, wrapper packages as sibling members, and
    // runner/node_modules/@kaoiro reaching them by relative links out of the
    // runner tree — rather than the built-release shape writeReleaseTree
    // alone produces.
    runner = writeWorkspaceCheckout(ws, REVISION);

    confDir = join(dir, "config");
    mkdirSync(confDir, { recursive: true });
    writeFileSync(
      join(confDir, "runner.config.json"),
      JSON.stringify({ host_id: "test-host", server_url: "ws://localhost/x" }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const launch = () =>
    runScript(join(runner, "deploy", "kaoiro-runner-launch.sh"), [], {
      KAOIRO_RUNNER_DIR: confDir,
    });

  it("wrapper が workspace リンク越しでも起動する", () => {
    const result = launch();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stub cli.js started");
  });

  it("rejects a repo-direct checkout whose Codex runtime link is missing", () => {
    unlinkSync(join(ws, "wrapper", "codex", "node_modules", "@openai", "codex"));

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("@openai/codex");
    expect(result.stdout).not.toContain("stub cli.js started");
  });

  it("workspace の外を指すリンクは exit 78 で起動しない", () => {
    // The negative control the release root used to provide for free. Widening
    // the boundary to the workspace must not widen it to the filesystem: a
    // sentinel reached through a link out of the checkout is still a tree
    // whose contents nobody can account for.
    const outside = join(dir, "outside", "claude-code");
    mkdirSync(outside, { recursive: true });
    renameSync(join(ws, "wrapper", "claude-code"), outside);
    const link = join(runner, "node_modules", "@kaoiro", "claude-code");
    unlinkSync(link);
    symlinkSync(outside, link);

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("resolves outside the release");
    expect(result.stdout).not.toContain("stub cli.js started");
    // issue #259: this exact failure class (a containment-boundary
    // violation) is the incident the launch shim's OLD unconditional "run
    // pnpm build" guidance misled an operator with — the artifacts were all
    // present and current, a rebuild changed nothing, and the same failure
    // recurred 15 seconds later. The guidance must not repeat that mistake.
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
    expect(result.stderr).toContain("NOT a missing build");
  });

  it("dangling な workspace symlink は build shortage と誤分類されない", () => {
    // ふじ review must-fix 1: containedRealPath の realpathSync ENOENT 分岐が
    // err.code==="ENOENT" のみで MissingArtifactError (build 提案あり) に
    // していたため、「途中の workspace symlink 自体が dangling」なケース
    // (leaf ではなく symlink の解決先が無い) でも build 不足と誤分類していた
    // — workspace リンクの修復は build ではなく checkout topology の問題。
    // healthy な既存リンクを外し、存在しない sibling を指す dangling
    // symlink に置き換える(ふじの probe と同一手順)。
    const link = join(runner, "node_modules", "@kaoiro", "claude-code");
    unlinkSync(link);
    symlinkSync("../../../wrapper/missing-claude-code", link);

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("is a broken symlink");
    expect(result.stdout).not.toContain("stub cli.js started");
    // The pin: this must land in the SAME "not a missing build" bucket a
    // containment violation does, not the "a build artifact is missing"
    // bucket a genuinely never-built leaf does, and NOT the "workspace
    // link missing" bucket either -- the link is present, just broken.
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
    expect(result.stderr).not.toContain("pnpm install");
    expect(result.stderr).toContain("NOT a missing build");
  });

  it("workspace リンクの祖先ディレクトリごと欠けていれば install shortage (ふじ round3 must-fix 1)", () => {
    // ふじ round 3: node_modules/@kaoiro が丸ごと存在しないのは build
    // output 不足ではなく pnpm install が作る workspace dependency
    // topology 不足であり、build shortage (exit 71) に分類するのは誤り
    // だった (内部review round2で通した旧テストは、まさにこの誤った
    // 期待値を pin していた)。ふじの実測: 案内どおり
    // `pnpm -C wrapper build && pnpm -C runner build` を実行しても
    // runner build は exit 2 (TS2307 cannot find module)、
    // node_modules/@kaoiro は再生成されない。checkWorkspaceLinkedSentinel
    // は link component 自体の欠落を明示的に lstat で判定し、
    // MissingWorkspaceLinkError (exit 72、pnpm install を案内) に分類する。
    rmSync(join(runner, "node_modules", "@kaoiro"), { recursive: true, force: true });

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
    expect(result.stderr).toContain("workspace dependency link");
    expect(result.stderr).toContain("pnpm install");
    // build は正しい remedy ではない -- 提案してはならない。
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
  });

  it("dist が dangling symlink なら build shortage ではない (ふじ round3 must-fix 2)", () => {
    // ふじ round 3: readBuildInfoStrict の bare err.code==="ENOENT" は
    // dist 自体が dangling symlink な場合も無条件に build shortage
    // (exit 71) にしていた。「dist は常に real directory」という前提コメ
    // ントは健全な生成直後の topology しか述べておらず、破損した tree を
    // 拒否・診断するはずの verifier がその前提に依存してはいけない。
    // ふじの実測: 案内どおり build しても runner build は exit 2
    // (TS5033、dangling dist へ書き込めない)、dangling symlink は
    // 修復されない。checkBuildOutputLeaf は dist 自身の型を明示的に
    // lstat で確認し、symlink (健全・dangling を問わず) や file なら
    // build-fixable と分類しない。
    const distReal = join(runner, "dist-elsewhere");
    renameSync(join(runner, "dist"), distReal);
    symlinkSync("missing-dist", join(runner, "dist"));

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
    expect(result.stderr).toContain("not an ordinary directory");
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
    expect(result.stderr).not.toContain("pnpm install");
    expect(result.stderr).toContain("NOT a missing build");
  });

  it("build output leaf 自身が release 外を指す dangling symlink なら build shortage ではない (ふじ round4 must-fix)", () => {
    // ふじ round4: checkBuildOutputLeaf は containing directory (dist)
    // の型しか検査しておらず、leaf 自身 (dist/cli.js) が release 外の
    // 欠落先を指す symlink の場合、realpathSync の ENOENT を無条件に
    // build shortage (exit 71) にしていた。ふじの実測(disposable な実
    // checkout): 案内どおり build を実行すると exit 0 で成功するが、
    // symlink の外部 target に新しいファイルを生成するだけで symlink
    // 自体はそのまま残り、再度 verifier を実行すると今度は containment
    // 違反 (dist/cli.js resolves outside the release, exit 70) になる —
    // 提案された remedy は tree を修復せず、失敗を移動させただけだった。
    // leaf 自体の型を realpathSync 前に lstatType で捕捉しておき、ENOENT
    // (dangling) の場合だけ build-fixable 分類から除外する — resolve に
    // 成功する symlink leaf (健全、container の外を指す場合も含む) は
    // 従来どおり通常の containment check へフォールスルーする
    // (releaseInstall.test.ts の「outside-the-release symlink は
    // containment で拒否する」既存 negative control が、まさにこの
    // フォールスルー経路に依存しているため — leaf を無条件拒否すると
    // その既存テストの "outside the release" という診断に到達できなく
    // なる。実際に一度無条件拒否で実装し、既存テストが red になることを
    // 確認してからこの形へ直した)。
    const leaf = join(runner, "dist", "cli.js");
    unlinkSync(leaf);
    symlinkSync(join(dir, "outside-cli.js"), leaf);

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
    expect(result.stderr).toContain("is missing or unresolvable");
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
    expect(result.stderr).not.toContain("pnpm install");
    expect(result.stderr).toContain("NOT a missing build");
  });

  it("build output leaf が release 内を指す健全な symlink なら通常どおり起動する (positive control)", () => {
    // 上のテストの反対側: resolve に成功する leaf symlink まで無条件拒否
    // しないことのpin。dist/cli.js の内容を同じ dist/ 内の別名ファイルへ
    // 複製し、cli.js をそこへの relative symlink に置き換える(exec 自体
    // も実際に成功することまで見るため、実 cli.js と同一内容にする)。
    // containment check は通り、起動は成功する。
    const leaf = join(runner, "dist", "cli.js");
    const content = readFileSync(leaf, "utf8");
    writeFileSync(join(runner, "dist", "cli-real.js"), content);
    unlinkSync(leaf);
    symlinkSync("cli-real.js", leaf);

    const result = launch();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stub cli.js started");
  });

  it("runner 自身の build output leaf が directory なら build shortage ではなく分類される (ふじ round4 must-fix 1)", () => {
    // ふじ round4 must-fix 1: checkBuildOutputLeaf は containment (realpath
    // が release 内へ resolve するか) しか検査しておらず、resolve 先が
    // ORDINARY FILE かどうかは一度も見ていなかった。ディレクトリも
    // containment check をそのまま通過する。実測(修正前の HEAD 3666b5e に
    // 対して自分で再現): dist/cli.js をディレクトリに置き換えると
    // verify-release.mjs は exit 0 で成功と判定し、shim はそのまま
    // `node dist/cli.js` を実行して Node 自身の生の MODULE_NOT_FOUND
    // スタックトレースで exit 1 になった — 78 ではないので systemd の
    // RestartPreventExitStatus=78 は効かず、しかも診断は classified
    // VerifyError ではなく生の Node crash だった。
    const leaf = join(runner, "dist", "cli.js");
    rmSync(leaf, { force: true });
    mkdirSync(leaf);

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
    // 生の Node crash ではなく、分類された VerifyError の診断であること。
    expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
    expect(result.stderr).not.toContain("Node.js v");
    expect(result.stderr).toContain("is not an ordinary file");
    // directory を置き換えているのは「未 build」ではなく破損なので、
    // build を提案してはならない。
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
    expect(result.stderr).toContain("NOT a missing build");
  });

  it("workspace 越しの build output leaf が directory なら launch が黙って成功しない (ふじ round4 must-fix 1)", () => {
    // ふじ round4 must-fix 1 のもう一方: wrapper 側 (node_modules/@kaoiro/
    // <pkg>/dist/cli.js) が directory でも、runner 自身の dist/cli.js は
    // 健全なままなので launch 自体は起動シーケンスを最後まで完走してしまう
    // (wrapper の cli.js はセッション spawn 時にしか実行されないため)。
    // 実測(修正前の HEAD 3666b5e に対して自分で再現): このケースは exit 0
    // で "stub cli.js started" まで出力していた — 起動検証が本来検出
    // すべき壊れた engine を見逃していた。
    const leaf = join(runner, "node_modules", "@kaoiro", "claude-code", "dist", "cli.js");
    rmSync(leaf, { force: true });
    mkdirSync(leaf);

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
    expect(result.stderr).toContain("is not an ordinary file");
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
    expect(result.stderr).toContain("NOT a missing build");
  });

  it("workspace 越しの build output leaf が symlink-to-directory でも同様に見逃されない (ふじ round4 must-fix 1)", () => {
    // 上のテストの symlink 版。leaf 自体は「dangling symlink」ではなく
    // 「healthy に resolve するが、resolve 先が directory」なので、round4
    // で追加済みの dangling-leaf 判定 (lstatType による ENOENT 事前捕捉)
    // では捕まらない — 別経路の同クラス欠陥であることの pin。
    const leaf = join(runner, "node_modules", "@kaoiro", "claude-code", "dist", "cli.js");
    const leafDir = join(runner, "node_modules", "@kaoiro", "claude-code", "dist");
    rmSync(leaf, { force: true });
    symlinkSync(".", leaf); // resolves to leafDir itself — a directory

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
    expect(result.stderr).toContain("is not an ordinary file");
    // sanity: the symlink really does resolve to the directory, not dangle.
    expect(realpathSync(leaf)).toBe(realpathSync(leafDir));
  });

  it("node_modules/@kaoiro が dangling symlink なら install shortage と誤分類されない (ふじ round4 must-fix 2)", () => {
    // ふじ round4 must-fix 2: checkWorkspaceLinkedSentinel は
    // node_modules/@kaoiro/<pkg> という3セグメントのフルパスを一度に
    // lstat していたため、途中の node_modules/@kaoiro 自体が dangling
    // symlink の場合でも lstat は ENOENT を返し(lstat は最終要素以外の
    // 中間要素を必ずたどるため)、「final link が単に missing」なケース
    // と区別できず install shortage (exit 72) に誤分類していた。
    // 実測(ふじ、issue コメント3332): 案内どおり pnpm install を実行
    // しても exit 254 で失敗し、dangling symlink はそのまま残ったまま
    // 再度 shim を起動すると再び exit 78 になる — 提案された remedy は
    // tree を修復しなかった。自分でも再現した: 修正前の HEAD 3666b5e に
    // 対してこのケースを起こすと exit 72 相当のメッセージ
    // (「workspace dependency link... pnpm install」) が出ていた。
    const scopeDir = join(runner, "node_modules", "@kaoiro");
    rmSync(scopeDir, { recursive: true, force: true });
    symlinkSync("missing-target-anywhere", scopeDir);

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
    // ふじ round5 の matrix (issue #259) 発見: workspace 祖先の symlink は
    // dist container と違い RESOLVE される(健全な in-bound symlink は
    // ok — 別テスト参照)。dangling はその resolve 自体が失敗するので、
    // メッセージは「型が違う」ではなく「到達不能」になる。
    expect(result.stderr).toContain("is unreachable");
    // install は正しい remedy ではない (dangling symlink はそのまま残る
    // ため) -- 提案してはならない。
    expect(result.stderr).not.toContain("pnpm install");
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
    expect(result.stderr).toContain("NOT a missing build");
  });

  it("node_modules 自体が dangling symlink でも同様に誤分類されない (ふじ round4 must-fix 2、より浅い祖先)", () => {
    // 上のテストより一段浅い祖先 (node_modules 自体) が dangling symlink
    // のケース。walkAncestors は node_modules と node_modules/@kaoiro の
    // 両方を個別に検査するため、どちらの深さで壊れていても同じ扱いになる
    // ことの pin。
    const nmDir = join(runner, "node_modules");
    rmSync(nmDir, { recursive: true, force: true });
    symlinkSync("missing-target-anywhere", nmDir);

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
    expect(result.stderr).toContain("is unreachable");
    expect(result.stderr).not.toContain("pnpm install");
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
  });

  it("workspace ancestor (node_modules/@kaoiro) が release 内を指す健全な symlink なら通常どおり起動する (ふじ round5 matrix、positive control)", () => {
    // ふじ round5 の matrix (issue #259) が発見した回帰: 上の dangling
    // ケース向けに追加した walkAncestors の祖先チェックが、最初の実装で
    // ANY symlink (健全含む) を無条件拒否していたため、この健全なケース
    // まで exit 78 に倒していた。dist などの build-output container とは
    // 異なり、node_modules/@kaoiro のような workspace 祖先は正当に
    // symlink でありうる — 実際に resolve して containment + directory
    // 判定に通せば起動できることの pin。
    const scopeDir = join(runner, "node_modules", "@kaoiro");
    const scopeReal = join(runner, "node_modules", "@kaoiro-real");
    renameSync(scopeDir, scopeReal);
    symlinkSync("@kaoiro-real", scopeDir);

    const result = launch();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stub cli.js started");
  });

  it("workspace ancestor が release 外を指す symlink なら resolve できても拒否される", () => {
    // resolveSymlinks=true の分岐に新設した containment check 自体の pin
    // (ふじの30セルmatrixには「祖先が release 外を指す」ケースは無かった
    // — walkAncestors の新分岐で resolve までは成功するが、release の
    // 外という別の理由で拒否される経路に、専用テストが無いままだった)。
    const outside = join(dir, "outside-kaoiro-scope");
    renameSync(join(runner, "node_modules", "@kaoiro"), outside);
    symlinkSync(outside, join(runner, "node_modules", "@kaoiro"));

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
    expect(result.stderr).toContain("resolves outside the release");
    expect(result.stderr).not.toContain("pnpm install");
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
  });

  it("workspace ancestor が release 内の plain file を指す symlink なら拒否される", () => {
    // 同じく resolveSymlinks=true の分岐に新設した isDirectory check 自体
    // の pin。祖先 symlink は resolve でき、containment も通るが、解決先
    // が directory ではない(plain file)ケース。
    const target = join(ws, "not-a-directory");
    writeFileSync(target, "");
    const scopeDir = join(runner, "node_modules", "@kaoiro");
    rmSync(scopeDir, { recursive: true, force: true });
    symlinkSync(target, scopeDir);

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
    expect(result.stderr).toContain("is not an ordinary directory");
    expect(result.stderr).not.toContain("pnpm install");
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
  });

  it("workspace link が plain file なら未捕捉例外にならず分類される (内部レビュー指摘)", () => {
    // 内部review (redesign後の round1 assessment) must-fix:
    // checkWorkspaceLinkedSentinel は lstatType(linkPath)==="missing" しか
    // 見ておらず、node_modules/@kaoiro/<pkg> が symlink でも directory
    // でもない plain file の場合、realpathSync はファイルに対しても素直に
    // 成功するため missing-link 判定も containment 判定もすり抜け、
    // checkBuildOutputLeaf(linkReal, ...) に処理が渡る。そこで
    // lstatType がファイルの「中」(dist/) を lstat しようとして ENOTDIR
    // を投げるが、lstatType は ENOENT しか catch しないため未捕捉のまま
    // main() まで伝播し、生の Node stack trace で crash する (exit 78
    // 自体は shim の catch-all で維持されるが、診断メッセージが本来の
    // classified VerifyError ではなくなる)。実際に再現して確認した:
    // status 78 は出るが stderr に "ENOTDIR" のスタックトレースが出る。
    const link = join(runner, "node_modules", "@kaoiro", "claude-code");
    unlinkSync(link);
    writeFileSync(link, "");

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain("stub cli.js started");
    // 生の Node crash ではなく、分類された VerifyError の診断であること。
    expect(result.stderr).not.toContain("at lstatSync");
    expect(result.stderr).not.toContain("Node.js v");
    expect(result.stderr).toContain("is not a directory");
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
    expect(result.stderr).not.toContain("pnpm install");
  });

  it("intact topology + leaf 欠落のみ (真の build shortage) は、build 完了後に verifier を通す (positive control)", () => {
    // ふじ round3: 「exit 71 の positive case は、案内した build を実行
    // した後に verifier が通ることまで負の control としてください」。
    // 実際に pnpm build を fixture 上で走らせることはできない(stub の
    // ため実ソースが無い)ので、build が成功裏に生成するはずの状態
    // (leaf ファイルの復元) を直接再現し、その後 verifier が通ることを
    // 確認する — 「build shortage の分類が正しい」ことの反対側、
    // 「remedy を適用すれば実際に直る」ことを pin する。
    const leaf = join(runner, "node_modules", "@kaoiro", "claude-code", "dist", "cli.js");
    const original = readFileSync(leaf, "utf8");
    unlinkSync(leaf);

    const before = launch();
    expect(before.status).toBe(78);
    expect(before.stderr).toContain("a build artifact is missing");
    expect(before.stderr).toContain("pnpm -C wrapper build && pnpm -C runner build");

    // build が正常完了した状態を直接再現する。
    writeFileSync(leaf, original);

    const after = launch();
    expect(after.status).toBe(0);
    expect(after.stdout).toContain("stub cli.js started");
  });

  it("生成した fixture のリンクは実チェックアウトの premise と結線されている (fixture-premise wiring)", () => {
    // ふじ review must-fix 2: writeWorkspaceCheckout の symlink target と
    // このファイル自身の linkTarget 前提チェックは、互いに独立した
    // ハードコード文字列でしかなく、GENERATED な fixture を LIVE な
    // checkout と直接比較する assertion が一つも無かった。そのため
    // fixture 側を(例えば絶対 symlink へ)mutate しても、実チェックアウト
    // だけを測る premise テストは green のまま気づけなかった
    // (measured: 6/6 green のまま)。ここで両者を一つの assertion で結ぶ。
    for (const wrapper of ["claude-code", "codex"]) {
      const fixtureLink = join(runner, "node_modules", "@kaoiro", wrapper);
      const liveLink = join(REPO_ROOT, "runner", "node_modules", "@kaoiro", wrapper);
      expect(lstatSync(fixtureLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(fixtureLink)).toBe(readlinkSync(liveLink));
    }
  });

  it("workspace marker が無ければ release root 境界へ戻る", () => {
    // The wider boundary is bought by the marker and by nothing else. Without
    // one, the tree is its own boundary again — the stricter of the two — so
    // this same link topology is rejected. A boundary that widened
    // unconditionally (root's parent, say) would start here.
    unlinkSync(join(ws, "pnpm-workspace.yaml"));

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("resolves outside the release");
    expect(result.stdout).not.toContain("stub cli.js started");
    // issue #259: same failure class as the previous test — not build-fixable.
    expect(result.stderr).not.toContain("pnpm -C wrapper build");
  });

  it("実チェックアウトのリンクは runner/ の外・workspace の内を指す (前提の pin)", () => {
    // THE PREMISE, TAKEN FROM pnpm RATHER THAN RESTATED. Everything above is
    // still a fixture; this is the assertion that fails if pnpm ever stops
    // linking workspace members out of the dependent, which would make the
    // fixture describe a layout that no longer exists.
    const link = join(REPO_ROOT, "runner", "node_modules", "@kaoiro", "claude-code");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(linkTarget("claude-code"));
    const real = realpathSync(link);
    expect(relative(realpathSync(join(REPO_ROOT, "runner")), real)).toMatch(/^\.\./);
    expect(relative(realpathSync(REPO_ROOT), real)).not.toMatch(/^\.\./);
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("実チェックアウトで最近傍の workspace marker は repo root である (前提の pin)", () => {
    // A MARKER IS NOT THE MARKER. workspaceRootOf stops at the FIRST one it
    // meets walking up, and this repo already carries a nested one —
    // dashboard/pnpm-workspace.yaml, an independent build root. One appearing
    // at runner/ or anywhere between would collapse the boundary back to
    // runner/ and return the service to exit 78, while every assertion in the
    // test above stayed green: the link topology would be unchanged.
    const repoReal = realpathSync(REPO_ROOT);

    for (
      let cur = realpathSync(join(REPO_ROOT, "runner"));
      cur !== repoReal;
      cur = dirname(cur)
    ) {
      // Walking past the filesystem root instead of reaching the repo root
      // means the premise itself is gone; fail loudly rather than spin.
      expect(cur).not.toBe(dirname(cur));
      expect(existsSync(join(cur, "pnpm-workspace.yaml"))).toBe(false);
    }
  });

  it("marker が symlink なら workspace とみなさない", () => {
    // The marker is trusted to say "a checkout starts here" and nothing else
    // (verify-release.mjs states the residual). A symlink standing in for it
    // is the one shape that costs nothing to refuse, so it is refused — and
    // the boundary falls back to the release root, which rejects this tree.
    const real = join(dir, "elsewhere", "pnpm-workspace.yaml");
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, "packages:\n  - runner\n");
    unlinkSync(join(ws, "pnpm-workspace.yaml"));
    symlinkSync(real, join(ws, "pnpm-workspace.yaml"));

    const result = launch();

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("resolves outside the release");
  });
});
