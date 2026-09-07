import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { DEFAULT_CONFIG } from "../kaoiro-deploy-config.mjs";
import { readJournal } from "../kaoiro-deploy-journal.mjs";
import { LockError } from "../kaoiro-deploy-lock.mjs";
import { readManifest } from "../kaoiro-deploy-manifest.mjs";
import { PHASE, TRANSITIONS } from "../kaoiro-deploy-phase.mjs";
import {
  DeployError,
  deploymentLockKey,
  hasPriorTransactions,
  OLD_IMAGE_BUILD_INFO_PATH,
  parseArgs,
  parseTarEntries,
  pruneOldTransactions,
  reachablePhases,
  resolveHealthUrl,
  runBuild,
  requiredEntriesMatch,
  ROLLBACK_ELIGIBLE_PHASES,
  runRollback,
  runStart,
  runStatus,
  runUpdate,
  UNRESUMABLE_PHASES,
  VOLUME_LISTING_SCRIPT,
} from "../kaoiro-server-deploy.mjs";

// A single fake docker covering every branch runBuild/runStart/runUpdate
// exercise: `compose build` / `compose stop` / `compose up -d --build` /
// `tag` / `pull` / `start` all succeed silently; `inspect ... --format
// {{.Id}}` and `{{.Image}}` return fixed fake ids; `compose ps -a` /
// `inspect ... --format {{.State.Status}}` / clean-stop fields / the
// mount lookup are driven by FAKE_DOCKER_SCENARIO the same way
// test/branch.test.mjs's fake does. FAKE_DOCKER_SCENARIO
// "running-clean-stop" additionally reports a clean stop (exit 0, not
// OOM-killed) and a resolvable mount, for the tests that exercise
// runUpdate all the way through ARCHIVED.
//
// OLD_IMAGE_ID must be IMAGE_ID_RE-valid (クロエ round 1 review SF-1) —
// all-hex, unlike the old "sha256:oldimageid" fixture.
const OLD_IMAGE_ID = `sha256:${"0".repeat(64)}`;
const FAKE_DOCKER = `#!/bin/sh
if [ -n "$KAOIRO_TEST_CALL_LOG" ]; then printf '%s\\n' "$*" >> "$KAOIRO_TEST_CALL_LOG"; fi
case "$1" in
  compose)
    shift
    compose_file=""
    while [ "$1" = "-f" ] || [ "$1" = "--project-directory" ]; do
      if [ "$1" = "-f" ]; then compose_file="$2"; fi
      shift 2
    done
    case "$1" in
      ps)
        if [ "$2" = "-a" ] && [ "$3" = "-q" ]; then
          case "$FAKE_DOCKER_SCENARIO" in
            up-fails-no-container) ;;
            multiple-containers) printf 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\\nsha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\\n' ;;
            rollback-id-mismatch)
              if [ -n "$compose_file" ]; then
                printf 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\\n'
              else
                printf 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\\n'
              fi
              ;;
            *) printf 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\\n' ;;
          esac
          exit 0
        fi
        if [ "$2" = "-q" ]; then
          if [ -f "$KAOIRO_TEST_STOP_FILE" ]; then
            case "$FAKE_DOCKER_SCENARIO" in
              rollback-running-reappears) printf 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\\n' ;;
            esac
            exit 0
          fi
          case "$FAKE_DOCKER_SCENARIO" in
            stopped) ;;
            multiple-containers) printf 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\\nsha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\\n' ;;
            target-id-mismatch|rollback-id-mismatch) printf 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\\n' ;;
            *) printf 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\\n' ;;
          esac
          exit 0
        fi
        case "$FAKE_DOCKER_SCENARIO" in
          stopped|running|retag-drift|running-clean-stop|running-clean-stop-retag-drift|running-clean-stop-restarts|running-clean-stop-restartcount-unreadable|running-clean-stop-torture|running-dirty-stop|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-tag-drift|running-archive-drifts-empty|compose-config-renamed-service|compose-config-missing-environment-key|mount-vanishes-after-stop|system-df-fails|system-df-invalid-json|system-df-not-array|target-id-mismatch|target-remains-running|rollback-target-remains-running|rollback-id-mismatch|up-fails-container|up-fails-no-container|rollback-running-reappears)
            printf 'kaoiro-c1\\n' ;;
          # round 4 review B-1 (expanded): rollback's own "2+ containers,
          # refuse" guard, distinct from requireRunningContainer's own
          # (unrelated) "!= 1" check.
          multiple-containers) printf 'kaoiro-c1\\nkaoiro-c2\\n' ;;
        esac
        ;;
      build) exit 0 ;;
      up)
        case "$FAKE_DOCKER_SCENARIO" in
          up-fails-container|up-fails-no-container)
            if [ ! -f "$KAOIRO_TEST_UP_FAILURE_FILE" ]; then
              : > "$KAOIRO_TEST_UP_FAILURE_FILE"
              exit 1
            fi
            ;;
        esac
        rm -f "$KAOIRO_TEST_STOP_FILE"
        exit 0
        ;;
      stop)
        : > "$KAOIRO_TEST_STOP_FILE"
        exit 0
        ;;
      # director ruling 2026-09-06 (#306 (c3) review): resolveHealthUrl's
      # own source of truth when config.health_url is not overridden.
      # Unhandled scenarios fall through with empty output (no explicit
      # case, sh's own default) — that IS the "no output" failure case
      # resolveHealthUrl's own test relies on, not a gap to fill in.
      port)
        case "$FAKE_DOCKER_SCENARIO" in
          health-url-derivable) printf '127.0.0.1:9999\\n' ;;
          health-url-port-fails) exit 1 ;;
          # クロエ round 3 review N-1: real \`docker compose port\` reports
          # an IPv6 wildcard binding unbracketed.
          health-url-ipv6) printf ':::4000\\n' ;;
        esac
        ;;
      # issue #220 absorption: compose's own RESOLVED declaration for the
      # service, keyed by env var name — measured live to be a plain
      # object map under \`--format json\` (Compose v5.3.1). Overridable
      # per-test via KAOIRO_TEST_COMPOSE_ENV_JSON; by default it declares
      # the one store the default eval output below reports, at the same
      # path the container default carries, so scenarios that do not care
      # about env consistency see zero disagreement.
      #
      # The volumes shape (round 4 review N-3) is also measured live
      # (Compose v5.3.1): services.<name>.volumes[] names the mount
      # (type/source/target), and the top-level volumes.<source>.name
      # gives the FULLY-RESOLVED docker volume name — "kaoiro_kaoiro-state"
      # here, matching this fixture's own service name.
      config)
        case "$FAKE_DOCKER_SCENARIO" in
          # issue #322 M3: rollback's pre-destructive recovery-pair check
          # also confirms \`docker compose config\` itself renders (a
          # syntax/reference error in docker-compose.yaml, distinct from
          # M2's own sha256-drift check above it — this exercises a
          # compose file that fails to PARSE at all, not one that merely
          # changed).
          rollback-compose-config-broken)
            echo 'Error: services.kaoiro.image is required' >&2
            exit 1
            ;;
          # クロエ round 5 review SF-7: composeDeclaredEnv's own shape
          # guard, pinned via a compose config response naming a DIFFERENT
          # service ("kaoiro" is not present at all) and one whose service
          # exists but has no "environment" key at all (neither \`{}\` nor
          # \`null\` — genuinely absent).
          compose-config-renamed-service)
            printf '{"name":"kaoiro","services":{"other-service":{"environment":{},"volumes":[{"type":"volume","source":"kaoiro-state","target":"/var/lib/kaoiro","volume":{}}]}},"volumes":{"kaoiro-state":{"name":"kaoiro_kaoiro-state"}}}\\n'
            ;;
          compose-config-missing-environment-key)
            printf '{"name":"kaoiro","services":{"kaoiro":{"volumes":[{"type":"volume","source":"kaoiro-state","target":"/var/lib/kaoiro","volume":{}}]}},"volumes":{"kaoiro-state":{"name":"kaoiro_kaoiro-state"}}}\\n'
            ;;
          *)
            if [ -n "$compose_file" ] && [ -n "$KAOIRO_TEST_RECOVERY_COMPOSE_CONFIG_JSON" ]; then
              printf '%s\\n' "$KAOIRO_TEST_RECOVERY_COMPOSE_CONFIG_JSON"
            elif [ -z "$compose_file" ] && [ -n "$KAOIRO_TEST_COMPOSE_CONFIG_JSON" ]; then
              printf '%s\\n' "$KAOIRO_TEST_COMPOSE_CONFIG_JSON"
            elif [ -z "$compose_file" ] && grep -q 'legitimate target compose change' docker-compose.yaml; then
              printf '{"name":"kaoiro","services":{"kaoiro":{"image":"target-compose","environment":{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"},"volumes":[{"type":"volume","source":"kaoiro-state","target":"/var/lib/kaoiro","volume":{}}]}},"volumes":{"kaoiro-state":{"name":"kaoiro_kaoiro-state"}}}\\n'
            elif [ -n "$KAOIRO_TEST_COMPOSE_ENV_JSON" ]; then
              env_json="$KAOIRO_TEST_COMPOSE_ENV_JSON"
              printf '{"name":"kaoiro","services":{"kaoiro":{"environment":%s,"volumes":[{"type":"volume","source":"kaoiro-state","target":"/var/lib/kaoiro","volume":{}}]}},"volumes":{"kaoiro-state":{"name":"kaoiro_kaoiro-state"}}}\\n' "$env_json"
            else
              env_json='{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}'
              printf '{"name":"kaoiro","services":{"kaoiro":{"environment":%s,"volumes":[{"type":"volume","source":"kaoiro-state","target":"/var/lib/kaoiro","volume":{}}]}},"volumes":{"kaoiro-state":{"name":"kaoiro_kaoiro-state"}}}\\n' "$env_json"
            fi
            ;;
        esac
        ;;
    esac
    ;;
  # クロエ round 4 review N-3: hasPriorTransactions' own docker-
  # reachability probe (\`docker version --format {{.Server.Version}}\`,
  # measured live to fail when the daemon is unreachable). Always
  # succeeds except for the one scenario that specifically wants to
  # exercise classify()'s own unknown-hasState branch END TO END (\`compose
  # ps\` still answers normally — this simulates JUST the volume-existence
  # check being unreachable, not total docker failure, which a SEPARATE
  # dedicated broken-docker fixture already covers for requireRunningContainer
  # itself).
  version)
    case "$FAKE_DOCKER_SCENARIO" in
      docker-unreachable-for-state-check) exit 1 ;;
      *) exit 0 ;;
    esac
    ;;
  # クロエ round 4 review N-3: existence-only, matching \`docker volume
  # inspect\` (measured live: exit 0 for an existing volume, 1 for a
  # missing one). Defaults to "does not exist" — most branch-C/FRESH
  # fixtures in this file assume a genuinely empty deployment; the one
  # scenario that needs the OPPOSITE (a volume surviving after its
  # container disappeared) opts in explicitly.
  volume)
    case "$2" in
      inspect)
        case "$FAKE_DOCKER_SCENARIO" in
          volume-exists-no-container) exit 0 ;;
          *) exit 1 ;;
        esac
        ;;
    esac
    ;;
  tag)
    # issue #322 M2: kaoiro-server:latest is a MUTABLE tag both runUpdate's
    # own commit retag and runRollback's own restore retag point at — a
    # fixed canned inspect response could not reflect whichever of the two
    # actually ran last. Recording what was last tagged onto it (read back
    # by the inspect case below) is what lets EITHER caller's own
    # tag-then-inspect verify see reality, the way a real docker
    # tag/inspect roundtrip would.
    if [ "$3" = "kaoiro-server:latest" ]; then
      printf '%s' "$2" > "$KAOIRO_TEST_LATEST_TAG_FILE"
    fi
    exit 0
    ;;
  pull) exit 0 ;;
  rmi) exit 0 ;;
  stop)
    : > "$KAOIRO_TEST_STOP_FILE"
    exit 0
    ;;
  inspect)
    case "$2" in
      # Preflight image check (N-5): the missing-alpine scenario is the
      # ONLY one where this fails, forcing ensureAlpineImage's pull.
      alpine:3)
        case "$FAKE_DOCKER_SCENARIO" in
          alpine-missing) exit 1 ;;
          *) printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;
        esac
        ;;
      # issue #322 M3: rollback's pre-destructive recovery-pair check
      # inspects the OLD image (by bare id, before ever tagging or
      # touching it) to confirm it still exists. rollback-missing-old-image
      # is the ONLY scenario where this fails — every other scenario falls
      # through to whatever the fallback \`*)\` branch below would have
      # answered anyway (this id is never used as a container/other-tag
      # target in this fixture, so only \`--format {{.Id}}\` ever reaches it).
      ${OLD_IMAGE_ID})
        case "$FAKE_DOCKER_SCENARIO" in
          rollback-missing-old-image)
            echo 'Error: No such image: ${OLD_IMAGE_ID}' >&2
            exit 1
            ;;
          *) printf 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\\n' ;;
        esac
        ;;
      # Rollback-tag verify-by-inspect (MF-2): echoes back the SAME id
      # \`{{.Image}}\` reports below, so every scenario that reaches the
      # tag step passes its own read-back check — except
      # running-tag-drift, which deliberately answers with a DIFFERENT
      # id, simulating \`docker tag\` having silently pointed the tag
      # somewhere other than what was asked (or \`latest\` having moved
      # under it between the tag and the verify).
      kaoiro-server:rollback-*)
        case "$FAKE_DOCKER_SCENARIO" in
          running-tag-drift) printf 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n' ;;
          *) printf '${OLD_IMAGE_ID}\\n' ;;
        esac
        ;;
      # issue #220 absorption: the abort-cleanup retag-back read-back
      # (env_consistency mismatch) — echoes OLD_IMAGE_ID, matching the
      # \`tag\` command's own always-succeeds fake so the read-back check
      # passes. round 4 review B-1 (expanded): rollback's OWN retag
      # read-back needs the SAME pin on a genuine drift (\`docker tag\`
      # having silently pointed \`latest\` somewhere other than what was
      # asked, or \`latest\` moving under it between the tag and the
      # verify) — the same class MF-2/rollback-tag-drift already covers
      # for update's own rollback tag.
      kaoiro-server:latest)
        case "$FAKE_DOCKER_SCENARIO" in
          # running-clean-stop-retag-drift (issue #322 M2): the SAME
          # simulated drift as retag-drift, but with a clean stop reported
          # too — retag-drift alone is reached before the stop window
          # (env_consistency's own abort-retag), so it never sets a clean
          # stop expectation; commit's OWN post-stop retag needs one to
          # get there at all.
          retag-drift|running-clean-stop-retag-drift) printf 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\\n' ;;
          # issue #322 M2: reflects whatever the tag case above last wrote
          # (real docker's own tag/inspect roundtrip), falling back to
          # OLD_IMAGE_ID only if nothing has tagged :latest yet this run —
          # the same default every EXISTING test that never calls tag
          # before inspecting :latest already relied on.
          *)
            if [ -f "$KAOIRO_TEST_LATEST_TAG_FILE" ]; then
              printf '%s\\n' "$(cat "$KAOIRO_TEST_LATEST_TAG_FILE")"
            else
              printf '${OLD_IMAGE_ID}\\n'
            fi
            ;;
        esac
        ;;
      *)
        case "$4" in
          '{{.State.Status}}')
            case "$FAKE_DOCKER_SCENARIO" in
              target-remains-running|rollback-target-remains-running) printf 'running\\n'; exit 0 ;;
            esac
            if [ -f "$KAOIRO_TEST_STOP_FILE" ]; then printf 'exited\\n'; exit 0; fi
            case "$FAKE_DOCKER_SCENARIO" in
              stopped) printf 'exited\\n' ;;
              running|retag-drift|running-clean-stop|running-clean-stop-retag-drift|running-clean-stop-restarts|running-clean-stop-restartcount-unreadable|running-clean-stop-torture|running-dirty-stop|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-tag-drift|running-archive-drifts-empty|compose-config-renamed-service|compose-config-missing-environment-key|mount-vanishes-after-stop|system-df-fails|system-df-invalid-json|system-df-not-array|target-id-mismatch|target-remains-running|rollback-target-remains-running|rollback-id-mismatch|up-fails-container|up-fails-no-container|rollback-running-reappears)
                printf 'running\\n' ;;
            esac
            ;;
          '{{.State.Running}}')
            case "$FAKE_DOCKER_SCENARIO" in
              target-remains-running|rollback-target-remains-running) printf 'true\\n' ;;
              *) if [ -f "$KAOIRO_TEST_STOP_FILE" ]; then printf 'false\\n'; else printf 'true\\n'; fi ;;
            esac
            ;;
          '{{.State.ExitCode}}')
            case "$FAKE_DOCKER_SCENARIO" in
              running-clean-stop|running-clean-stop-retag-drift|running-clean-stop-restarts|running-clean-stop-restartcount-unreadable|running-clean-stop-torture|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-archive-drifts-empty|mount-vanishes-after-stop|up-fails-container|up-fails-no-container) printf '0\\n' ;;
              running-dirty-stop) printf '137\\n' ;;
              *) printf 'unknown\\n' ;;
            esac
            ;;
          '{{.State.OOMKilled}}')
            case "$FAKE_DOCKER_SCENARIO" in
              running-clean-stop|running-clean-stop-retag-drift|running-clean-stop-restarts|running-clean-stop-restartcount-unreadable|running-clean-stop-torture|running-no-mount|running-empty-vol|running-broken-archive|alpine-missing|running-archive-drifts-empty|mount-vanishes-after-stop|up-fails-container|up-fails-no-container) printf 'false\\n' ;;
              running-dirty-stop) printf 'true\\n' ;;
              *) printf 'unknown\\n' ;;
            esac
            ;;
          '{{range .Mounts}}{{if eq .Destination "/var/lib/kaoiro"}}{{.Name}}{{end}}{{end}}')
            # #303 capacity preflight: this SAME inspect now also runs
            # PRE-stop (checkCapacity), so every scenario that reaches
            # requireRunningContainer needs a real answer here, not just
            # the scenarios that used to reach POST-stop MOUNT_RESOLVED.
            # Defaulting to the standard mount keeps every scenario that
            # does not care about mount resolution unaffected;
            # running-no-mount is the one deliberate exception (a
            # container genuinely never carrying this mount).
            case "$FAKE_DOCKER_SCENARIO" in
              running-no-mount) ;;
              mount-vanishes-after-stop)
                count=0
                [ -f "$KAOIRO_TEST_MOUNT_CALL_COUNTER" ] && count=$(cat "$KAOIRO_TEST_MOUNT_CALL_COUNTER")
                echo $((count + 1)) > "$KAOIRO_TEST_MOUNT_CALL_COUNTER"
                if [ "$count" -eq 0 ]; then printf 'kaoiro_kaoiro-state\\n'; fi
                ;;
              *) printf 'kaoiro_kaoiro-state\\n' ;;
            esac
            ;;
          '{{.RestartCount}}')
            case "$FAKE_DOCKER_SCENARIO" in
              # Increments on every read: 0 the first time (right after
              # HEALTHY), 1 the second (after the stability window) —
              # pins the "restarted during the stability window" failure.
              running-clean-stop-restarts)
                count=0
                [ -f "$KAOIRO_TEST_RESTART_COUNTER" ] && count=$(cat "$KAOIRO_TEST_RESTART_COUNTER")
                echo $((count + 1)) > "$KAOIRO_TEST_RESTART_COUNTER"
                printf '%s\\n' "$count"
                ;;
              # クロエ round 3 review MF-3 pin: real \`docker inspect\`
              # prints the literal string "<no value>" for a template
              # field it cannot resolve — parseDockerIntField reads this
              # as null (unreadable), never 0.
              running-clean-stop-restartcount-unreadable) printf '<no value>\\n' ;;
              *) printf '0\\n' ;;
            esac
            ;;
          '{{.Image}}') printf '${OLD_IMAGE_ID}\\n' ;;
          # issue #220 absorption: the OLD (currently running) container's
          # actual effective env, Docker's own \`"KEY=VALUE"\` array shape.
          # Overridable via KAOIRO_TEST_CONTAINER_ENV_JSON; by default it
          # agrees with compose's own default (see the \`compose config\`
          # fake's own comment).
          '{{json .Config.Env}}')
            if [ -n "$KAOIRO_TEST_CONTAINER_ENV_JSON" ]; then
              printf '%s\\n' "$KAOIRO_TEST_CONTAINER_ENV_JSON"
            else
              printf '["KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets"]\\n'
            fi
            ;;
          *) printf 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\\n' ;;
        esac
        ;;
    esac
    ;;
  run)
    case "$*" in
      *"tar czf"*)
        # Real archive step: write an actual tar.gz (with the same
        # owner/mode metadata a real \`stat\` would report, via GNU tar's
        # --owner/--group/--mode overrides — no root needed) at the host
        # path the -v ...:/backup mapping names, so the CLI's own
        # host-side \`tar tvzf\` verification has something real to
        # parse — a fake stdout string would not survive that.
        #
        # outfile is read from the actual \`/backup/<name>\` argument
        # (issue #306 (d)-B: rollback's own forensic/restore-verify
        # archives use different names than update's \`archive.tar.gz\`
        # within the SAME transaction dir, so a hardcoded name here would
        # make one call silently overwrite another's output).
        prev=""
        hostdir=""
        outfile="archive.tar.gz"
        for arg in "$@"; do
          case "$prev" in
            -v)
              case "$arg" in
                *:/backup) hostdir=\${arg%:/backup} ;;
              esac
              ;;
          esac
          case "$arg" in
            /backup/*) outfile=\${arg#/backup/} ;;
          esac
          prev=$arg
        done
        if [ -n "$hostdir" ]; then
          case "$FAKE_DOCKER_SCENARIO" in
            running-broken-archive) printf 'not a real gzip stream' > "$hostdir/$outfile" ;;
            # round 4 review B-1 (expanded): rollback's OWN forensic-
            # archive verification guard, pinned by making JUST that
            # archive corrupt — the pre-deploy archive.tar.gz created
            # during an EARLIER runUpdate call (a different scenario,
            # a different outfile name) is unaffected.
            rollback-forensic-corrupt)
              if [ "$outfile" = "rollback-forensic.tar.gz" ]; then
                printf 'not a real gzip stream' > "$hostdir/$outfile"
              else
                mkdir -p "$hostdir/.fakesrc"
                printf 'x' > "$hostdir/.fakesrc/users.dets"
                tar --owner=1000 --group=1000 --mode=600 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc" .
              fi
              ;;
            # round 4 review B-1 (expanded): rollback's OWN restored-
            # volume-vs-required_entries guard, exercised end to end (not
            # just requiredEntriesMatch's own unit tests) by making the
            # restore-verify re-tar contain a DIFFERENT file than the
            # pre-deploy archive's own (unaffected) content.
            rollback-restore-drifts)
              if [ "$outfile" = "rollback-restore-verify.tar.gz" ]; then
                mkdir -p "$hostdir/.fakesrc-drift"
                printf 'x' > "$hostdir/.fakesrc-drift/unexpected.dets"
                tar --owner=1000 --group=1000 --mode=600 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc-drift" .
              else
                mkdir -p "$hostdir/.fakesrc"
                printf 'x' > "$hostdir/.fakesrc/users.dets"
                tar --owner=1000 --group=1000 --mode=600 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc" .
              fi
              ;;
            # SF-5's post-archive empty check pin: the PRE-archive guard
            # (below) reports non-empty, but the archive that actually
            # gets written is empty — the one disagreement a stale/wrong
            # pre-scan (not merely a hypothetical) would produce.
            running-archive-drifts-empty)
              mkdir -p "$hostdir/.fakesrc-empty"
              tar --owner=0 --group=0 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc-empty" .
              ;;
            # クロエ round 2 review SF-8 pin: a real archive containing a
            # symlink and a hardlink alongside a plain file, so
            # parseTarEntries sees actual "-> target" / "link to target"
            # suffixed lines, not a hand-written fixture standing in for
            # tar's own output shape.
            running-clean-stop-torture)
              mkdir -p "$hostdir/.fakesrc-torture"
              printf x > "$hostdir/.fakesrc-torture/real.txt"
              # Mode pinned explicitly (not left to the shell's umask):
              # \`printf > file\` mode depends on the process umask, which
              # differs between a dev host (often 0002 -> 0664) and CI's
              # node:22 container (0022 -> 0644) — PR #312 round-3 run,
              # 2026-09-06. The hardlink below shares this inode, so both
              # real.txt and hard.txt land on the 0664 the test asserts.
              chmod 664 "$hostdir/.fakesrc-torture/real.txt"
              ln -s real.txt "$hostdir/.fakesrc-torture/sym.txt"
              ln "$hostdir/.fakesrc-torture/real.txt" "$hostdir/.fakesrc-torture/hard.txt"
              tar --owner=1000 --group=1000 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc-torture" .
              ;;
            *)
              mkdir -p "$hostdir/.fakesrc"
              printf 'x' > "$hostdir/.fakesrc/users.dets"
              tar --owner=1000 --group=1000 --mode=600 -czf "$hostdir/$outfile" -C "$hostdir/.fakesrc" .
              ;;
          esac
        fi
        exit 0
        ;;
      *"${OLD_IMAGE_BUILD_INFO_PATH}"*)
        case "$*" in
          *"${OLD_IMAGE_ID}"*)
            if [ "$KAOIRO_TEST_OLD_BUILD_INFO" = "__missing__" ]; then
              echo "cat: ${OLD_IMAGE_BUILD_INFO_PATH}: No such file or directory" >&2
              exit 1
            fi
            if [ -n "$KAOIRO_TEST_OLD_BUILD_INFO" ]; then
              printf '%s\\n' "$KAOIRO_TEST_OLD_BUILD_INFO"
            else
              printf '{"revision":"%s"}\\n' "$KAOIRO_TEST_OLD_IMAGE_REVISION"
            fi
            ;;
          *) exit 1 ;;
        esac
        ;;
      # issue #322 M5: the module-presence PROBE (ls the beam file via
      # /bin/sh, entirely separate from the eval call below) — matched on
      # the beam glob's own filename (unique to this one call in the
      # fixture). KAOIRO_TEST_BEAM_ABSENT=1 simulates a pre-#310 TARGET
      # image; KAOIRO_TEST_OLD_BEAM_ABSENT=1 simulates a pre-#310 OLD
      # image (the id this probe is called with — \${OLD_IMAGE_ID} — is
      # what tells the two apart, the same distinction the CLI's own
      # M5 fix makes by calling this probe once per image).
      # KAOIRO_TEST_BEAM_PROBE_EXIT set simulates the probe ITSELF
      # failing (image cannot start, daemon unreachable) — a hard
      # DeployError, not skipped, per M5's own fail-closed design.
      # Defaults to "present" for BOTH images, matching every EXISTING
      # test's assumption that the eval call below actually runs.
      *"PersistencePaths.beam"*)
        if [ -n "$KAOIRO_TEST_BEAM_PROBE_EXIT" ]; then
          exit "$KAOIRO_TEST_BEAM_PROBE_EXIT"
        fi
        case "$*" in
          *"${OLD_IMAGE_ID}"*)
            if [ "$KAOIRO_TEST_OLD_BEAM_ABSENT" = "1" ]; then
              printf 'absent\\n'
            else
              printf 'present\\n'
            fi
            ;;
          *)
            if [ "$KAOIRO_TEST_BEAM_ABSENT" = "1" ]; then
              printf 'absent\\n'
            else
              printf 'present\\n'
            fi
            ;;
        esac
        ;;
      # issue #220 absorption: the target image's own persistence-path
      # eval — matched on the entrypoint string alone (unique to this
      # call in the whole fixture), regardless of image id or the exact
      # eval expression content. KAOIRO_TEST_EVAL_EXIT=1 simulates the
      # eval process itself failing on an image the beam probe above
      # already reported present (issue #322 M5: a hard DeployError now,
      # never a skip — see imageHasPersistencePathsModule's own doc
      # comment for why the module's presence is no longer inferred from
      # THIS call's exit code at all). KAOIRO_TEST_EVAL_OUTPUT overrides
      # the 0-exit body for the malformed-shape tests. Defaults to ONE
      # agreeing store, matching the compose/container defaults above and
      # below, so scenarios that do not care about env consistency see
      # zero disagreement. It used to default to \`[]\`, which encoded the
      # very premise クロエ #310 round 1 S-1 rejected — an empty manifest
      # sailing through as a clean result.
      #
      # issue #322 M5 follow-up (must-2): KAOIRO_TEST_OLD_EVAL_OUTPUT lets
      # a test give the OLD image's own eval a DIFFERENT manifest than the
      # target's — the same \${OLD_IMAGE_ID} distinction the beam case
      # above already makes. Falls back to KAOIRO_TEST_EVAL_OUTPUT (then
      # the same default) when unset, so every EXISTING test — none of
      # which distinguish old from target — keeps its current behavior
      # unchanged.
      *"/app/bin/kaoiro_server"*)
        if [ "$KAOIRO_TEST_EVAL_EXIT" = "1" ]; then
          exit 1
        fi
        case "$*" in
          *"${OLD_IMAGE_ID}"*)
            if [ -n "$KAOIRO_TEST_OLD_EVAL_OUTPUT" ]; then
              printf '%s\\n' "$KAOIRO_TEST_OLD_EVAL_OUTPUT"
            elif [ -n "$KAOIRO_TEST_EVAL_OUTPUT" ]; then
              printf '%s\\n' "$KAOIRO_TEST_EVAL_OUTPUT"
            else
              printf '[{"store":"users","env":"KAOIRO_USERS_PATH","default_file":"users.dets","default_path":"/tmp/kaoiro-dets/users.dets"}]\\n'
            fi
            ;;
          *)
            if [ -n "$KAOIRO_TEST_EVAL_OUTPUT" ]; then
              printf '%s\\n' "$KAOIRO_TEST_EVAL_OUTPUT"
            else
              printf '[{"store":"users","env":"KAOIRO_USERS_PATH","default_file":"users.dets","default_path":"/tmp/kaoiro-dets/users.dets"}]\\n'
            fi
            ;;
        esac
        ;;
      *)
        # Pre-archive empty-volume guard (find -mindepth 1 -maxdepth 1
        # -exec stat -c '%n %u:%g %04a' {} \\;) — only whether anything is
        # there, not what gets recorded (that comes from tar tvzf now).
        case "$FAKE_DOCKER_SCENARIO" in
          running-clean-stop|running-clean-stop-retag-drift|running-clean-stop-restarts|running-clean-stop-restartcount-unreadable|running-clean-stop-torture|running-dirty-stop|running-broken-archive|alpine-missing|running-archive-drifts-empty|up-fails-container|up-fails-no-container) printf '/data/users.dets 1000:1000 0600\\n' ;;
          running-empty-vol) ;;
        esac
        exit 0
        ;;
    esac
    ;;
  start) exit 0 ;;
  # #303 capacity preflight (director ruling 2026-09-07): \`docker system
  # df -v\`'s own per-volume accounting, SI-formatted the way real docker
  # does (measured live, 29.6.1, 2026-09-07: "213.6kB", "1.302MB", "0B").
  # KAOIRO_TEST_VOLUME_SIZE lets a specific test control the exact Size
  # string; every other test gets a small, harmless default well under
  # any real host's free space even at the default capacity_multiplier.
  # KAOIRO_TEST_VOLUME_NAME lets a test make the entry name disagree with
  # whatever resolveKaoiroLibMount resolved, simulating "absent from its
  # own listing".
  system)
    case "$2" in
      df)
        case "$FAKE_DOCKER_SCENARIO" in
          system-df-fails) exit 1 ;;
          system-df-invalid-json) printf 'not json\\n' ;;
          system-df-not-array) printf '{"oops":"an object, not an array"}\\n' ;;
          *)
            printf '[{"Name":"%s","Size":"%s"}]\\n' \\
              "\${KAOIRO_TEST_VOLUME_NAME:-kaoiro_kaoiro-state}" "\${KAOIRO_TEST_VOLUME_SIZE:-2kB}"
            ;;
        esac
        ;;
    esac
    ;;
esac
`;

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "server", "docker-compose.yaml"), "# fixture\n");
  // Matches the real repo's own root .gitignore (`.env` is listed there).
  // Without this, a test writing server/.env (issue #220 absorption)
  // relies on the HOST's global git excludesFile to stay clean — true on
  // a dev host that already has one, false on a bare CI container, where
  // `git status --porcelain` then reports it and runBuild's dirty-tree
  // guard fires for the wrong reason (measured: PR #312 round-3 style
  // node:22 repro, 2026-09-06).
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

let root;
let sourceDir;
let bareDir;
let workDir;
let headSha;
let bin;

// Simulates `curl -sS --fail --max-time N <url>` for pollHealth: ignores
// its own args entirely and replies with the env-var-controlled
// build_revision/build_dirty, so each test decides what "the running
// server" reports without a real HTTP server. KAOIRO_TEST_HEALTH_REVISION
// unset (the "no server up yet" case) reports a value that can never
// match a real 40-hex target. KAOIRO_TEST_HEALTH_DIRTY defaults to
// "false" (director ruling 2026-09-06: healthy requires build_dirty ===
// false too, not just a matching revision). issue #322 S2:
// KAOIRO_TEST_HEALTH_CURL_FAIL simulates a genuine connection failure
// (curl's own `--fail` exit) — distinct from "reachable but reports an
// unexpected shape", which the JSON body path above already covers.
const FAKE_CURL = `#!/bin/sh
if [ -n "$KAOIRO_TEST_HEALTH_CURL_FAIL" ]; then
  echo 'curl: (7) Failed to connect' >&2
  exit 7
fi
printf '{"build_revision":"%s","build_dirty":%s}' \\
  "\${KAOIRO_TEST_HEALTH_REVISION:-no-server-yet}" "\${KAOIRO_TEST_HEALTH_DIRTY:-false}"
`;

let curlBin;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kaoiro-deploy-cli-"));
  sourceDir = join(root, "source");
  bareDir = join(root, "bare.git");
  workDir = join(root, "work");
  headSha = initRepo(sourceDir);
  execFileSync("git", ["clone", "--bare", "-q", sourceDir, bareDir]);
  execFileSync("git", ["clone", "-q", bareDir, workDir]);

  bin = join(root, "fake-docker.sh");
  writeFileSync(bin, FAKE_DOCKER);
  chmodSync(bin, 0o700);

  curlBin = join(root, "fake-curl.sh");
  writeFileSync(curlBin, FAKE_CURL);
  chmodSync(curlBin, 0o700);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// backup_root is pinned under the test's own tmpdir — leaving it null
// would make resolveBackupRoot() fall back to the real $HOME, coupling
// this test's outcome to whatever happens to exist there.
//
// This fixed override means runUpdate does not exercise compose-port
// derivation. resolveHealthUrl's five direct tests cover that source of
// truth; prepare no longer reads health at all.
function configWithOverride() {
  return {
    ...DEFAULT_CONFIG,
    allow_docker_override: true,
    backup_root: join(root, "kaoiro-deploy"),
    health_url: "http://fake-server.invalid/api/health",
  };
}

// A separate helper, not a default on configWithOverride(): most tests
// deliberately want the default null/null expectation (everything is
// abnormal), and only the tests exercising the STOPPED/MOUNT_RESOLVED
// path need a config claiming a measurement exists. Also carries FAST
// health-poll/stability settings (real defaults would make every test
// that reaches UP take up to health_poll_timeout_ms + stability_window_ms
// — up to 90 real seconds) and a health_url that is never actually
// dialed (KAOIRO_DEPLOY_CURL_BIN redirects curl itself).
function configWithCleanStopMeasured() {
  return {
    ...configWithOverride(),
    expected_clean_stop_exit_code: 0,
    expected_clean_stop_oom_killed: false,
    health_url: "http://fake-server.invalid/api/health",
    health_poll_interval_ms: 1,
    health_poll_timeout_ms: 200,
    stability_window_ms: 1,
  };
}

function withOverrideEnv(fn) {
  const priorDocker = process.env.KAOIRO_DEPLOY_DOCKER_BIN;
  const priorCurl = process.env.KAOIRO_DEPLOY_CURL_BIN;
  const priorHealthRevision = process.env.KAOIRO_TEST_HEALTH_REVISION;
  const priorLatestTagFile = process.env.KAOIRO_TEST_LATEST_TAG_FILE;
  const priorOldImageRevision = process.env.KAOIRO_TEST_OLD_IMAGE_REVISION;
  const priorRecoveryComposeConfigJson = process.env.KAOIRO_TEST_RECOVERY_COMPOSE_CONFIG_JSON;
  const priorStopFile = process.env.KAOIRO_TEST_STOP_FILE;
  process.env.KAOIRO_DEPLOY_DOCKER_BIN = bin;
  process.env.KAOIRO_DEPLOY_CURL_BIN = curlBin;
  // issue #322 M2: always set (not conditional like HEALTH_REVISION below)
  // — every test's fake `kaoiro-server:latest` tag/inspect roundtrip reads
  // and writes this same path, under this test's own `root`, so it never
  // leaks across tests.
  process.env.KAOIRO_TEST_LATEST_TAG_FILE = join(root, "latest-tag-id");
  process.env.KAOIRO_TEST_OLD_IMAGE_REVISION = headSha;
  if (process.env.KAOIRO_TEST_STOP_FILE === undefined) {
    process.env.KAOIRO_TEST_STOP_FILE = join(root, "stopped");
  }
  // Default: "the server is already running the target" — the common
  // case every test not specifically exercising a health mismatch wants.
  // Set before the call, never mutated by this helper afterward, so a
  // caller can override it (e.g. to a value that never matches) beforehand.
  if (process.env.KAOIRO_TEST_HEALTH_REVISION === undefined) {
    process.env.KAOIRO_TEST_HEALTH_REVISION = headSha;
  }
  try {
    return fn();
  } finally {
    if (priorDocker === undefined) delete process.env.KAOIRO_DEPLOY_DOCKER_BIN;
    else process.env.KAOIRO_DEPLOY_DOCKER_BIN = priorDocker;
    if (priorCurl === undefined) delete process.env.KAOIRO_DEPLOY_CURL_BIN;
    else process.env.KAOIRO_DEPLOY_CURL_BIN = priorCurl;
    if (priorHealthRevision === undefined) delete process.env.KAOIRO_TEST_HEALTH_REVISION;
    else process.env.KAOIRO_TEST_HEALTH_REVISION = priorHealthRevision;
    if (priorLatestTagFile === undefined) delete process.env.KAOIRO_TEST_LATEST_TAG_FILE;
    else process.env.KAOIRO_TEST_LATEST_TAG_FILE = priorLatestTagFile;
    if (priorOldImageRevision === undefined) delete process.env.KAOIRO_TEST_OLD_IMAGE_REVISION;
    else process.env.KAOIRO_TEST_OLD_IMAGE_REVISION = priorOldImageRevision;
    if (priorRecoveryComposeConfigJson === undefined) delete process.env.KAOIRO_TEST_RECOVERY_COMPOSE_CONFIG_JSON;
    else process.env.KAOIRO_TEST_RECOVERY_COMPOSE_CONFIG_JSON = priorRecoveryComposeConfigJson;
    if (priorStopFile === undefined) delete process.env.KAOIRO_TEST_STOP_FILE;
    else process.env.KAOIRO_TEST_STOP_FILE = priorStopFile;
  }
}

function withScenario(scenario, fn) {
  const prior = process.env.FAKE_DOCKER_SCENARIO;
  process.env.FAKE_DOCKER_SCENARIO = scenario;
  try {
    return withOverrideEnv(fn);
  } finally {
    if (prior === undefined) delete process.env.FAKE_DOCKER_SCENARIO;
    else process.env.FAKE_DOCKER_SCENARIO = prior;
  }
}

function composePlanJson(name, source = "kaoiro_kaoiro-state") {
  return JSON.stringify({
    name,
    services: {
      kaoiro: {
        environment: { KAOIRO_USERS_PATH: "/var/lib/kaoiro/users.dets" },
        volumes: [{ type: "volume", source: "kaoiro-state", target: "/var/lib/kaoiro", volume: {} }],
      },
    },
    volumes: { "kaoiro-state": { name: source } },
  });
}

function withComposePlans(recovery, target, fn) {
  const priorRecovery = process.env.KAOIRO_TEST_RECOVERY_COMPOSE_CONFIG_JSON;
  const priorTarget = process.env.KAOIRO_TEST_COMPOSE_CONFIG_JSON;
  process.env.KAOIRO_TEST_RECOVERY_COMPOSE_CONFIG_JSON = recovery;
  process.env.KAOIRO_TEST_COMPOSE_CONFIG_JSON = target;
  try {
    return fn();
  } finally {
    if (priorRecovery === undefined) delete process.env.KAOIRO_TEST_RECOVERY_COMPOSE_CONFIG_JSON;
    else process.env.KAOIRO_TEST_RECOVERY_COMPOSE_CONFIG_JSON = priorRecovery;
    if (priorTarget === undefined) delete process.env.KAOIRO_TEST_COMPOSE_CONFIG_JSON;
    else process.env.KAOIRO_TEST_COMPOSE_CONFIG_JSON = priorTarget;
  }
}

function withOldBuildInfo(value, fn) {
  const prior = process.env.KAOIRO_TEST_OLD_BUILD_INFO;
  process.env.KAOIRO_TEST_OLD_BUILD_INFO = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.KAOIRO_TEST_OLD_BUILD_INFO;
    else process.env.KAOIRO_TEST_OLD_BUILD_INFO = prior;
  }
}

// Captures every argv the fake docker was invoked with, one line each,
// for tests that need to assert on WHICH calls did (or did not) happen —
// MF-1's "records zero mutating calls" and N-5's "pulls alpine:3". `fn`
// may throw (a caller inspecting only the call log, not the outcome,
// e.g. N-5's pull check where runUpdate legitimately fails LATER for an
// unrelated reason); the exception is swallowed here on purpose.
function withCallLog(scenario, fn) {
  const logPath = join(root, "docker-calls.log");
  const prior = process.env.KAOIRO_TEST_CALL_LOG;
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  try {
    withScenario(scenario, fn);
  } catch {
    // Intentionally ignored — see doc comment.
  } finally {
    if (prior === undefined) delete process.env.KAOIRO_TEST_CALL_LOG;
    else process.env.KAOIRO_TEST_CALL_LOG = prior;
  }
  return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

// issue #220 absorption: sets/restores the four env vars FAKE_DOCKER's
// own eval/compose-config/inspect-Config.Env cases read, so a test can
// control the target image's canonical set, compose's declaration, and
// the running container's effective env independently. Undefined values
// are deleted rather than set, so a test only overriding one of the four
// leaves the others at FAKE_DOCKER's own defaults (one agreeing store).
function withEnvConsistencyFixture(
  {
    evalExit,
    evalOutput,
    oldEvalOutput,
    composeEnvJson,
    containerEnvJson,
    beamAbsent,
    oldBeamAbsent,
    beamProbeExit,
  } = {},
  fn,
) {
  const vars = {
    KAOIRO_TEST_EVAL_EXIT: evalExit,
    KAOIRO_TEST_EVAL_OUTPUT: evalOutput,
    // issue #322 M5 follow-up (must-2): independent of evalOutput above —
    // lets a test give the OLD image's own eval a manifest DIFFERENT from
    // the target's, needed to pin checkEnvConsistency's old-image
    // preference by VALUE (not merely by the assumed_default_source
    // label it also records).
    KAOIRO_TEST_OLD_EVAL_OUTPUT: oldEvalOutput,
    KAOIRO_TEST_COMPOSE_ENV_JSON: composeEnvJson,
    KAOIRO_TEST_CONTAINER_ENV_JSON: containerEnvJson,
    // issue #322 M5: separate from evalExit above — the module-presence
    // probe (a DIFFERENT docker call, see the fake script's own
    // "PersistencePaths.beam" case) defaults to reporting "present" for
    // BOTH the target and old image, so every test not specifically
    // about M5 reaches the eval call at all.
    KAOIRO_TEST_BEAM_ABSENT: beamAbsent,
    KAOIRO_TEST_OLD_BEAM_ABSENT: oldBeamAbsent,
    KAOIRO_TEST_BEAM_PROBE_EXIT: beamProbeExit,
  };
  const prior = {};
  for (const [key, value] of Object.entries(vars)) {
    prior[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// クロエ round 1 review MF-4 pin (a): runs the REAL script text (imported,
// not hand-copied — see VOLUME_LISTING_SCRIPT's own doc comment) through
// a real `sh -c`, no docker involved, against a real empty directory and
// a real 1-file directory. `/data` is substituted for the test's own tmp
// dir — the same "faithful against a real path" approach クロエ's own
// repro-b.mjs used, since a bind mount to literally `/data` needs a
// container this test does not have.
test("the volume-listing script exits 0 with empty output on an empty dir, and one line on a populated one", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-306-volume-listing-"));
  try {
    const script = VOLUME_LISTING_SCRIPT.replace("/data", dir);
    const empty = execFileSync("sh", ["-c", script], { encoding: "utf8" });
    assert.equal(empty, "");

    writeFileSync(join(dir, "users.dets"), "x");
    const populated = execFileSync("sh", ["-c", script], { encoding: "utf8" });
    const lines = populated.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith(`${dir}/users.dets `));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseArgs rejects a missing command", () => {
  assert.throws(() => parseArgs([]), DeployError);
});

test("parseArgs reads value and boolean flags", () => {
  const { command, flags } = parseArgs([
    "build",
    "--repo",
    "/tmp/x",
    "--target",
    "a".repeat(40),
    "--dry-run",
  ]);
  assert.equal(command, "build");
  assert.equal(flags.repo, "/tmp/x");
  assert.equal(flags.target, "a".repeat(40));
  assert.equal(flags.dryRun, true);
});

test("parseArgs rejects a value flag whose value looks like another flag", () => {
  assert.throws(() => parseArgs(["build", "--repo", "--target"]), DeployError);
});

test("hasPriorTransactions is true once a transaction directory exists, without ever touching docker", () => {
  // Short-circuits on the backup_root check alone — bin is never used,
  // matching the doc comment's own ordering (prior transactions first).
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(join(backupRoot, "20260906T000000Z"), { recursive: true });
  assert.equal(hasPriorTransactions("/does-not-exist-bin", join(workDir, "server"), backupRoot), true);
});

test("hasPriorTransactions is false when the backup root is empty and the named volume does not exist", () => {
  const backupRoot = join(root, "does-not-exist");
  const result = withOverrideEnv(() => hasPriorTransactions(bin, join(workDir, "server"), backupRoot));
  assert.equal(result, false);
});

// クロエ round 4 review N-3: the exact danger this ruling exists to
// close — `start --initialize` once, no `update` since (empty
// backup_root), and the container has since disappeared. The volume
// itself still holds live state and must NOT read as "no prior state".
test("hasPriorTransactions is true when the backup root is empty but the named volume still exists", () => {
  const backupRoot = join(root, "does-not-exist");
  const result = withScenario("volume-exists-no-container", () =>
    hasPriorTransactions(bin, join(workDir, "server"), backupRoot),
  );
  assert.equal(result, true);
});

// クロエ round 4 review N-3: docker unreachable must resolve to `null`
// (unknown), never `false` — a `false` here is exactly what would let
// `start --initialize` re-run over state this function simply could not
// check.
test("hasPriorTransactions is null (unknown) when docker itself is unreachable, never false", () => {
  const backupRoot = join(root, "does-not-exist");
  const brokenBin = join(root, "broken-docker.sh");
  writeFileSync(brokenBin, "#!/bin/sh\necho 'Cannot connect to the Docker daemon.' >&2\nexit 1\n");
  chmodSync(brokenBin, 0o700);
  const result = hasPriorTransactions(brokenBin, join(workDir, "server"), backupRoot);
  assert.equal(result, null);
});

// クロエ round 4 review SF-5: hasPriorTransactions alone had not
// excluded dotfiles the way every other reader of backup_root already
// does — a leftover `.lock.update` from a crashed run must not read as
// "prior transaction state exists".
test("hasPriorTransactions ignores a leftover .lock.update, unlike a real transaction directory", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(join(backupRoot, ".lock.update"), { recursive: true });
  const result = withOverrideEnv(() => hasPriorTransactions(bin, join(workDir, "server"), backupRoot));
  assert.equal(result, false);
});

test("runBuild requires --target", () => {
  assert.throws(() => runBuild({ repo: workDir }, DEFAULT_CONFIG), DeployError);
});

test("runBuild refuses a dirty repo even in dry-run", () => {
  writeFileSync(join(workDir, "dirty.txt"), "uncommitted\n");
  assert.throws(
    () => runBuild({ repo: workDir, target: headSha, dryRun: true }, DEFAULT_CONFIG),
    DeployError,
  );
});

test("runBuild dry-run reports the plan without touching git or docker", () => {
  const result = runBuild({ repo: workDir, target: headSha, dryRun: true }, DEFAULT_CONFIG);
  assert.equal(result.dryRun, true);
  assert.equal(result.docker, "docker");
  assert.ok(result.wouldRun.some((line) => line.includes("merge --ff-only")));
});

test("runBuild builds, tags and reads back the image id through the gated fake docker", () => {
  const result = withOverrideEnv(() =>
    runBuild({ repo: workDir, target: headSha }, configWithOverride()),
  );
  assert.equal(result.dryRun, false);
  assert.equal(result.docker, "fake");
  assert.equal(result.identity.revision, headSha);
  assert.equal(result.identity.dirty, false);
  assert.equal(result.imageId, `sha256:${"f".repeat(64)}`);
  assert.equal(result.imageTag, `kaoiro-server:${headSha}`);
});

test("the public build command refuses a held deployment lock before compose build", () => {
  const config = configWithOverride();
  const backupRoot = config.backup_root;
  mkdirSync(join(backupRoot, `.lock.${deploymentLockKey(join(workDir, "server"))}`), { recursive: true });
  const configPath = join(root, "build-config.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const logPath = join(root, "docker-calls.log");
  let failure;
  try {
    execFileSync(
      process.execPath,
      [
        new URL("../kaoiro-server-deploy.mjs", import.meta.url).pathname,
        "build",
        "--repo",
        workDir,
        "--target",
        headSha,
        "--config",
        configPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, KAOIRO_DEPLOY_DOCKER_BIN: bin, KAOIRO_TEST_CALL_LOG: logPath },
      },
    );
  } catch (err) {
    failure = err;
  }
  assert.notEqual(failure?.status, 0);
  const calls = existsSync(logPath) ? readCallLog(logPath) : [];
  assert.equal(calls.filter((line) => line.startsWith("compose build")).length, 0);
});

test("runBuild refuses when the post-merge revision does not match --target", () => {
  // Advances workDir's own HEAD past headSha directly — the exact shape
  // this guard exists to catch: `git merge --ff-only <headSha>`, now an
  // ANCESTOR of HEAD, succeeds as a no-op ("Already up to date") while
  // HEAD stays at the newer commit computeBuildIdentity() then reports.
  writeFileSync(join(workDir, "second.txt"), "second\n");
  execFileSync("git", ["-C", workDir, "add", "-A"]);
  // workDir is a `git clone` of bareDir — clone never copies the SOURCE
  // repo's local user.email/user.name (identity is deliberately excluded
  // from clone), so this commit has no identity to fall back to unless
  // the host happens to have a global one set. CI's node:22 container has
  // none (PR #312 round-3 run, 2026-09-06) — pin identity explicitly here
  // instead of relying on global config.
  execFileSync("git", [
    "-C", workDir,
    "-c", "user.email=test@example.com",
    "-c", "user.name=Test",
    "commit", "-q", "-m", "second",
  ]);
  assert.throws(
    () => withOverrideEnv(() => runBuild({ repo: workDir, target: headSha }, configWithOverride())),
    DeployError,
  );
});

test("runStart on branch A starts the existing stopped container", () => {
  const result = withOverrideEnv(() => {
    process.env.FAKE_DOCKER_SCENARIO = "stopped";
    try {
      return runStart({ repo: workDir }, configWithOverride());
    } finally {
      delete process.env.FAKE_DOCKER_SCENARIO;
    }
  });
  assert.equal(result.branch, "A");
  assert.equal(result.container, "kaoiro-c1");
});

test("runStart on branch B refuses to bootstrap over existing prior-transaction state", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(join(backupRoot, "20260906T000000Z"), { recursive: true });
  const config = { ...configWithOverride(), backup_root: backupRoot };
  assert.throws(
    () => withOverrideEnv(() => runStart({ repo: workDir, initialize: true }, config)),
    DeployError,
  );
});

// クロエ round 1 review SF-6: defense in depth alongside the config
// VALIDATORS check — a config object built programmatically (as this
// test does, and as any caller not going through loadConfig would) never
// passes through that validator at all.
test("runStart refuses a relative backup_root even when the config was not loaded from a file", () => {
  const config = { ...configWithOverride(), backup_root: "relative/backup/dir" };
  assert.throws(() => withOverrideEnv(() => runStart({ repo: workDir, initialize: true }, config)), DeployError);
});

test("runStart on branch C refuses without --initialize", () => {
  assert.throws(
    () => withOverrideEnv(() => runStart({ repo: workDir }, configWithOverride())),
    DeployError,
  );
});

test("runStart on branch C with --initialize and --dry-run reports the plan", () => {
  const result = withOverrideEnv(() =>
    runStart({ repo: workDir, initialize: true, dryRun: true }, configWithOverride()),
  );
  assert.equal(result.branch, "C");
  assert.equal(result.dryRun, true);
  assert.ok(result.wouldRun.some((line) => line.includes("compose up")));
  // クロエ M1〜M3 review should S-1: runStart's own real path takes the
  // deployment lock via acquireLock, which mkdirSync's backup_root as a
  // side effect (recursive: true) — --dry-run must never reach that,
  // the same guarantee runUpdate --dry-run already pins.
  const backupRoot = join(root, "kaoiro-deploy");
  assert.equal(existsSync(backupRoot), false, "dry-run must not create backup_root");
});

// issue #322 M1 (must-fix): before this fix, runStart took no lock at
// all, so a prepared transaction (the lock update/rollback hold) did not
// stop it from calling `docker start` underneath them. Pre-creating the
// same lock a real run would compute (deploymentLockKey, exported
// specifically so this test does not hand-derive a parallel formula that
// could drift) reproduces "another mutator is mid-flight" without
// needing a second real process.
test("runStart refuses when the deployment lock is already held, and never calls docker start", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const config = configWithOverride();
  const lockPath = join(backupRoot, `.lock.${deploymentLockKey(join(workDir, "server"))}`);
  mkdirSync(lockPath, { recursive: true });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  try {
    assert.throws(
      () =>
        withOverrideEnv(() => {
          process.env.FAKE_DOCKER_SCENARIO = "stopped";
          try {
            return runStart({ repo: workDir }, config);
          } finally {
            delete process.env.FAKE_DOCKER_SCENARIO;
          }
        }),
      LockError,
    );
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  const log = readCallLog(logPath);
  assert.ok(
    !log.some((l) => l.startsWith("start ")),
    "start must not call docker start while another mutator holds the deployment lock",
  );
});

// issue #322 M1 (should-hold, hygiene direction): the lock's key is
// serverDir-derived specifically so a shared backup_root does not force
// TWO UNRELATED checkouts to contend with each other's lock — the
// opposite failure mode from the residual director ruling 2026-09-07
// accepts (same checkout, different backup_root, still independent).
test("runStart is not blocked by a lock held for a DIFFERENT serverDir under the same backup_root", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const config = configWithOverride();
  const otherServerDir = join(root, "unrelated-checkout", "server");
  mkdirSync(otherServerDir, { recursive: true });
  const otherLockPath = join(backupRoot, `.lock.${deploymentLockKey(otherServerDir)}`);
  mkdirSync(otherLockPath, { recursive: true });

  const result = withOverrideEnv(() => {
    process.env.FAKE_DOCKER_SCENARIO = "stopped";
    try {
      return runStart({ repo: workDir }, config);
    } finally {
      delete process.env.FAKE_DOCKER_SCENARIO;
    }
  });
  assert.equal(result.branch, "A");
});

test("runUpdate requires --target", () => {
  assert.throws(
    () => withScenario("running", () => runUpdate({ repo: workDir }, configWithOverride())),
    DeployError,
  );
});

test("runUpdate refuses when the container is not running", () => {
  assert.throws(
    () => withScenario("stopped", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride())),
    Error,
  );
});

// クロエ round 1 review MF-1: `update` silently ignored --dry-run and
// performed the real stop/build/archive/transaction-dir-creation
// sequence — reproduced live (repro.mjs) before this fix existed.
// クロエ round-1 review S3: a DENYLIST of mutating verbs missed `start`
// (runStart's branch A / rollback's own non-destructive path) and `rmi`
// (retention) — neither happens to run during THIS test, but the list
// itself does not structurally rule them out, the same enumeration trap
// this file's own UNRESUMABLE_PHASES/ROLLBACK_ELIGIBLE_PHASES already
// learned to avoid. Inverted to an ALLOW-list of the read-only verbs this
// CLI actually calls anywhere (compose ps/config/port, inspect, system
// df, version, volume inspect) — any OTHER verb appearing in the log,
// today or after a future change, fails this test by construction.
const READ_ONLY_DOCKER_VERBS = [
  "compose ps",
  "compose config",
  "compose port",
  "inspect",
  "system df",
  "version",
  "volume inspect",
];

test("runUpdate --dry-run performs no mutating docker call and creates no transaction dir", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const log = withCallLog("running", () =>
    runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true, dryRun: true }, configWithOverride()),
  );
  const lines = log.trim().split("\n");
  assert.ok(
    lines.some((line) => line.startsWith("compose ps")),
    "a read-only compose ps call should still happen",
  );
  for (const line of lines) {
    assert.ok(
      READ_ONLY_DOCKER_VERBS.some((verb) => line.startsWith(verb)),
      `dry-run made a non-read-only (or unrecognized) docker call: ${line}`,
    );
  }
  assert.ok(!log.includes("tar czf"), "dry-run must not archive");
  assert.equal(existsSync(backupRoot), false, "dry-run must not create backup_root or any transaction dir");
});

test("runUpdate --dry-run reports the plan", () => {
  const result = withScenario("running", () =>
    runUpdate({ repo: workDir, target: headSha, dryRun: true }, configWithOverride()),
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.container, "kaoiro-c1");
  assert.equal(result.unfinishedTransactionId, null);
  assert.equal(result.wouldRun[0], "git fetch origin");
  assert.ok(result.wouldRun.some((line) => line.includes("compose stop")));
  // issue #322 S1: fetched is always false (dry-run never fetches), and
  // headSha is workDir's own HEAD (present since clone), so it reads as
  // known locally with no fetch needed.
  assert.equal(result.fetched, false);
  assert.equal(result.targetKnownLocally, true);
});

// issue #322 S1 (should-fix): the OLD `gitOutput(["fetch", "origin"],
// repo)` mutated remote-tracking refs and downloaded objects even under
// --dry-run. This proves the replacement genuinely never touches
// origin: `origin` here points at a path that does not exist, so a real
// fetch attempt would throw (gitOutput's own fail()) and this test
// would go red if the fetch call were reinstated.
test("runUpdate --dry-run does not fetch from origin — succeeds even when origin is unreachable", () => {
  const brokenOriginDir = join(root, "work-broken-origin");
  execFileSync("git", ["clone", "-q", bareDir, brokenOriginDir]);
  execFileSync("git", [
    "-C",
    brokenOriginDir,
    "remote",
    "set-url",
    "origin",
    join(root, "does-not-exist.git"),
  ]);
  const result = withScenario("running", () =>
    runUpdate({ repo: brokenOriginDir, target: headSha, dryRun: true }, configWithOverride()),
  );
  assert.equal(result.fetched, false);
  assert.equal(result.targetKnownLocally, true);
});

test("runUpdate --dry-run reports targetKnownLocally: false for a target this repo has never fetched", () => {
  const neverFetchedSha = "f".repeat(40);
  const result = withScenario("running", () =>
    runUpdate({ repo: workDir, target: neverFetchedSha, dryRun: true }, configWithOverride()),
  );
  assert.equal(result.fetched, false);
  assert.equal(result.targetKnownLocally, false);
});

test("runUpdate --dry-run refuses --transaction", () => {
  assert.throws(
    () =>
      withScenario("running", () =>
        runUpdate({ repo: workDir, target: headSha, dryRun: true, transaction: "20260906T000000Z" }, configWithOverride()),
      ),
    DeployError,
  );
});

test("runUpdate derives old_sha from the old image build info, not git rev-parse HEAD", () => {
  writeFileSync(join(sourceDir, "server", "docker-compose.yaml"), "# target fixture\n");
  execFileSync("git", ["-C", sourceDir, "add", "server/docker-compose.yaml"]);
  execFileSync("git", ["-C", sourceDir, "commit", "-q", "-m", "target"]);
  const targetSha = execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", sourceDir, "push", "-q", bareDir, "main"]);
  const imageRevision = headSha;
  let caught;
  withOldBuildInfo(JSON.stringify({ revision: imageRevision }), () => {
    try {
      withScenario("running", () => runUpdate({ repo: workDir, target: targetSha }, configWithOverride()));
    } catch (err) {
      caught = err;
    }
  });
  assert.ok(caught instanceof DeployError, "must still stop at the maintenance gate without approval");
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionDir] = readdirSyncNonHidden(backupRoot);
  const journal = readJournal(join(backupRoot, transactionDir));
  const oldEntry = journal.history.find((e) => e.phase === "old_image_saved");
  assert.equal(oldEntry.observation.old_sha, imageRevision);
  assert.notEqual(oldEntry.observation.old_sha, targetSha, "must not have fallen back to the target revision");
  assert.equal(oldEntry.observation.rollback_tag, `kaoiro-server:rollback-${imageRevision}`);
});

test("runUpdate refuses an old image build info revision that is not a full SHA before creating a transaction", () => {
  assert.throws(
    () =>
      withOldBuildInfo(JSON.stringify({ revision: "unknown" }), () =>
        withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride())),
      ),
    (err) => err instanceof DeployError && /invalid revision/.test(err.message),
  );
  assert.deepEqual(readdirSyncNonHidden(join(root, "kaoiro-deploy")), []);
});

test("runUpdate refuses a pre-build-info old image before creating a transaction", () => {
  assert.throws(
    () =>
      withOldBuildInfo("__missing__", () =>
        withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride())),
      ),
    (err) => err instanceof DeployError && new RegExp(OLD_IMAGE_BUILD_INFO_PATH).test(err.message),
  );
  assert.deepEqual(readdirSyncNonHidden(join(root, "kaoiro-deploy")), []);
});

test("runUpdate refuses before creating a transaction when the old image revision is absent from source history", () => {
  const unavailableRevision = "b".repeat(40);
  assert.throws(
    () =>
      withOldBuildInfo(JSON.stringify({ revision: unavailableRevision }), () =>
        withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride())),
      ),
    (err) => err instanceof DeployError && /not a commit in this checkout's history/.test(err.message),
  );
  assert.deepEqual(readdirSyncNonHidden(join(root, "kaoiro-deploy")), []);
});

// クロエ round 1 review N-5: alpine is pulled, pinned to alpine:3, during
// preflight — before the stop window, not implicitly by the archive
// step's first `docker run` after the server is already down.
test("runUpdate pulls alpine:3 during preflight when it is not already present", () => {
  const log = withCallLog("alpine-missing", () =>
    runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithOverride()),
  );
  const stopIndex = log.indexOf("compose stop");
  const pullIndex = log.indexOf("pull alpine:3");
  assert.ok(pullIndex !== -1, "expected a pull of alpine:3");
  assert.ok(stopIndex !== -1, "expected the run to reach compose stop");
  assert.ok(pullIndex < stopIndex, "the pull must happen BEFORE compose stop, not after");
});

test("runUpdate stops at the maintenance gate without --maintenance-approved, but records prepare progress", () => {
  let caught;
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionDir] = readdirSyncNonHidden(backupRoot);
  const journal = readJournal(join(backupRoot, transactionDir));
  // issue #220 absorption: env_consistency is now checked BEFORE the
  // approval gate too (still no-downtime) — "prepare progress" now
  // extends one phase further than build alone.
  assert.equal(journal.phase, "env_consistency_checked");
});

// --- issue #220 absorption -----------------------------------------------

// issue #322 M5 (must-fix): "the module is absent" is now decided by a
// SEPARATE beam-file probe, not by whether the eval call itself failed
// (see imageHasPersistencePathsModule's own doc comment for the measured
// reason: eval boots the full release and fails on missing env vars
// BEFORE the module lookup, for every real invocation, so its own exit
// code could never distinguish "absent" from "OOM/daemon failure").
test("runUpdate records env_consistency as skipped when the target image's beam probe reports the module absent", () => {
  const result = withScenario("running-clean-stop", () =>
    withEnvConsistencyFixture({ beamAbsent: "1" }, () =>
      runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    ),
  );
  assert.equal(result.phase, "done");
  const backupRoot = join(root, "kaoiro-deploy");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  assert.equal(manifest.env_consistency.skipped, true);
  // issue #322 M5 follow-up (must-1): reason now states the OBSERVATION
  // (beam not found at this glob, in this image), not an inferred cause.
  assert.ok(manifest.env_consistency.reason.includes("PersistencePaths beam not found"));
});

test("runUpdate throws (never skips) when eval fails on an image the beam probe reports has the module", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        withEnvConsistencyFixture({ evalExit: "1" }, () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      ),
    (err) => err instanceof DeployError && /has the persistence-paths module but its eval call failed/.test(err.message),
  );
});

// issue #322 M5 follow-up (should-1, クロエ review): an eval failure past
// BUILD_PREPARED is exactly the case `compose build` (inside runBuild,
// above) already repointed `latest` at the new, now-unreviewable image —
// this must restore it to the old image before propagating, the same as
// the (separately pinned) env_consistency-mismatch path already does.
test("runUpdate restores kaoiro-server:latest to the old image when an eval failure throws past BUILD_PREPARED", () => {
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      withEnvConsistencyFixture({ evalExit: "1" }, () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(/has the persistence-paths module but its eval call failed/.test(caught.message));
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  assert.ok(
    log.trim().split("\n").includes(`tag ${OLD_IMAGE_ID} kaoiro-server:latest`),
    "expected kaoiro-server:latest to be retagged back to the old image on failure",
  );
});

test("runUpdate throws when the module-presence probe itself fails (image start or daemon failure)", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        withEnvConsistencyFixture({ beamProbeExit: "125" }, () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      ),
    (err) => err instanceof DeployError && /could not probe image/.test(err.message),
  );
});

// issue #322 M5 (must-fix, second half): default_path came from the
// TARGET image's own manifest even for the OLD (currently running)
// container's fallback — an assumption, not a measurement, unless old
// and new happen to compile the same default. When the old image CAN
// answer (its own beam probe reports present), checkEnvConsistency now
// prefers ITS default_path and records assumed_default_source:
// "old_image" (pinned above, in the status tests). This test covers the
// other branch: the old image cannot answer (a pre-#310 old image is
// the common real case), so the fallback to the target's own
// default_path is used, and the observation says so explicitly.
test("runUpdate falls back to the target image's own default_path, and records the assumption, when the old image's beam probe reports absent", () => {
  const result = withScenario("running-clean-stop", () =>
    withEnvConsistencyFixture(
      {
        // Declare the same path FAKE_DOCKER's default eval output gives
        // as the target image's own default_path, so falling back to it
        // (this test's whole point) is a match, not a genuine migration
        // — that failure mode already has its own dedicated tests.
        composeEnvJson: '{"KAOIRO_USERS_PATH":"/tmp/kaoiro-dets/users.dets"}',
        containerEnvJson: "[]",
        oldBeamAbsent: "1",
      },
      () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    ),
  );
  assert.equal(result.phase, "done");
  const backupRoot = join(root, "kaoiro-deploy");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  const entry = manifest.env_consistency.entries.KAOIRO_USERS_PATH;
  assert.equal(entry.assumed_default_source, "target_image");
  assert.equal(entry.container_source, "default");
  assert.equal(entry.container_effective, "/tmp/kaoiro-dets/users.dets");
  assert.equal(entry.match, true);
});

// issue #322 M5 follow-up (must-2, クロエ review): the earlier "falls
// back to target" test above only pinned assumed_default_source's own
// LABEL when the old image cannot answer — the (default) case where the
// old image CAN answer, and its VALUE is actually preferred over the
// target's, had no dedicated pin. oldEvalOutput gives the OLD image a
// default_path DIFFERENT from the target's own, so container_effective
// can only equal the old one if the preference is genuinely applied, not
// merely labeled.
test("runUpdate prefers the OLD image's own default_path over the target's, when the old image's beam probe reports present", () => {
  const oldDefaultPath = "/tmp/old-image-dets/users.dets";
  const oldEvalOutput = JSON.stringify([
    { store: "users", env: "KAOIRO_USERS_PATH", default_file: "users.dets", default_path: oldDefaultPath },
  ]);
  const result = withScenario("running-clean-stop", () =>
    withEnvConsistencyFixture(
      {
        oldEvalOutput,
        composeEnvJson: `{"KAOIRO_USERS_PATH":"${oldDefaultPath}"}`,
        containerEnvJson: "[]",
      },
      () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    ),
  );
  assert.equal(result.phase, "done");
  const backupRoot = join(root, "kaoiro-deploy");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  const entry = manifest.env_consistency.entries.KAOIRO_USERS_PATH;
  assert.equal(entry.assumed_default_source, "old_image");
  assert.equal(entry.container_source, "default");
  assert.equal(entry.container_effective, oldDefaultPath);
  assert.notEqual(
    entry.container_effective,
    "/tmp/kaoiro-dets/users.dets",
    "must not have used the target image's own default_path",
  );
  assert.equal(entry.match, true);
});

// issue #322 M5 follow-up (should-2, クロエ review): the OLD image's own
// manifest is an OPTIONAL enhancement (a fact about that image's history,
// not this transaction's own defect) — a shape violation there must fall
// back to the target's own default_path, the same as the old image being
// unable to answer at all (beam absent), not abort an otherwise-clean
// update. oldEvalOutput reports only 3 of the 4 required keys (missing
// default_path) — a genuine shape violation per isValidPersistencePathEntry.
test("runUpdate falls back to the target image's own default_path, and does not abort, when the old image's manifest has a shape violation", () => {
  const oldEvalOutput = JSON.stringify([{ store: "users", env: "KAOIRO_USERS_PATH", default_file: "users.dets" }]);
  const result = withScenario("running-clean-stop", () =>
    withEnvConsistencyFixture(
      {
        oldEvalOutput,
        composeEnvJson: '{"KAOIRO_USERS_PATH":"/tmp/kaoiro-dets/users.dets"}',
        containerEnvJson: "[]",
      },
      () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    ),
  );
  assert.equal(result.phase, "done");
  const backupRoot = join(root, "kaoiro-deploy");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  const entry = manifest.env_consistency.entries.KAOIRO_USERS_PATH;
  assert.equal(entry.assumed_default_source, "target_image");
  assert.equal(entry.container_effective, "/tmp/kaoiro-dets/users.dets");
  assert.equal(entry.match, true);
});

test("runUpdate throws when the target image's eval exits 0 but does not print valid JSON", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        withEnvConsistencyFixture({ evalOutput: "not json" }, () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      ),
    DeployError,
  );
});

test("runUpdate throws when the target image's eval prints valid JSON that is not the expected shape", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        withEnvConsistencyFixture({ evalOutput: '{"not":"an array"}' }, () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      ),
    DeployError,
  );
});

// クロエ round 5 review A-MF-2: the eval contract's own extension —
// an entry missing default_path is as much a shape violation as one
// missing store/env/default_file, since checkEnvConsistency cannot
// compute an effective path without it. compose and container are
// DELIBERATELY made to agree here — if the shape guard were absent,
// this would otherwise reach checkEnvConsistency and match cleanly
// (compose === containerRaw, default_path never even consulted),
// throwing for the WRONG reason and masking whether this guard fired.
test("runUpdate throws when the target image's eval reports an entry with no default_path", () => {
  const evalOutput = JSON.stringify([{ store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets" }]);
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        withEnvConsistencyFixture(
          {
            evalOutput,
            composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}',
            containerEnvJson: '["KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets"]',
          },
          () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      ),
    DeployError,
  );
});

// クロエ #310 round 1 S-1: the contract is "exactly the four keys", so a
// FIFTH key is a shape violation too — the image's contract has drifted
// from this file's. compose and container are DELIBERATELY made to agree,
// so without the key-set guard this reaches checkEnvConsistency and matches
// cleanly; the throw can only come from the guard under test.
test("runUpdate throws when the target image's eval reports an entry with an extra key", () => {
  const evalOutput = JSON.stringify([
    {
      store: "Users",
      env: "KAOIRO_USERS_PATH",
      default_file: "users.dets",
      default_path: "/tmp/kaoiro-dets/users.dets",
      config_key: "users_path",
    },
  ]);
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        withEnvConsistencyFixture(
          {
            evalOutput,
            composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}',
            containerEnvJson: '["KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets"]',
          },
          () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      ),
    DeployError,
  );
});

// クロエ #310 round 1 S-1: an empty manifest passed every other guard —
// Array.isArray holds, .every() is vacuously true — and produced a CLEAN
// result in which checkEnvConsistency compared nothing at all.
test("runUpdate throws when the target image's eval reports an empty manifest", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        withEnvConsistencyFixture({ evalOutput: "[]" }, () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      ),
    DeployError,
  );
});

// クロエ round 4 review A-SF-1: `entry.env` is embedded into a RegExp
// (readEnvFileValue) unescaped — a malformed eval response must be
// treated as a shape violation (DeployError, not skipped), not run
// through to the RegExp construction at all.
test("runUpdate throws (not skipped) when eval reports an env name that is not a valid identifier", () => {
  writeFileSync(join(workDir, "server", ".env"), "SECRET_KEY_BASE=super-secret-value-must-never-leak\n");
  const evalOutput = JSON.stringify([
    { store: "Users", env: ".*", default_file: "users.dets", default_path: "/tmp/kaoiro_users.dets" },
  ]);
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      withEnvConsistencyFixture({ evalOutput }, () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(!caught.message.includes("super-secret-value-must-never-leak"));
});

test("runUpdate throws (not a SyntaxError) when eval reports an env name that is not a valid RegExp fragment", () => {
  // A real .env file must exist — otherwise readEnvFileValue's own
  // ENOENT short-circuit returns null before ever reaching `new
  // RegExp(...)`, masking whether the guard (not that short-circuit) is
  // what actually prevents the SyntaxError.
  writeFileSync(join(workDir, "server", ".env"), "KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets\n");
  const evalOutput = JSON.stringify([
    { store: "Users", env: "(", default_file: "users.dets", default_path: "/tmp/kaoiro_users.dets" },
  ]);
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        withEnvConsistencyFixture({ evalOutput }, () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      ),
    DeployError,
  );
});

test("runUpdate fails closed and restores kaoiro-server:latest to the old image when env_consistency finds a mismatch", () => {
  writeFileSync(join(workDir, "server", ".env"), "KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets\n");
  const evalOutput = JSON.stringify([
    { store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets", default_path: "/tmp/kaoiro_users.dets" },
  ]);
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      withEnvConsistencyFixture(
        {
          evalOutput,
          composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}',
          // Deliberately DIFFERENT from .env/compose — the running
          // (old) container predates this compose value.
          containerEnvJson: '["KAOIRO_USERS_PATH=/tmp/kaoiro-dets/users.dets"]',
        },
        () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("env_consistency check found a problem"));
  // クロエ round 5 review SF-8: the message must name the two parties the
  // check actually compares (compose vs. the container's effective path)
  // and must not send an operator to edit .env, which A-MF-1 never reads
  // for `match`. A-MF-2: a genuine value mismatch (compose is not null)
  // reads as a first-application migration, naming both paths and 5-b.
  assert.ok(caught.message.includes(".env's own line is recorded as \"declared\" for reference only"));
  assert.ok(
    caught.message.includes(
      'KAOIRO_USERS_PATH: compose declares "/var/lib/kaoiro/users.dets" but the running container\'s effective path is "/tmp/kaoiro-dets/users.dets" (env) — this looks like a first-application migration; follow docs/specs/deployment.md 4.3 (5-b) before retrying',
    ),
  );
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  assert.ok(
    log.trim().split("\n").includes(`tag ${OLD_IMAGE_ID} kaoiro-server:latest`),
    "expected kaoiro-server:latest to be retagged back to the old image on failure",
  );
  // issue #322 M5 follow-up (should-1): this branch already restores
  // itself — the GENERIC catch added for should-1 must not redo it and
  // issue a second, redundant retag+read-back for the same failure.
  const tagLines = log.trim().split("\n").filter((line) => line === `tag ${OLD_IMAGE_ID} kaoiro-server:latest`);
  assert.equal(tagLines.length, 1, "expected exactly one retag, not a redundant second one");
});

// クロエ round 4 review B-1 (expanded further, WORKLOG 2026-09-07 00:14:
// B-1 spans 3 retag read-back call sites, not 2 — runUpdate's own
// abort-cleanup retag (env_consistency mismatch), separate from
// runRollback's destructive/non-destructive ones already pinned above).
// Uses "retag-drift" as the WHOLE scenario (added to the ps/State.Status
// lists alongside "running") since the mismatch is reached well before
// the stop window — no clean-stop scenario is needed here at all.
test("runUpdate reports both failures when env_consistency mismatches AND the abort-cleanup retag read-back also disagrees", () => {
  const evalOutput = JSON.stringify([
    { store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets", default_path: "/tmp/kaoiro_users.dets" },
  ]);
  let caught;
  try {
    withScenario("retag-drift", () =>
      withEnvConsistencyFixture(
        {
          evalOutput,
          composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}',
          containerEnvJson: '["KAOIRO_USERS_PATH=/tmp/kaoiro-dets/users.dets"]',
        },
        () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("env_consistency check failed AND could not restore kaoiro-server:latest"));
});

test("runUpdate proceeds through DONE when compose and container agree", () => {
  writeFileSync(join(workDir, "server", ".env"), "KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets\n");
  const evalOutput = JSON.stringify([
    { store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets", default_path: "/tmp/kaoiro_users.dets" },
  ]);
  const result = withScenario("running-clean-stop", () =>
    withEnvConsistencyFixture(
      {
        evalOutput,
        composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}',
        containerEnvJson: '["KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets"]',
      },
      () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    ),
  );
  assert.equal(result.phase, "done");
  const backupRoot = join(root, "kaoiro-deploy");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  assert.equal(manifest.env_consistency.skipped, false);
  const entry = manifest.env_consistency.entries.KAOIRO_USERS_PATH;
  assert.equal(entry.match, true);
  assert.equal(entry.declared, "/var/lib/kaoiro/users.dets");
});

// director ruling 2026-09-06, A-MF-1: the exact bug the 3-way design had
// — the bundled docker-compose.yaml sets every canonical persistence-
// path var as a LITERAL `environment:` entry (never `.env` interpolation),
// so `.env` legitimately has NO line for it on every correctly-configured
// production host. A 3-way check would have read this as a permanent
// mismatch from the moment #310 lands; the 2-way check (compose vs.
// container only) must pass here regardless.
test("runUpdate proceeds through DONE when compose and container agree, even with no .env line at all", () => {
  // No .env file written at all — readEnvFileValue's own ENOENT path.
  const evalOutput = JSON.stringify([
    { store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets", default_path: "/tmp/kaoiro_users.dets" },
  ]);
  const result = withScenario("running-clean-stop", () =>
    withEnvConsistencyFixture(
      {
        evalOutput,
        composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}',
        containerEnvJson: '["KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets"]',
      },
      () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    ),
  );
  assert.equal(result.phase, "done");
  const backupRoot = join(root, "kaoiro-deploy");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  const entry = manifest.env_consistency.entries.KAOIRO_USERS_PATH;
  assert.equal(entry.match, true);
  assert.equal(entry.declared, null);
});

// クロエ round 5 review A-MF-2 ("ao's own finding while writing (e)"): the
// original A-MF-1 design compared compose against the container's RAW env
// only — on the first application of a NEW persistence-path var, the old
// container was never recreated with it, so the raw env can NEVER equal
// compose's new value, fail-closing every legitimate first application
// forever. Comparing against the container's EFFECTIVE path (its own env
// value if set, else the image's default_path) fixes this: a first
// application where the store was already effectively where compose now
// declares it (default_path happens to equal compose's value) needs no
// migration, but a first application moving the store somewhere genuinely
// different still correctly reads as "5-b migration needed".
test("runUpdate matches when the container's raw env is unset but its default_path already equals compose's value", () => {
  const evalOutput = JSON.stringify([
    {
      store: "Users",
      env: "KAOIRO_USERS_PATH",
      default_file: "users.dets",
      default_path: "/var/lib/kaoiro/users.dets",
    },
  ]);
  const result = withScenario("running-clean-stop", () =>
    withEnvConsistencyFixture(
      {
        evalOutput,
        composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}',
        containerEnvJson: "[]",
      },
      () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    ),
  );
  assert.equal(result.phase, "done");
  const backupRoot = join(root, "kaoiro-deploy");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  const entry = manifest.env_consistency.entries.KAOIRO_USERS_PATH;
  assert.equal(entry.match, true);
  assert.equal(entry.container_effective, "/var/lib/kaoiro/users.dets");
  assert.equal(entry.container_source, "default");
});

test("runUpdate refuses with the 5-b message when the container's raw env is unset and its default_path genuinely differs from compose", () => {
  const evalOutput = JSON.stringify([
    { store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets", default_path: "/tmp/kaoiro_users.dets" },
  ]);
  let caught;
  try {
    withScenario("running", () =>
      withEnvConsistencyFixture(
        { evalOutput, composeEnvJson: '{"KAOIRO_USERS_PATH":"/var/lib/kaoiro/users.dets"}', containerEnvJson: "[]" },
        () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(
    caught.message.includes(
      'KAOIRO_USERS_PATH: compose declares "/var/lib/kaoiro/users.dets" but the running container\'s effective path is "/tmp/kaoiro_users.dets" (default) — this looks like a first-application migration; follow docs/specs/deployment.md 4.3 (5-b) before retrying',
    ),
  );
});

test("runUpdate refuses when compose does not declare a persistence-path var the image requires at all", () => {
  const evalOutput = JSON.stringify([
    { store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets", default_path: "/tmp/kaoiro_users.dets" },
  ]);
  let caught;
  try {
    withScenario("running", () =>
      withEnvConsistencyFixture(
        { evalOutput, composeEnvJson: "{}", containerEnvJson: '["KAOIRO_USERS_PATH=/tmp/kaoiro_users.dets"]' },
        () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(
    caught.message.includes(
      "KAOIRO_USERS_PATH: compose does not declare this persistence-path var at all (the #217 class",
    ),
  );
});

// クロエ round 5 review SF-7: composeDeclaredEnv's own shape guard — the
// original silently collapsed every unexpected shape to `{}`, which with
// A-MF-1's two-way comparison either fails closed on every entry (compose:
// null vs. a real container value) or, worse, PASSES without comparing
// anything at all (both sides null). Same "0 exit but garbage shape is a
// hard failure, not a skip" treatment queryPersistencePaths already gets.
test("runUpdate parses compose's environment when it is the array (\"KEY=VALUE\") shape", () => {
  const evalOutput = JSON.stringify([
    { store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets", default_path: "/tmp/kaoiro_users.dets" },
  ]);
  const result = withScenario("running-clean-stop", () =>
    withEnvConsistencyFixture(
      {
        evalOutput,
        composeEnvJson: '["KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets"]',
        containerEnvJson: '["KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets"]',
      },
      () => runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    ),
  );
  assert.equal(result.phase, "done");
  const backupRoot = join(root, "kaoiro-deploy");
  const manifest = readManifest(join(backupRoot, result.transactionId));
  assert.equal(manifest.env_consistency.entries.KAOIRO_USERS_PATH.match, true);
});

test("runUpdate throws (not a silent {}) when compose config has no service by the expected name", () => {
  const evalOutput = JSON.stringify([
    { store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets", default_path: "/tmp/kaoiro_users.dets" },
  ]);
  let caught;
  try {
    withScenario("compose-config-renamed-service", () =>
      withEnvConsistencyFixture(
        { evalOutput, containerEnvJson: "[]" },
        () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("has no service named"));
});

test("runUpdate throws (not a silent {}) when compose config's service has no environment key at all", () => {
  const evalOutput = JSON.stringify([
    { store: "Users", env: "KAOIRO_USERS_PATH", default_file: "users.dets", default_path: "/tmp/kaoiro_users.dets" },
  ]);
  let caught;
  try {
    withScenario("compose-config-missing-environment-key", () =>
      withEnvConsistencyFixture(
        { evalOutput, containerEnvJson: "[]" },
        () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("has no environment key"));
});

test("runUpdate completes through DONE with --maintenance-approved and a clean stop", () => {
  const result = withScenario("running-clean-stop", () =>
    runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
  );
  assert.equal(result.phase, "done");
  assert.equal(result.oldImageId, OLD_IMAGE_ID);
  assert.equal(result.rollbackTag, `kaoiro-server:rollback-${result.oldSha}`);
  assert.equal(result.build.imageTag, `kaoiro-server:${headSha}`);
  assert.equal(result.stopExitCode, 0);
  assert.equal(result.stopOomKilled, false);
  assert.equal(result.volumeId, "kaoiro_kaoiro-state");
  assert.equal(result.requiredEntries.length, 1);
  assert.deepEqual(result.requiredEntries[0], { path: "users.dets", owner: "1000:1000", mode: "0600" });
  assert.equal(existsSync(result.archive.path), true);
  assert.equal(result.archive.sha256, sha256File(result.archive.path));
  // (c3): health/stability.
  assert.equal(result.health.build_revision, headSha);
  assert.deepEqual(result.prunedTransactions, []);
  assert.equal(result.pruneError, null);
  const backupRoot = join(root, "kaoiro-deploy");
  const journal = readJournal(join(backupRoot, result.transactionId));
  assert.equal(journal.phase, "done");
  const oldImageEntry = journal.history.find((e) => e.phase === "old_image_saved");
  assert.equal(oldImageEntry.observation.rollback_tag, result.rollbackTag);
  const healthyEntry = journal.history.find((e) => e.phase === "healthy");
  assert.equal(healthyEntry.observation.health_revision, headSha);
  const manifest = readManifest(join(backupRoot, result.transactionId));
  assert.equal(manifest.volume_id, "kaoiro_kaoiro-state");
  assert.equal(manifest.image_id, result.build.imageId);
  assert.equal(manifest.source_sha, headSha);
  assert.deepEqual(manifest.required_entries, result.requiredEntries);
});

test("runUpdate refuses a target compose project or service-volume migration before stopping", () => {
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withComposePlans(composePlanJson("kaoiro-old"), composePlanJson("kaoiro-new", "kaoiro_new-state"), () =>
      withScenario("running-clean-stop", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.match(caught.message, /migration work, not a rolling update/);
  const log = readCallLog(logPath);
  assert.ok(!log.some((line) => line.includes(" compose stop")), "must not stop for a plan identity migration");
  assert.ok(!log.some((line) => line.includes("tar czf")), "must not archive for a plan identity migration");
});

test("runUpdate refuses a target service-volume migration even when the project name is unchanged", () => {
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withComposePlans(composePlanJson("kaoiro"), composePlanJson("kaoiro", "kaoiro_replaced-state"), () =>
      withScenario("running-clean-stop", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.match(caught.message, /service-volume changes/);
  const log = readCallLog(logPath);
  assert.ok(!log.some((line) => line.includes(" compose stop")));
  assert.ok(!log.some((line) => line.includes("tar czf")));
});

test("runUpdate binds target compose stop to the preflight container id", () => {
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("target-id-mismatch", () =>
      runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.match(caught.message, /captured container id/);
  assert.ok(!readCallLog(logPath).some((line) => line.includes(" compose stop")));
});

test("runUpdate does not archive when the captured container remains running after stop", () => {
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("target-remains-running", () =>
      runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.match(caught.message, /not confirmed stopped/);
  assert.ok(!readCallLog(logPath).some((line) => line.includes("tar czf")), "must not archive a live volume");
});

test("runUpdate refuses before stopping when the target effective compose plan changes after prepare", () => {
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    assert.ok(err instanceof DeployError);
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionId] = readdirSyncNonHidden(backupRoot);

  const composePath = join(workDir, "server", "docker-compose.yaml");
  writeFileSync(composePath, "# fixture\n# drifted after prepare\n");
  const priorPlan = process.env.KAOIRO_TEST_COMPOSE_CONFIG_JSON;
  process.env.KAOIRO_TEST_COMPOSE_CONFIG_JSON = JSON.stringify({ name: "kaoiro", services: { kaoiro: { image: "unexpected", volumes: [] } } });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      runUpdate(
        { repo: workDir, target: headSha, transaction: transactionId, maintenanceApproved: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
    if (priorPlan === undefined) delete process.env.KAOIRO_TEST_COMPOSE_CONFIG_JSON;
    else process.env.KAOIRO_TEST_COMPOSE_CONFIG_JSON = priorPlan;
  }
  assert.ok(caught instanceof DeployError, `expected a DeployError, got: ${caught}`);
  assert.match(caught.message, /target effective compose plan compose_sha256 has changed/);

  const log = readCallLog(logPath);
  assert.ok(!log.some((l) => l.startsWith("compose stop")), "must never stop for a drifted plan");
  assert.ok(!log.some((l) => l.startsWith("compose up")), "must never call compose up against a drifted config");
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "env_consistency_checked");
});

test("runUpdate refuses before stopping when .env bytes drift after prepare", () => {
  writeFileSync(join(workDir, "server", ".env"), "KAOIRO_UNUSED=before\n");
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    assert.ok(err instanceof DeployError);
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionId] = readdirSyncNonHidden(backupRoot);
  writeFileSync(join(workDir, "server", ".env"), "KAOIRO_UNUSED=after\n");

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      runUpdate(
        { repo: workDir, target: headSha, transaction: transactionId, maintenanceApproved: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.match(caught.message, /target effective compose plan env_sha256 has changed/);
  const log = readCallLog(logPath);
  assert.ok(!log.some((line) => line.startsWith("compose stop")));
  assert.ok(!log.some((line) => line.startsWith("compose up")));
});

test("runUpdate records the target effective compose plan after a legitimate target compose change", () => {
  writeFileSync(join(sourceDir, "server", "docker-compose.yaml"), "# legitimate target compose change\n");
  execFileSync("git", ["-C", sourceDir, "add", "server/docker-compose.yaml"]);
  execFileSync("git", ["-C", sourceDir, "commit", "-q", "-m", "target compose change"]);
  const target = execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", sourceDir, "push", "-q", bareDir, "main"]);

  try {
    withScenario("running", () => runUpdate({ repo: workDir, target }, configWithOverride()));
  } catch (err) {
    assert.ok(err instanceof DeployError);
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionId] = readdirSyncNonHidden(backupRoot);
  const priorHealth = process.env.KAOIRO_TEST_HEALTH_REVISION;
  process.env.KAOIRO_TEST_HEALTH_REVISION = target;
  try {
    const result = withScenario("running-clean-stop", () =>
      runUpdate(
        { repo: workDir, target, transaction: transactionId, maintenanceApproved: true },
        configWithCleanStopMeasured(),
      ),
    );
    assert.equal(result.command, "update");
    assert.equal(result.health.build_revision, target);
  } finally {
    if (priorHealth === undefined) delete process.env.KAOIRO_TEST_HEALTH_REVISION;
    else process.env.KAOIRO_TEST_HEALTH_REVISION = priorHealth;
  }
  const journal = readJournal(join(backupRoot, transactionId));
  const oldImage = journal.history.find((entry) => entry.phase === "old_image_saved");
  const build = journal.history.find((entry) => entry.phase === "build_prepared");
  assert.equal(typeof oldImage.observation.recovery_plan.compose_sha256, "string");
  assert.equal(typeof build.observation.target_plan.compose_sha256, "string");
  assert.notEqual(
    build.observation.target_plan.compose_sha256,
    oldImage.observation.recovery_plan.compose_sha256,
    "target plan must be captured after the target checkout is built",
  );
  const recoveryCompose = readFileSync(join(backupRoot, transactionId, "recovery-compose.yaml"), "utf8");
  assert.equal(
    recoveryCompose,
    execFileSync("git", ["-C", workDir, "show", `${headSha}:server/docker-compose.yaml`], { encoding: "utf8" }),
  );
  assert.notEqual(recoveryCompose, readFileSync(join(workDir, "server", "docker-compose.yaml"), "utf8"));
});

// issue #322 M2 (must-fix): kaoiro-server:latest is a MUTABLE tag —
// `compose up --no-build` at commit resolves whatever it currently is,
// not necessarily what THIS transaction's own build produced (an
// unrelated build between prepare and commit/resume would have
// repointed it). running-clean-stop-retag-drift's fake docker
// deliberately answers the post-tag inspect with a DIFFERENT id than
// what was just tagged, simulating exactly that.
test("runUpdate refuses to commit when kaoiro-server:latest cannot be pinned back to this transaction's own built image", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop-retag-drift", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    (err) => err instanceof DeployError && /could not pin kaoiro-server:latest/.test(err.message),
  );
});

// director ruling 2026-09-06 (#306 (c3) review): a hardcoded health_url
// default would miss in production (KAOIRO_PUBLISH_IP publishes on a
// different host than the dev-default loopback) — resolveHealthUrl
// derives it from `docker compose port` instead, tested here directly
// rather than by threading 3 more scenarios through the whole runUpdate
// flow.
test("resolveHealthUrl returns config.health_url unchanged without calling docker", () => {
  const url = withOverrideEnv(() =>
    resolveHealthUrl(bin, join(workDir, "server"), { health_url: "http://explicit/api/health" }),
  );
  assert.equal(url, "http://explicit/api/health");
});

test("resolveHealthUrl derives the URL from `docker compose port` when health_url is null", () => {
  const url = withScenario("health-url-derivable", () =>
    resolveHealthUrl(bin, join(workDir, "server"), { health_url: null }),
  );
  assert.equal(url, "http://127.0.0.1:9999/api/health");
});

// クロエ round 3 review N-1: `http://:::4000/...` is not a valid URL — an
// IPv6 host must be bracketed once it contains a colon of its own.
test("resolveHealthUrl brackets an IPv6 host reported unbracketed by `docker compose port`", () => {
  const url = withScenario("health-url-ipv6", () =>
    resolveHealthUrl(bin, join(workDir, "server"), { health_url: null }),
  );
  assert.equal(url, "http://[::]:4000/api/health");
  assert.doesNotThrow(() => new URL(url));
});

test("resolveHealthUrl fails when `docker compose port` itself fails", () => {
  assert.throws(
    () => withScenario("health-url-port-fails", () => resolveHealthUrl(bin, join(workDir, "server"), { health_url: null })),
    DeployError,
  );
});

test("resolveHealthUrl fails when `docker compose port` returns no output", () => {
  assert.throws(
    () => withScenario("health-url-port-empty", () => resolveHealthUrl(bin, join(workDir, "server"), { health_url: null })),
    DeployError,
  );
});

// クロエ round 2 review SF-8: a symlink's `-> target` and a hardlink's
// `link to target` suffix must not leak into the recorded path — both
// exercised against a REAL archive (FAKE_DOCKER's running-clean-stop-torture
// branch), not a hand-written tar-tvzf-shaped string.
test("runUpdate's required_entries strip a symlink's and a hardlink's target suffix from the name", () => {
  const result = withScenario("running-clean-stop-torture", () =>
    runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
  );
  assert.equal(result.phase, "done");
  const byPath = Object.fromEntries(result.requiredEntries.map((e) => [e.path, e]));
  assert.deepEqual(Object.keys(byPath).sort(), ["hard.txt", "real.txt", "sym.txt"]);
  assert.deepEqual(byPath["sym.txt"], { path: "sym.txt", owner: "1000:1000", mode: "0777" });
  assert.deepEqual(byPath["hard.txt"], { path: "hard.txt", owner: "1000:1000", mode: "0664" });
  assert.deepEqual(byPath["real.txt"], { path: "real.txt", owner: "1000:1000", mode: "0664" });
});

test("parseTarEntries refuses a listing line with an unsupported entry type", () => {
  let caught;
  try {
    parseTarEntries("p--------- 0/0               0 2026-09-06 00:00 ./fifo");
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  // クロエ round 2 review N-7: a PARSE failure (this) must read
  // distinctly from an ARCHIVE-integrity failure (the broken-archive
  // test above) — runUpdate's own call site no longer wraps this one in
  // "archive verification failed".
  assert.ok(!caught.message.includes("archive verification failed"));
});

// クロエ round 2 review SF-8 supplement: a FIFO needs no root (`mkfifo`
// — measured; the earlier assumption that device/fifo/socket entries
// need it was wrong), so this feeds parseTarEntries a REAL archive
// containing a symlink, a hardlink, a space-bearing name, AND a FIFO all
// together — the exact combination the round asked for as a round-3
// acceptance check — rather than the hand-typed single-line fixture
// above.
test("parseTarEntries rejects a real archive containing a FIFO, even alongside otherwise-valid entries", () => {
  const src = mkdtempSync(join(tmpdir(), "kaoiro-306-tar-torture-"));
  const archiveDir = mkdtempSync(join(tmpdir(), "kaoiro-306-tar-torture-out-"));
  try {
    writeFileSync(join(src, "real.txt"), "x");
    writeFileSync(join(src, "name with space.txt"), "x");
    execFileSync("ln", ["-s", "real.txt", join(src, "sym.txt")]);
    execFileSync("ln", [join(src, "real.txt"), join(src, "hard.txt")]);
    execFileSync("mkfifo", [join(src, "a.fifo")]);
    const archivePath = join(archiveDir, "archive.tar.gz");
    execFileSync("tar", ["--owner=1000", "--group=1000", "-czf", archivePath, "-C", src, "."]);
    const listing = execFileSync("tar", ["tvzf", archivePath, "--numeric-owner"], { encoding: "utf8" });
    assert.ok(listing.includes("a.fifo"), "sanity: the fixture actually contains the FIFO entry");
    assert.throws(() => parseTarEntries(listing), DeployError);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(archiveDir, { recursive: true, force: true });
  }
});

// director ruling 2026-09-06 (round 5, closing the required_entries
// mismatch pin gap left open in the rollback commit): the restored-
// volume-vs-manifest comparison rollback's own destructive path relies
// on, pinned directly as a pure function.
test("requiredEntriesMatch is true for the same entries in a different order", () => {
  const a = [
    { path: "users.dets", owner: "1000:1000", mode: "0600" },
    { path: "agent_directory.dets", owner: "1000:1000", mode: "0600" },
  ];
  const b = [...a].reverse();
  assert.equal(requiredEntriesMatch(a, b), true);
});

test("requiredEntriesMatch is false when an entry is missing", () => {
  const expected = [
    { path: "users.dets", owner: "1000:1000", mode: "0600" },
    { path: "agent_directory.dets", owner: "1000:1000", mode: "0600" },
  ];
  const actual = [expected[0]];
  assert.equal(requiredEntriesMatch(actual, expected), false);
});

test("requiredEntriesMatch is false when an entry is extra", () => {
  const expected = [{ path: "users.dets", owner: "1000:1000", mode: "0600" }];
  const actual = [...expected, { path: "unexpected.dets", owner: "1000:1000", mode: "0600" }];
  assert.equal(requiredEntriesMatch(actual, expected), false);
});

test("requiredEntriesMatch is false when an entry's owner disagrees", () => {
  const expected = [{ path: "users.dets", owner: "1000:1000", mode: "0600" }];
  const actual = [{ path: "users.dets", owner: "0:0", mode: "0600" }];
  assert.equal(requiredEntriesMatch(actual, expected), false);
});

test("requiredEntriesMatch is false when an entry's mode disagrees", () => {
  const expected = [{ path: "users.dets", owner: "1000:1000", mode: "0600" }];
  const actual = [{ path: "users.dets", owner: "1000:1000", mode: "0644" }];
  assert.equal(requiredEntriesMatch(actual, expected), false);
});

// クロエ round 1 review S1/(c3): a delayed health response for a
// PREVIOUS target must not let this transaction advance — the health
// poll retries until it actually observes the CURRENT target_sha, not
// merely "a response arrived".
test("runUpdate's health poll times out when the server never reports the target revision", () => {
  process.env.KAOIRO_TEST_HEALTH_REVISION = "f".repeat(40); // never equals headSha
  try {
    assert.throws(
      () =>
        withScenario("running-clean-stop", () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      DeployError,
    );
  } finally {
    delete process.env.KAOIRO_TEST_HEALTH_REVISION;
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionDir] = readdirSyncNonHidden(backupRoot);
  const journal = readJournal(join(backupRoot, transactionDir));
  assert.equal(journal.phase, "up");
});

// director ruling 2026-09-06 (#306 (c3) review): a dirty build at the
// right SHA is not a successful deploy — deployment.md 4.5's own
// provenance table treats build_dirty as a SEPARATE success criterion
// from build_revision, not a detail folded into it.
test("runUpdate's health poll times out when the server reports the target revision but a dirty build", () => {
  process.env.KAOIRO_TEST_HEALTH_DIRTY = "true";
  try {
    assert.throws(
      () =>
        withScenario("running-clean-stop", () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      DeployError,
    );
  } finally {
    delete process.env.KAOIRO_TEST_HEALTH_DIRTY;
  }
});

test("runUpdate refuses to call an update done when the container restarts during the stability window", () => {
  process.env.KAOIRO_TEST_RESTART_COUNTER = join(root, "restart-counter");
  try {
    assert.throws(
      () =>
        withScenario("running-clean-stop-restarts", () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      DeployError,
    );
  } finally {
    delete process.env.KAOIRO_TEST_RESTART_COUNTER;
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionDir] = readdirSyncNonHidden(backupRoot);
  const journal = readJournal(join(backupRoot, transactionDir));
  assert.equal(journal.phase, "healthy");
});

test("runUpdate prunes DONE transactions beyond keep_generations that are also older than retention_days", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });

  // Three synthetic prior DONE transactions, all well past retention_days
  // and beyond keep_generations:1 — every one of them is prune-eligible.
  const oldIds = ["20200101T000000Z", "20200102T000000Z", "20200103T000000Z"];
  const oldRollbackTag = `kaoiro-server:rollback-${"9".repeat(40)}`;
  for (const id of oldIds) {
    const dir = join(backupRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "journal.json"),
      JSON.stringify({ schema_version: 1, transaction_id: id, phase: "done", history: [] }),
    );
  }
  // クロエ round 3 review SF-2: only the FIRST one carries a manifest —
  // the other two must be SKIPPED (left on disk), not have their
  // directory deleted anyway with the tag cleanup merely skipped (the
  // prior contract this test itself pinned before round 3).
  writeFileSync(
    join(backupRoot, oldIds[0], "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      transaction_id: oldIds[0],
      compose_artifact: { path: "server/docker-compose.yaml", sha256: "a".repeat(64) },
      env_consistency: { skipped: false, entries: {} },
      image_id: `sha256:${"b".repeat(64)}`,
      source_sha: "9".repeat(40),
      target_sha: "d".repeat(40),
      volume_id: "kaoiro_kaoiro-state",
      archive: { path: "/backup/archive.tar.gz", sha256: "e".repeat(64) },
      required_entries: [{ path: "users.dets", owner: "1000:1000", mode: "0600" }],
      rollback_tag: oldRollbackTag,
    }),
  );

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let result;
  try {
    result = withScenario("running-clean-stop", () =>
      runUpdate(
        { repo: workDir, target: headSha, maintenanceApproved: true },
        { ...configWithCleanStopMeasured(), keep_generations: 1, retention_days: 1 },
      ),
    );
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const lines = log.trim().split("\n");
  assert.ok(
    lines.some((line) => line === `rmi ${oldRollbackTag}`),
    "expected the pruned transaction's own manifest-recorded rollback_tag to be removed via docker rmi",
  );
  assert.equal(
    lines.filter((line) => line.startsWith("rmi ")).length,
    1,
    "only the ONE pruned transaction that actually has a manifest should trigger a docker rmi call",
  );
  assert.equal(result.phase, "done");
  // The newest kept generation is THIS transaction; all 3 synthetic old
  // ones are beyond keep_generations:1 and older than retention_days:1 —
  // but only oldIds[0] carries a manifest, so it alone is actually
  // removed (SF-2: an unreadable manifest skips deletion, not just the
  // tag cleanup).
  assert.deepEqual(result.prunedTransactions, [oldIds[0]]);
  assert.equal(existsSync(join(backupRoot, oldIds[0])), false);
  assert.deepEqual(
    result.pruneSkipped.map((s) => s.id).sort(),
    [oldIds[1], oldIds[2]],
  );
  for (const id of [oldIds[1], oldIds[2]]) {
    assert.equal(existsSync(join(backupRoot, id)), true);
  }
});

test("runUpdate does not prune a DONE transaction that is beyond keep_generations but still within retention_days", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });

  const recentId = new Date(Date.now() - 60 * 60 * 1000) // 1 hour ago
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d\d\dZ$/, "Z");
  const dir = join(backupRoot, recentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: recentId, phase: "done", history: [] }),
  );

  const result = withScenario("running-clean-stop", () =>
    runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      { ...configWithCleanStopMeasured(), keep_generations: 1, retention_days: 30 },
    ),
  );
  assert.equal(result.phase, "done");
  assert.deepEqual(result.prunedTransactions, []);
  assert.equal(existsSync(dir), true);
});

// Distinguishes the COUNT bound from the age bound: both synthetic
// transactions here are old enough that retention_days:1 alone would
// prune both. keep_generations:2 (which counts THIS run's own
// transaction as the newest generation) must still protect the
// second-newest of the three from being pruned this round.
test("runUpdate keeps the newest keep_generations DONE transactions even when all are past retention_days", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });

  const olderId = "20200101T000000Z";
  const newerId = "20200102T000000Z";
  for (const id of [olderId, newerId]) {
    const dir = join(backupRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "journal.json"),
      JSON.stringify({ schema_version: 1, transaction_id: id, phase: "done", history: [] }),
    );
  }
  // A manifest (SF-2: no manifest means "skip, do not delete" — this test
  // is pinning the COUNT bound, so olderId must actually be eligible for
  // deletion, not merely skipped for an unrelated reason). Its own
  // rollback_tag is unique (not shared with newerId or this run's own
  // transaction), so MF-1's tag-survival protection does not interfere.
  writeFileSync(
    join(backupRoot, olderId, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      transaction_id: olderId,
      compose_artifact: { path: "server/docker-compose.yaml", sha256: "a".repeat(64) },
      env_consistency: { skipped: false, entries: {} },
      image_id: `sha256:${"b".repeat(64)}`,
      source_sha: "9".repeat(40),
      target_sha: "d".repeat(40),
      volume_id: "kaoiro_kaoiro-state",
      archive: { path: "/backup/archive.tar.gz", sha256: "e".repeat(64) },
      required_entries: [{ path: "users.dets", owner: "1000:1000", mode: "0600" }],
      rollback_tag: `kaoiro-server:rollback-${"9".repeat(40)}`,
    }),
  );

  const result = withScenario("running-clean-stop", () =>
    runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      { ...configWithCleanStopMeasured(), keep_generations: 2, retention_days: 1 },
    ),
  );
  assert.equal(result.phase, "done");
  assert.deepEqual(result.prunedTransactions, [olderId]);
  assert.equal(existsSync(join(backupRoot, olderId)), false);
  assert.equal(existsSync(join(backupRoot, newerId)), true);
  assert.equal(existsSync(join(backupRoot, result.transactionId)), true);
});

// Retention must never touch a transaction that has not reached DONE —
// an in-progress or manually-parked one is a human's investigation, not
// automatic cleanup, no matter how old or how far beyond keep_generations.
// A non-DONE transaction directory can never coexist with a successful
// runUpdate call in practice (findUnfinishedTransaction refuses to start
// a new transaction while ANY non-terminal one exists — this IS the
// property being relied on), so this exercises pruneOldTransactions()
// directly rather than manufacturing an unreachable end-to-end scenario.
test("pruneOldTransactions never removes a transaction that has not reached DONE, however old", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });

  const stuckId = "20200101T000000Z";
  const stuckDir = join(backupRoot, stuckId);
  mkdirSync(stuckDir, { recursive: true });
  writeFileSync(
    join(stuckDir, "journal.json"),
    JSON.stringify({
      schema_version: 1,
      transaction_id: stuckId,
      phase: "preflight",
      history: [{ phase: "preflight", at: "2020-01-01T00:00:00.000Z", observation: { container: "kaoiro-c1" } }],
    }),
  );

  const { removed } = pruneOldTransactions(backupRoot, { keep_generations: 0, retention_days: 1 });
  assert.deepEqual(removed, []);
  assert.equal(existsSync(stuckDir), true);
});

// director ruling 2026-09-06 (#306 (c3) review): the current rollback
// pair is protected by IDENTITY, not merely by the keep_generations
// count coincidentally always including the newest — keep_generations:0
// here (bypassing the config validator's own >= 1 floor, exactly as a
// directly-constructed config in production code could) would otherwise
// prune EVERY done transaction, including the protected one.
test("pruneOldTransactions never removes the protected transaction, even with keep_generations:0", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });

  const protectedId = "20200101T000000Z";
  const protectedDir = join(backupRoot, protectedId);
  mkdirSync(protectedDir, { recursive: true });
  writeFileSync(
    join(protectedDir, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: protectedId, phase: "done", history: [] }),
  );

  const { removed } = pruneOldTransactions(
    backupRoot,
    { keep_generations: 0, retention_days: 1 },
    protectedId,
  );
  assert.deepEqual(removed, []);
  assert.equal(existsSync(protectedDir), true);
});

// クロエ round 3 review MF-1: writes a synthetic transaction directory
// directly (journal.json always, manifest.json only when `manifest` is
// given) — rollback_tag is `kaoiro-server:rollback-<sourceSha>`
// (schema-enforced), so two transactions built with the SAME sourceSha
// end up with the SAME tag, exactly the collision MF-1 is about.
function writeSyntheticTransaction(backupRoot, id, { phase, sourceSha }) {
  const dir = join(backupRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.json"), JSON.stringify({ schema_version: 1, transaction_id: id, phase, history: [] }));
  if (sourceSha === undefined) return;
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      transaction_id: id,
      compose_artifact: { path: "server/docker-compose.yaml", sha256: "a".repeat(64) },
      env_consistency: { skipped: false, entries: {} },
      image_id: `sha256:${"b".repeat(64)}`,
      source_sha: sourceSha,
      target_sha: "d".repeat(40),
      volume_id: "kaoiro_kaoiro-state",
      archive: { path: "/backup/archive.tar.gz", sha256: "e".repeat(64) },
      required_entries: [{ path: "users.dets", owner: "1000:1000", mode: "0600" }],
      rollback_tag: `kaoiro-server:rollback-${sourceSha}`,
    }),
  );
}

function readCallLog(logPath) {
  return existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter((l) => l !== "") : [];
}

test("pruneOldTransactions never rmi's a tag the protected transaction still shares with a pruned older DONE", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });
  const sha = "a".repeat(40);
  const olderId = "20200101T000000Z";
  const protectedId = "20200102T000000Z";
  writeSyntheticTransaction(backupRoot, olderId, { phase: "done", sourceSha: sha });
  writeSyntheticTransaction(backupRoot, protectedId, { phase: "done", sourceSha: sha });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let removed;
  try {
    ({ removed } = pruneOldTransactions(backupRoot, { keep_generations: 0, retention_days: 1 }, protectedId, bin));
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  // The older, same-sha transaction's DIRECTORY is still reclaimed —
  // only its shared TAG must survive, since the protected transaction
  // still names it.
  assert.deepEqual(removed, [olderId]);
  assert.equal(existsSync(join(backupRoot, protectedId)), true);
  assert.deepEqual(readCallLog(logPath), [], "the shared tag must never be rmi'd while the protected transaction still needs it");
});

test("pruneOldTransactions rmi's a pruned transaction's tag when no surviving transaction shares it", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });
  const sharedSha = "a".repeat(40);
  const uniqueSha = "b".repeat(40);
  const olderId = "20200101T000000Z"; // shares sharedSha with protectedId
  const protectedId = "20200102T000000Z";
  const uniqueId = "20200103T000000Z"; // its own tag, shared with nobody
  writeSyntheticTransaction(backupRoot, olderId, { phase: "done", sourceSha: sharedSha });
  writeSyntheticTransaction(backupRoot, protectedId, { phase: "done", sourceSha: sharedSha });
  writeSyntheticTransaction(backupRoot, uniqueId, { phase: "done", sourceSha: uniqueSha });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let removed;
  try {
    ({ removed } = pruneOldTransactions(backupRoot, { keep_generations: 0, retention_days: 1 }, protectedId, bin));
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.deepEqual(removed.sort(), [olderId, uniqueId]);
  assert.deepEqual(readCallLog(logPath), [`rmi kaoiro-server:rollback-${uniqueSha}`]);
});

test("pruneOldTransactions never rmi's a tag an unfinished transaction still shares with a pruned old DONE", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(backupRoot, { recursive: true });
  const sha = "a".repeat(40);
  const oldDoneId = "20200101T000000Z";
  const unfinishedId = "20200102T000000Z";
  writeSyntheticTransaction(backupRoot, oldDoneId, { phase: "done", sourceSha: sha });
  // Parked at old_image_saved — non-DONE, so it never enters doneIds at
  // all, yet it is exactly the transaction that most needs its own tag
  // (it may still resume and roll back through it).
  writeSyntheticTransaction(backupRoot, unfinishedId, { phase: "old_image_saved", sourceSha: sha });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let removed;
  try {
    ({ removed } = pruneOldTransactions(backupRoot, { keep_generations: 0, retention_days: 1 }, undefined, bin));
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.deepEqual(removed, [oldDoneId]);
  assert.equal(existsSync(join(backupRoot, unfinishedId)), true);
  assert.deepEqual(readCallLog(logPath), [], "the unfinished transaction's own tag must never be rmi'd");
});

test("runUpdate refuses to proceed past a dirty stop even with a measured expectation", () => {
  // クロエ round 1 review SF-3: the clean-stop test above only ever
  // exercises "expected present, observation absent (unknown)" via the
  // OTHER unmeasured-expectation test below — this is the missing case,
  // "expected present, observation present and DIFFERENT" (a real crash:
  // exit 137, OOM-killed).
  assert.throws(
    () =>
      withScenario("running-dirty-stop", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    DeployError,
  );
});

// クロエ round 1 review MF-2: the rollback tag is verified by reading it
// BACK via `docker inspect`, not merely trusted because `docker tag`
// exited 0 — a tag pointing somewhere other than the old image (a
// `latest` race, an unexpected docker behavior) must stop the run before
// `compose build` ever runs, not silently record an unusable rollback
// target.
test("runUpdate refuses when the rollback tag verification disagrees with the old image id", () => {
  assert.throws(
    () =>
      withScenario("running-tag-drift", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride())),
    DeployError,
  );
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionDir] = readdirSyncNonHidden(backupRoot);
  const journal = readJournal(join(backupRoot, transactionDir));
  // Stopped BEFORE the checkpoint that would have recorded the
  // (unverifiable) rollback tag.
  assert.equal(journal.phase, "preflight");
});

test("runUpdate refuses to archive an empty volume", () => {
  assert.throws(
    () =>
      withScenario("running-empty-vol", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    DeployError,
  );
});

// クロエ round 1 review SF-5's own note (MF-4): isValidRequiredEntries([])
// is true, so a check that the ARCHIVE itself is non-empty is the only
// thing that stops an empty archive being recorded as restorable — the
// pre-archive volume-listing guard is a different scan and could
// disagree (this scenario's archive ends up empty despite the pre-scan
// reporting one file).
test("runUpdate refuses when the archive itself ends up empty despite a non-empty pre-scan", () => {
  assert.throws(
    () =>
      withScenario("running-archive-drifts-empty", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    DeployError,
  );
});

test("runUpdate refuses when the archive fails full-traversal verification", () => {
  assert.throws(
    () =>
      withScenario("running-broken-archive", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    DeployError,
  );
});

// #303 capacity preflight: this scenario's container never carries the
// mount at all, so resolveKaoiroLibMount's OWN guard (クロエ round-1
// review S1) catches it BEFORE the transaction directory is even
// created, earlier than the post-stop MOUNT_RESOLVED re-check this test
// used to reach (that guard's own dedicated pin, now that this scenario
// no longer reaches it, is the "mount-vanishes-after-stop" test right
// below). Both call sites now share the SAME diagnostic message.
test("runUpdate refuses at the capacity preflight when the /var/lib/kaoiro mount cannot be resolved", () => {
  let caught;
  try {
    withScenario("running-no-mount", () =>
      runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("mount layout changed"));
  // backup_root itself already exists (acquireLock creates it), but no
  // PER-TRANSACTION directory does — checkCapacity fails before
  // newTransactionId()/mkdirSync(dir), so there is nothing left behind.
  const backupRoot = join(root, "kaoiro-deploy");
  assert.deepEqual(readdirSyncNonHidden(backupRoot), []);
});

// MOUNT_RESOLVED's own comment: "not a fresh lookup that could pick up a
// different one" — pinned in isolation now that running-no-mount (above)
// no longer reaches it. The mount resolves fine during the PRE-stop
// capacity check (1st inspect call) but has vanished by the time
// MOUNT_RESOLVED re-resolves it POST-stop (2nd call).
test("runUpdate refuses to proceed when the mount cannot be resolved after stopping (re-verification)", () => {
  process.env.KAOIRO_TEST_MOUNT_CALL_COUNTER = join(root, "mount-call-counter");
  try {
    assert.throws(
      () =>
        withScenario("mount-vanishes-after-stop", () =>
          runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
        ),
      DeployError,
    );
  } finally {
    delete process.env.KAOIRO_TEST_MOUNT_CALL_COUNTER;
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionDir] = readdirSyncNonHidden(backupRoot);
  const journal = readJournal(join(backupRoot, transactionDir));
  assert.equal(journal.phase, "stopped");
});

// #303 operator decision (5), クロエ manual round-1 review M1:
// capacity_multiplier has existed in the operator config since #306
// landed, with no consumer until this commit. Pinned via --dry-run (both
// measurements are pure reads, so a dry-run gives the same fail-closed
// answer a real run would) with an absurdly large capacity_multiplier so
// the comparison fails deterministically regardless of the real test
// host's actual free space.
test("runUpdate's capacity preflight refuses when free space is below capacity_multiplier x volume size", () => {
  let caught;
  try {
    withScenario("running", () =>
      runUpdate(
        { repo: workDir, target: headSha, dryRun: true },
        { ...configWithOverride(), capacity_multiplier: 1000000000000 },
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("capacity preflight refused"));
});

test("runUpdate's capacity preflight passes and records free/volume/threshold when there is enough room", () => {
  const planned = withScenario("running", () =>
    runUpdate({ repo: workDir, target: headSha, dryRun: true }, configWithOverride()),
  );
  assert.equal(planned.capacity.volume_bytes, 2000); // FAKE_DOCKER's default "2kB" (SI: 2 x 1000)
  assert.equal(
    planned.capacity.threshold_bytes,
    DEFAULT_CONFIG.capacity_multiplier * planned.capacity.volume_bytes,
  );
  assert.ok(planned.capacity.free_bytes >= planned.capacity.threshold_bytes);

  // A REAL (non-dry-run) run checkpoints the SAME shape durably in the
  // PREFLIGHT observation, not merely in the dry-run's return value —
  // this run legitimately stops at the maintenance gate right after.
  let caught;
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionDir] = readdirSyncNonHidden(backupRoot);
  const journal = readJournal(join(backupRoot, transactionDir));
  const preflight = journal.history.find((e) => e.phase === "preflight").observation;
  assert.equal(preflight.volume_bytes, 2000);
  assert.equal(preflight.threshold_bytes, DEFAULT_CONFIG.capacity_multiplier * preflight.volume_bytes);
  assert.ok(preflight.free_bytes >= preflight.threshold_bytes);
});

// director ruling 2026-09-07 (turn 7), クロエ-sub live measurement (this
// host's 21 volumes): 'kB' (lowercase k) is SI base-1000, not 1024 — base
// 1024 here would UNDERESTIMATE the real size, the dangerous direction (a
// genuine shortage would then read as "enough room").
test("runUpdate's capacity preflight scales a 'kB' volume size by 1000, not 1024", () => {
  process.env.KAOIRO_TEST_VOLUME_SIZE = "213.6kB";
  let planned;
  try {
    planned = withScenario("running", () =>
      runUpdate({ repo: workDir, target: headSha, dryRun: true }, configWithOverride()),
    );
  } finally {
    delete process.env.KAOIRO_TEST_VOLUME_SIZE;
  }
  assert.equal(planned.capacity.volume_bytes, 213600);
});

// クロエ round-1 review S2: kB/MB were pinned but GB/TB were not — each
// multiplier is its OWN entry in SI_VOLUME_SIZE_MULTIPLIER, so a typo'd
// exponent for the two largest units could survive undetected. A GB/TB
// volume size at ANY realistic capacity_multiplier can legitimately
// exceed a real test host's free disk space (unlike kB/MB above, which
// safely clear it) — read the computed byte count back from a
// DETERMINISTICALLY-refused run's own message instead of asserting on a
// "passes" path that a host with less free disk would flake on.
test("runUpdate's capacity preflight scales a 'GB' volume size by 1000 ** 3", () => {
  process.env.KAOIRO_TEST_VOLUME_SIZE = "1.5GB";
  let caught;
  try {
    withScenario("running", () =>
      runUpdate(
        { repo: workDir, target: headSha, dryRun: true },
        { ...configWithOverride(), capacity_multiplier: 1000000000000 },
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_VOLUME_SIZE;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("current volume size 1500000000 bytes"));
});

test("runUpdate's capacity preflight scales a 'TB' volume size by 1000 ** 4", () => {
  process.env.KAOIRO_TEST_VOLUME_SIZE = "2TB";
  let caught;
  try {
    withScenario("running", () =>
      runUpdate(
        { repo: workDir, target: headSha, dryRun: true },
        { ...configWithOverride(), capacity_multiplier: 1000000000000 },
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_VOLUME_SIZE;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("current volume size 2000000000000 bytes"));
});

test("runUpdate's capacity preflight refuses when volume usage cannot be measured ('docker system df -v' fails)", () => {
  let caught;
  try {
    withScenario("system-df-fails", () =>
      runUpdate({ repo: workDir, target: headSha, dryRun: true }, configWithOverride()),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("could not measure volume usage"));
});

// The "0 exit but garbage shape" class this file already treats as a hard
// failure elsewhere (queryPersistencePaths, composeDeclaredEnv) — a
// command that RUNS but whose output this parser cannot read is a
// different, equally fail-closed outcome from the command failing to run
// at all (pinned above).
test("runUpdate's capacity preflight refuses when 'docker system df -v' prints invalid JSON", () => {
  let caught;
  try {
    withScenario("system-df-invalid-json", () =>
      runUpdate({ repo: workDir, target: headSha, dryRun: true }, configWithOverride()),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("did not return valid JSON"));
});

test("runUpdate's capacity preflight refuses when 'docker system df -v' prints a non-array shape", () => {
  let caught;
  try {
    withScenario("system-df-not-array", () =>
      runUpdate({ repo: workDir, target: headSha, dryRun: true }, configWithOverride()),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("unexpected shape"));
});

test("runUpdate's capacity preflight refuses when the resolved volume is absent from 'docker system df -v'", () => {
  process.env.KAOIRO_TEST_VOLUME_NAME = "some-other-volume";
  let caught;
  try {
    withScenario("running", () =>
      runUpdate({ repo: workDir, target: headSha, dryRun: true }, configWithOverride()),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_VOLUME_NAME;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("has no entry for volume"));
});

// director ruling 2026-09-07 (turn 7): any unit spelling other than the
// five docker's own formatter emits (a different docker version, a
// binary-prefix unit like KiB/MiB) is unmeasurable, never guessed at.
test("runUpdate's capacity preflight refuses an unknown volume-size unit ('MiB')", () => {
  process.env.KAOIRO_TEST_VOLUME_SIZE = "1MiB";
  let caught;
  try {
    withScenario("running", () =>
      runUpdate({ repo: workDir, target: headSha, dryRun: true }, configWithOverride()),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_VOLUME_SIZE;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("could not parse volume"));
});

test("runUpdate refuses to proceed past a stop with no measured clean-stop expectation", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithOverride()),
      ),
    DeployError,
  );
});

test("runUpdate resumes a gated transaction via --transaction without rebuilding", () => {
  let transactionId;
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    assert.ok(err instanceof DeployError);
  }
  const backupRoot = join(root, "kaoiro-deploy");
  [transactionId] = readdirSyncNonHidden(backupRoot);

  const result = withScenario("running-clean-stop", () =>
    runUpdate(
      { repo: workDir, target: headSha, transaction: transactionId, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    ),
  );
  assert.equal(result.phase, "done");
  assert.equal(result.transactionId, transactionId);
});

test("runUpdate refuses to resume when --target no longer matches the prepared transaction", () => {
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    assert.ok(err instanceof DeployError);
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionId] = readdirSyncNonHidden(backupRoot);
  const otherTarget = "f".repeat(40);
  assert.throws(
    () =>
      withScenario("running", () =>
        runUpdate(
          { repo: workDir, target: otherTarget, transaction: transactionId, maintenanceApproved: true },
          configWithOverride(),
        ),
      ),
    DeployError,
  );
});

test("runUpdate refuses a second transaction while one is unfinished, and creates no new transaction dir", () => {
  // running-broken-archive stops at MOUNT_RESOLVED (archive verification
  // fails before ARCHIVED is ever checkpointed) — non-terminal, and
  // untouched by (c3)'s up/health/stability/retention plumbing.
  try {
    withScenario("running-broken-archive", () =>
      runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
    );
  } catch (err) {
    assert.ok(err instanceof DeployError);
  }
  const backupRoot = join(root, "kaoiro-deploy");
  const before = readdirSyncNonHidden(backupRoot).length;
  let caught;
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  // クロエ round 1 review MF-3: the reached phase is MOUNT_RESOLVED — the
  // commit half has already stopped the container, so `--transaction`'s
  // own requireRunningContainer re-check could never succeed. The
  // message must say so rather than send the operator into a guaranteed
  // second failure.
  assert.ok(!caught.message.includes("resume it with --transaction"));
  assert.ok(caught.message.includes("no resume support yet"));
  // The count check is what actually pins the guard: without it, a
  // mutated guard that lets a second run through still ends up throwing
  // DeployError at its OWN maintenance gate, so `assert.throws` alone
  // would pass even with the duplicate-transaction check removed.
  assert.equal(
    readdirSyncNonHidden(backupRoot).length,
    before,
    "a second transaction must not be created while one is unfinished",
  );
});

test("runUpdate's unfinished-transaction guidance still offers --transaction before the maintenance gate", () => {
  // The COUNTERPART of the test above: a transaction that has NOT yet
  // stopped the container is genuinely resumable, and must keep saying
  // so — this is what MF-3's fix is phase-DEPENDENT, not a blanket
  // rewording.
  withScenario("running", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
  });
  let caught;
  try {
    withScenario("running", () => runUpdate({ repo: workDir, target: headSha }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("resume it with --transaction"));
  assert.ok(!caught.message.includes("no resume support yet"));
});

// クロエ round 3 review MF-2: STARTING was missing from the old
// hand-written UNRESUMABLE_PHASES set — a transaction parked there got
// "resume with --transaction", and the resume path then appended
// MAINTENANCE_GATE_PASSED, an illegal transition from STARTING, raising
// a raw PhaseError instead of this diagnosable message. No existing
// FAKE_DOCKER scenario stops a real runUpdate exactly between STARTING
// and UP (every scenario's `compose ps`/`up` succeed together), so this
// writes the parked journal directly — a full, schema-valid history
// through STARTING, the same shape findUnfinishedTransaction's own
// validateJournalAgainstStateMachine call requires before this guidance
// is ever reached.
test("runUpdate's unfinished-transaction guidance for a transaction parked at STARTING is the manual-recovery message", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const transactionId = "20260906T230000Z";
  const dir = join(backupRoot, transactionId);
  mkdirSync(dir, { recursive: true });
  const oldSha = headSha;
  const targetSha = "d".repeat(40);
  const imageId = `sha256:${"b".repeat(64)}`;
  const composeSha = "c".repeat(64);
  const entry = (phase, observation) => ({ phase, at: "2026-09-06T23:00:00.000Z", observation });
  const history = [
    entry("preflight", {
      container: "kaoiro-c1",
      free_bytes: 100000000,
      volume_bytes: 1000000,
      threshold_bytes: 10000000,
    }),
    entry("old_image_saved", {
      old_image_id: imageId,
      old_sha: oldSha,
      compose_artifact: { path: "/x/docker-compose.yaml", sha256: composeSha },
      rollback_tag: `kaoiro-server:rollback-${oldSha}`,
    }),
    entry("build_prepared", { image_id: imageId, image_tag: "kaoiro-server:latest", target_sha: targetSha }),
    entry("env_consistency_checked", { skipped: false, entries: {} }),
    entry("maintenance_gate_passed", {}),
    entry("stopping", {}),
    entry("stopped", { stop_exit_code: 0, stop_oom_killed: false }),
    entry("mount_resolved", { volume_id: "kaoiro_kaoiro-state" }),
    entry("archived", {
      archive: { path: "/b/a.tar.gz", sha256: composeSha },
      required_entries: [{ path: "u.dets", owner: "1000:1000", mode: "0600" }],
    }),
    entry("starting", {}),
  ];
  writeFileSync(
    join(dir, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: transactionId, phase: "starting", history }),
  );

  let caught;
  try {
    withOverrideEnv(() => runUpdate({ repo: workDir, target: targetSha }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  // instanceof DeployError (not PhaseError) also confirms the fixture
  // above is itself schema-valid — a malformed history would surface as
  // a raw PhaseError from findUnfinishedTransaction's own validation
  // instead of reaching this guidance message at all.
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("no resume support yet"));
  assert.ok(!caught.message.includes("resume it with --transaction"));
});

// クロエ round 5 review SF-6 applies to this test too (the same class,
// a second sighting): a hand-listed expectation pins today's membership,
// not the auto-growth property the comment below actually claims. Measured
// instead against the SAME formula UNRESUMABLE_PHASES itself uses, so
// inserting a new phase anywhere reachable from STOPPING (as B-4's own
// ROLLED_BACK/ROLLBACK_STOPPED edges, and SF-9's ROLLBACK_RESTORING,
// already did once each) can never leave this test stale.
test("UNRESUMABLE_PHASES is exactly every phase reachable from STOPPING", () => {
  // Grew automatically to include rollback's own phases once B-4 added
  // a ROLLED_BACK edge from STOPPING onward and a ROLLBACK_STOPPED edge
  // from STARTING/UP/HEALTHY/DONE — a transaction parked mid-rollback is
  // exactly as unresumable BY UPDATE as one parked at STOPPED always
  // was, and the derivation (not a hand-written list) picked that up
  // for free.
  assert.deepEqual(
    [...UNRESUMABLE_PHASES].sort(),
    [...reachablePhases(PHASE.STOPPING, TRANSITIONS)].sort(),
  );
});

// クロエ round 4 review B-2: ROLLBACK_ELIGIBLE_PHASES is now the set
// difference reachable(OLD_IMAGE_SAVED) \ reachable(ROLLBACK_STOPPED),
// not a hand-written 4-element delete list — pinned two ways: the exact
// current membership, and (more directly protecting the actual property
// B-2 cares about) that EVERY phase reachable from ROLLBACK_STOPPED is
// excluded, which stays true automatically if a phase is ever inserted
// into that chain.
test("ROLLBACK_ELIGIBLE_PHASES is exactly OLD_IMAGE_SAVED-reachable minus ROLLBACK_STOPPED-reachable", () => {
  assert.deepEqual(
    [...ROLLBACK_ELIGIBLE_PHASES].sort(),
    [
      "archived",
      "build_prepared",
      "done",
      "env_consistency_checked",
      "healthy",
      "maintenance_gate_passed",
      "mount_resolved",
      "old_image_saved",
      "starting",
      "stopped",
      "stopping",
      "up",
    ].sort(),
  );
});

test("ROLLBACK_ELIGIBLE_PHASES never includes a phase reachable from ROLLBACK_STOPPED", () => {
  for (const phase of reachablePhases(PHASE.ROLLBACK_STOPPED, TRANSITIONS)) {
    assert.equal(ROLLBACK_ELIGIBLE_PHASES.has(phase), false, `${phase} must be excluded`);
  }
});

// クロエ round 5 review SF-6: the test above ORIGINALLY hand-listed
// today's 4 rollback-chain phases — reverting the production derivation
// back to the old hand-written delete list left it green (those same 4
// literals happen to be excluded by that list too), so it measured
// today's membership, not the auto-exclusion PROPERTY B-2/MF-2 actually
// care about: a phase inserted into the rollback chain LATER must be
// excluded without anyone remembering to update a list. Pinned by
// running the exact formula ROLLBACK_ELIGIBLE_PHASES itself uses against
// a test-local TRANSITIONS copy with a synthetic phase spliced into the
// chain — the production constant can't be recomputed at test time (it
// is frozen once at import), so this measures the FORMULA directly.
test("the ROLLBACK_ELIGIBLE_PHASES formula auto-excludes a phase newly inserted into the rollback chain", () => {
  const SYNTHETIC = "rollback_synthetic_inserted_phase";
  const testTransitions = {
    ...TRANSITIONS,
    [PHASE.ROLLBACK_STOPPED]: [SYNTHETIC],
    [SYNTHETIC]: [PHASE.ROLLBACK_FORENSIC_ARCHIVED],
  };
  const eligible = new Set(
    [...reachablePhases(PHASE.OLD_IMAGE_SAVED, testTransitions)].filter(
      (phase) => !reachablePhases(PHASE.ROLLBACK_STOPPED, testTransitions).has(phase),
    ),
  );
  assert.equal(eligible.has(SYNTHETIC), false, "the newly-inserted phase must be excluded without an update");
  // Splicing in the synthetic phase must not accidentally widen anything
  // else the chain already excluded.
  for (const phase of ["rollback_forensic_archived", "rollback_restored", "rolled_back"]) {
    assert.equal(eligible.has(phase), false, `${phase} must remain excluded`);
  }
});

// クロエ round 3 review MF-3 pin.
test("runUpdate fails the stability gate when RestartCount reads as unreadable on both sides", () => {
  assert.throws(
    () =>
      withScenario("running-clean-stop-restartcount-unreadable", () =>
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured()),
      ),
    DeployError,
  );
});

function readdirSyncNonHidden(dir) {
  return readdirSync(dir).filter((name) => !name.startsWith("."));
}

// --- status --------------------------------------------------------------
// `status` never mutates: no lock, no transaction directory, no docker
// mutation. Every test below only reads.

test("status reports a running container without falling back to classify()'s branch table", () => {
  const result = withScenario("running", () => runStatus({ repo: workDir }, configWithOverride()));
  assert.equal(result.container.running, true);
  assert.equal(result.container.container, "kaoiro-c1");
  assert.equal(result.unfinishedTransaction, null);
  assert.deepEqual(result.doneTransactions, []);
});

test("status reports branch A when the container is stopped", () => {
  const result = withScenario("stopped", () => runStatus({ repo: workDir }, configWithOverride()));
  assert.equal(result.container.running, false);
  assert.equal(result.container.branch, "A");
  assert.equal(result.container.container, "kaoiro-c1");
});

test("status reports branch C when there is no container and no prior state", () => {
  const result = withOverrideEnv(() => runStatus({ repo: workDir }, configWithOverride()));
  assert.equal(result.container.running, false);
  assert.equal(result.container.branch, "C");
});

// クロエ round 4 review N-3, end to end through classify(): no container
// (requireRunningContainer correctly throws BranchError, reaching
// classify()) and no prior transactions, but hasPriorTransactions
// itself could not determine the volume's existence (docker
// unreachable) — must diagnose, never claim FRESH.
test("status reports branch D (never C) when no container is found and hasPriorTransactions itself could not tell", () => {
  const result = withScenario("docker-unreachable-for-state-check", () =>
    runStatus({ repo: workDir }, configWithOverride()),
  );
  assert.equal(result.container.running, false);
  assert.equal(result.container.branch, "D");
  assert.ok(result.container.reason.includes("could not determine whether prior state exists"));
});

test("status reports branch B when prior transaction state exists but no container is found", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  mkdirSync(join(backupRoot, "20260906T000000Z"), { recursive: true });
  const result = withOverrideEnv(() =>
    runStatus({ repo: workDir }, { ...configWithOverride(), backup_root: backupRoot }),
  );
  assert.equal(result.container.running, false);
  assert.equal(result.container.branch, "B");
});

test("status's health field carries the health body when the container answers", () => {
  const result = withScenario("running", () =>
    runStatus({ repo: workDir }, { ...configWithOverride(), health_url: "http://fake-server.invalid/api/health" }),
  );
  assert.equal(result.health.url, "http://fake-server.invalid/api/health");
  // withOverrideEnv's own default sets KAOIRO_TEST_HEALTH_REVISION to
  // headSha unless a caller already set it — status only surfaces what
  // curl returned, it does not judge whether it matches any target.
  assert.equal(result.health.build_revision, headSha);
});

test("status's health field reports an error (not a crash) when curl itself fails to resolve the URL", () => {
  // "running" is not a case `docker compose port` recognizes in this
  // fixture (only the health-url-* scenarios are), so it falls through
  // to empty output — the same "no output" failure resolveHealthUrl's
  // own direct unit test exercises via "health-url-port-empty". Reusing
  // it here (rather than "health-url-port-fails", which is ALSO absent
  // from the fixture's `compose ps` case list and would report no
  // container at all) keeps container.running true while still failing
  // health_url resolution.
  const result = withScenario("running", () =>
    runStatus({ repo: workDir }, { ...configWithOverride(), health_url: null }),
  );
  assert.equal(result.container.running, true);
  assert.ok(result.health.error, "expected a health.error, not a thrown exception");
});

test("status's health field reports an error (not a crash) when curl itself is unavailable", () => {
  withScenario("running", () => {
    const priorCurl = process.env.KAOIRO_DEPLOY_CURL_BIN;
    process.env.KAOIRO_DEPLOY_CURL_BIN = join(root, "does-not-exist-curl");
    try {
      const result = runStatus(
        { repo: workDir },
        { ...configWithOverride(), health_url: "http://fake-server.invalid/api/health" },
      );
      assert.equal(result.container.running, true);
      assert.ok(result.health.error, "expected a health.error, not a thrown exception");
    } finally {
      if (priorCurl === undefined) delete process.env.KAOIRO_DEPLOY_CURL_BIN;
      else process.env.KAOIRO_DEPLOY_CURL_BIN = priorCurl;
    }
  });
});

test("status does not attempt a health check when no container is running", () => {
  const result = withScenario("stopped", () => runStatus({ repo: workDir }, configWithOverride()));
  assert.equal(result.health, null);
});

// クロエ round 4 review MF-4: every leg of status is independent — a
// transaction directory that fails findUnfinishedTransaction's own
// state-machine trust checks must not blank the rest of the output.
test("status still returns a full object when a transaction directory has a mismatched transaction_id", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const dirId = "20200101T000000Z";
  mkdirSync(join(backupRoot, dirId), { recursive: true });
  writeFileSync(
    join(backupRoot, dirId, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: "20200102T000000Z", phase: "preflight", history: [] }),
  );
  const result = withScenario("running", () =>
    runStatus({ repo: workDir }, { ...configWithOverride(), backup_root: backupRoot }),
  );
  assert.equal(result.container.running, true);
  assert.deepEqual(result.doneTransactions, []);
  assert.ok(typeof result.scopeNote === "string" && result.scopeNote !== "");
  assert.ok(result.unfinishedTransaction.error.includes("refusing to guess which is authoritative"));
  assert.equal(result.unfinishedTransaction.directory, join(backupRoot, dirId));
});

test("status still returns a full object when a transaction directory fails the state-machine check", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const dirId = "20200101T000000Z";
  mkdirSync(join(backupRoot, dirId), { recursive: true });
  // Non-empty history is required for PREFLIGHT to be the only phase an
  // empty history is legal at — "archived" with an empty history is a
  // state-machine violation (validateJournalAgainstStateMachine's own
  // "no evidence supports it" branch).
  writeFileSync(
    join(backupRoot, dirId, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: dirId, phase: "archived", history: [] }),
  );
  const result = withScenario("running", () =>
    runStatus({ repo: workDir }, { ...configWithOverride(), backup_root: backupRoot }),
  );
  assert.equal(result.container.running, true);
  assert.ok(result.unfinishedTransaction.error.includes("no evidence supports it"));
  assert.equal(result.unfinishedTransaction.directory, join(backupRoot, dirId));
});

// クロエ round 4 review SF-3: docker itself unreachable must not escape
// as a raw, undiagnosed error — and classify() must not be called a
// second time against the same unreachable daemon.
test("status reports container.error (not a crash) when docker itself is unreachable", () => {
  const brokenBin = join(root, "broken-docker.sh");
  writeFileSync(brokenBin, "#!/bin/sh\necho 'Cannot connect to the Docker daemon.' >&2\nexit 1\n");
  chmodSync(brokenBin, 0o700);
  const priorDocker = process.env.KAOIRO_DEPLOY_DOCKER_BIN;
  process.env.KAOIRO_DEPLOY_DOCKER_BIN = brokenBin;
  let result;
  try {
    result = runStatus({ repo: workDir }, configWithOverride());
  } finally {
    if (priorDocker === undefined) delete process.env.KAOIRO_DEPLOY_DOCKER_BIN;
    else process.env.KAOIRO_DEPLOY_DOCKER_BIN = priorDocker;
  }
  assert.equal(result.container.running, false);
  assert.ok(typeof result.container.error === "string" && result.container.error !== "");
  assert.equal(result.container.branch, undefined, "classify() must not have run a second docker call");
  assert.equal(result.health, null);
});

test("status surfaces an unfinished transaction's id and phase", () => {
  let result;
  withScenario("running-broken-archive", () => {
    try {
      runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
    result = runStatus({ repo: workDir }, configWithCleanStopMeasured());
  });
  const backupRoot = configWithCleanStopMeasured().backup_root;
  const [transactionId] = readdirSyncNonHidden(backupRoot);
  assert.equal(result.unfinishedTransaction.id, transactionId);
  assert.equal(result.unfinishedTransaction.phase, "mount_resolved");
  // issue #220 absorption (turn 8 follow-up): MOUNT_RESOLVED is reached
  // only after ENV_CONSISTENCY_CHECKED, so its recorded observation is
  // already available here.
  assert.deepEqual(result.unfinishedTransaction.envConsistency, {
    skipped: false,
    entries: {
      KAOIRO_USERS_PATH: {
        compose: "/var/lib/kaoiro/users.dets",
        container_effective: "/var/lib/kaoiro/users.dets",
        container_source: "env",
        // issue #322 M5: the old image's own beam probe defaults to
        // "present" in this fixture too, so its own default_path answers
        // this — the common case (a routine update, not the first-ever
        // #310 upgrade).
        assumed_default_source: "old_image",
        declared: null,
        match: true,
      },
    },
  });
});

// issue #220 absorption (turn 8 follow-up): a transaction that has NOT
// yet reached ENV_CONSISTENCY_CHECKED reports null there — an absence,
// not a false "skipped".
test("status reports envConsistency: null for an unfinished transaction that has not reached that phase yet", () => {
  let result;
  withScenario("running-tag-drift", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
    result = runStatus({ repo: workDir }, configWithOverride());
  });
  assert.equal(result.unfinishedTransaction.phase, "preflight");
  assert.equal(result.unfinishedTransaction.envConsistency, null);
});

test("status lists a completed transaction with its source/target SHA and completion time", () => {
  let result;
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    assert.equal(update.phase, "done");
    result = runStatus({ repo: workDir }, configWithCleanStopMeasured());
  });
  assert.equal(result.unfinishedTransaction, null);
  assert.equal(result.doneTransactions.length, 1);
  const [entry] = result.doneTransactions;
  assert.equal(entry.sourceSha, headSha);
  assert.equal(entry.targetSha, headSha);
  assert.deepEqual(entry.envConsistency, {
    skipped: false,
    entries: {
      KAOIRO_USERS_PATH: {
        compose: "/var/lib/kaoiro/users.dets",
        container_effective: "/var/lib/kaoiro/users.dets",
        container_source: "env",
        assumed_default_source: "old_image",
        declared: null,
        match: true,
      },
    },
  });
  assert.ok(typeof entry.doneAt === "string" && entry.doneAt !== "");
});

test("status still lists a DONE transaction (with null facts) when its manifest.json is missing", () => {
  let result;
  const backupRoot = configWithCleanStopMeasured().backup_root;
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    rmSync(join(backupRoot, update.transactionId, "manifest.json"));
    result = runStatus({ repo: workDir }, configWithCleanStopMeasured());
  });
  assert.equal(result.doneTransactions.length, 1);
  const [entry] = result.doneTransactions;
  assert.equal(entry.sourceSha, null);
  assert.equal(entry.targetSha, null);
  // journal.json is untouched, so completion time is still readable
  // independently of the missing manifest.
  assert.ok(typeof entry.doneAt === "string" && entry.doneAt !== "");
});

// クロエ round 4 review SF-4: reworded to what status actually reads
// (container state / health provenance / unfinished phase / DONE
// history) and does not (runner signals, 5-b's ledger migration, the
// REASON behind a runner-side build failure) — the original overclaimed
// full coverage of deployment.md 4.4's branches (0)/(1)/(3)/(4)/(5).
test("status's scopeNote states what it reads and does not, without overclaiming runbook branch coverage", () => {
  const result = withScenario("running", () => runStatus({ repo: workDir }, configWithOverride()));
  assert.ok(result.scopeNote.includes("container state"));
  assert.ok(result.scopeNote.includes("health provenance"));
  assert.ok(result.scopeNote.includes("does not read runner-side signals"));
  assert.ok(result.scopeNote.includes("5-b"));
});

// --- rollback (director ruling 2026-09-06, B-1..B-5) ----------------------

function journalEntry(phase, observation) {
  return { phase, at: "2026-09-06T23:00:00.000Z", observation };
}

test("runRollback requires --transaction", () => {
  assert.throws(() => runRollback({ repo: workDir }, configWithOverride()), DeployError);
});

test("runRollback refuses an unknown transaction id", () => {
  assert.throws(
    () => runRollback({ repo: workDir, transaction: "20200101T000000Z" }, configWithOverride()),
    DeployError,
  );
});

test("runRollback refuses when the directory's journal claims a different transaction_id", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const dirId = "20200101T000000Z";
  writeSyntheticTransaction(backupRoot, dirId, { phase: "old_image_saved" });
  // writeSyntheticTransaction's journal.transaction_id matches its own
  // dir name; overwrite it to disagree.
  const journalPath = join(backupRoot, dirId, "journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.transaction_id = "20200102T000000Z";
  writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(
    () => runRollback({ repo: workDir, transaction: dirId }, configWithOverride()),
    DeployError,
  );
});

test("runRollback refuses a transaction still at PREFLIGHT (not yet eligible)", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const id = "20200101T000000Z";
  const dir = join(backupRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "journal.json"),
    JSON.stringify({
      schema_version: 1,
      transaction_id: id,
      phase: "preflight",
      history: [
        journalEntry("preflight", {
          container: "kaoiro-c1",
          free_bytes: 100000000,
          volume_bytes: 1000000,
          threshold_bytes: 10000000,
        }),
      ],
    }),
  );
  // --confirm-restore: true — see the already-rolled-back test's own
  // comment for why this matters for a clean pin.
  let caught;
  try {
    runRollback({ repo: workDir, transaction: id, confirmRestore: true }, configWithOverride());
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("not eligible for rollback"));
});

test("runRollback refuses an already-rolled-back transaction", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const id = "20200101T000000Z";
  const dir = join(backupRoot, id);
  mkdirSync(dir, { recursive: true });
  const oldSha = "c".repeat(40);
  const history = [
    journalEntry("preflight", {
      container: "kaoiro-c1",
      free_bytes: 100000000,
      volume_bytes: 1000000,
      threshold_bytes: 10000000,
    }),
    journalEntry("old_image_saved", {
      old_image_id: OLD_IMAGE_ID,
      old_sha: oldSha,
      compose_artifact: { path: "/x/docker-compose.yaml", sha256: "a".repeat(64) },
      rollback_tag: `kaoiro-server:rollback-${oldSha}`,
    }),
    journalEntry("rolled_back", {}),
  ];
  writeFileSync(
    join(dir, "journal.json"),
    JSON.stringify({ schema_version: 1, transaction_id: id, phase: "rolled_back", history }),
  );
  // --confirm-restore: true so this actually exercises the eligibility
  // check, not merely the (also-present, but different) confirm gate —
  // without it, both a correct rejection AND a bypassed-eligibility bug
  // that reaches the confirm gate first would equally satisfy a bare
  // "throws DeployError" assertion.
  let caught;
  try {
    runRollback({ repo: workDir, transaction: id, confirmRestore: true }, configWithOverride());
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("not eligible for rollback"));
});

test("runRollback --dry-run previews the non-destructive plan without mutating anything", () => {
  let transactionId;
  withScenario("running", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
  });
  const backupRoot = join(root, "kaoiro-deploy");
  [transactionId] = readdirSyncNonHidden(backupRoot);

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let result;
  try {
    result = withOverrideEnv(() =>
      runRollback({ repo: workDir, transaction: transactionId, dryRun: true }, configWithOverride()),
    );
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.equal(result.dryRun, true);
  assert.equal(result.destructive, false);
  assert.equal(result.phase, "env_consistency_checked");
  assert.deepEqual(readCallLog(logPath), [], "dry-run must not call docker at all");
  // Unchanged — dry-run never touches the journal.
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "env_consistency_checked");
});

test("runRollback refuses without --confirm-restore, naming the path it would take", () => {
  let transactionId;
  withScenario("running", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
  });
  const backupRoot = join(root, "kaoiro-deploy");
  [transactionId] = readdirSyncNonHidden(backupRoot);

  let caught;
  try {
    withOverrideEnv(() => runRollback({ repo: workDir, transaction: transactionId }, configWithOverride()));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("--confirm-restore"));
  assert.ok(caught.message.includes("non-destructive"));
});

test("runRollback (non-destructive) retags latest and starts the old container, reaching rolled_back", () => {
  let transactionId;
  withScenario("running", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
  });
  const backupRoot = join(root, "kaoiro-deploy");
  [transactionId] = readdirSyncNonHidden(backupRoot);

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let result;
  try {
    result = withOverrideEnv(() =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithOverride()),
    );
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.equal(result.destructive, false);
  assert.equal(result.phase, "rolled_back");
  assert.equal(result.restoredImageId, OLD_IMAGE_ID);
  const log = readCallLog(logPath);
  assert.ok(log.includes(`tag ${OLD_IMAGE_ID} kaoiro-server:latest`));
  assert.ok(log.includes(`start ${result.container}`));
  assert.ok(!log.some((l) => l.startsWith("compose up")), "non-destructive rollback must never call compose up");
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "rolled_back");
});

// issue #322 M1 (must-fix): before this fix, the journal read +
// eligibility + destructive-or-not decision all happened BEFORE
// acquireLock. Two concurrent rollback calls for the SAME transaction
// could both read the same still-eligible journal, both decide
// "destructive", and both wipe the volume. Deterministic reproduction
// (ふじ design review round 1, boundaries.patch, adapted here to this
// file's own helpers rather than importing that scratch file directly):
// intercept the EXACT mkdirSync call that creates the lock directory and,
// the first time it fires, run a full SECOND runRollback call for the
// same transaction before letting the real mkdirSync proceed — the
// deterministic equivalent of a second process winning the race right
// before this call's own lock exists.
test("runRollback (destructive) revalidates the journal after acquiring its lock — a same-window concurrent rollback cannot also wipe", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    assert.equal(update.phase, "done");
    transactionId = update.transactionId;
  });

  const flags = { repo: workDir, transaction: transactionId, confirmRestore: true };
  const config = configWithCleanStopMeasured();
  const lockPath = join(backupRoot, `.lock.${deploymentLockKey(join(workDir, "server"))}`);
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;

  const realMkdirSync = fs.mkdirSync;
  let intervened = false;
  const outcomes = [];
  try {
    withScenario("running-clean-stop", () => {
      fs.mkdirSync = (path, ...rest) => {
        if (path === lockPath && !intervened) {
          intervened = true;
          try {
            outcomes.push(runRollback(flags, config).phase);
          } catch (err) {
            outcomes.push(err.message);
          }
        }
        return realMkdirSync(path, ...rest);
      };
      syncBuiltinESMExports();
      try {
        outcomes.push(runRollback(flags, config).phase);
      } catch (err) {
        outcomes.push(err.message);
      }
    });
  } finally {
    fs.mkdirSync = realMkdirSync;
    syncBuiltinESMExports();
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }

  assert.equal(intervened, true, "the lock mkdirSync call was never intercepted — test setup is stale");
  const log = readCallLog(logPath);
  const wipes = log.filter((l) => l.includes("find /data -mindepth"));
  assert.equal(wipes.length, 1, `expected exactly 1 wipe, outcomes=${JSON.stringify(outcomes)}`);
  assert.equal(readJournal(join(backupRoot, transactionId)).phase, "rolled_back");
});

test("runRollback (destructive) runs the full stop/forensic/restore/retag/up/health chain, reaching rolled_back", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    assert.equal(update.phase, "done");
    transactionId = update.transactionId;
  });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let result;
  try {
    result = withScenario("running-clean-stop", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.equal(result.destructive, true);
  assert.equal(result.phase, "rolled_back");
  assert.equal(result.restoredImageId, OLD_IMAGE_ID);
  assert.ok(result.health, "expected a health poll result for the destructive path");

  const log = readCallLog(logPath);
  assert.ok(log.some((l) => l.startsWith("stop -t 30 sha256:")));
  assert.ok(log.includes(`tag ${OLD_IMAGE_ID} kaoiro-server:latest`));
  assert.ok(log.some((l) => l.includes(" up") && l.includes("--force-recreate")));
  const recoveryComposeFile = join(backupRoot, transactionId, "recovery-compose.yaml");
  const recoveryPrefix = `compose -f ${recoveryComposeFile} --project-directory ${join(workDir, "server")}`;
  assert.ok(log.some((l) => l.startsWith(`${recoveryPrefix} config`)));
  assert.ok(!log.some((l) => l.startsWith(`${recoveryPrefix} stop`)));
  assert.ok(log.some((l) => l.startsWith(`${recoveryPrefix} up`) && l.includes("--force-recreate")));

  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "rolled_back");
  for (const phase of [
    "rollback_stopped",
    "rollback_forensic_archived",
    "rollback_restoring",
    "rollback_restored",
    "rolled_back",
  ]) {
    assert.ok(journal.history.some((e) => e.phase === phase), `expected a ${phase} checkpoint`);
  }
  // SF-9: the checkpoint's own observation is self-contained (not "trust
  // the prior entry") — both the forensic archive and the pre-deploy
  // archive it is about to restore from are recorded with it.
  const restoring = journal.history.find((e) => e.phase === "rollback_restoring").observation;
  assert.ok(existsSync(restoring.forensic_archive.path));
  assert.equal(restoring.restore_from.path, readManifest(join(backupRoot, transactionId)).archive.path);
  assert.equal(restoring.restore_from.sha256, readManifest(join(backupRoot, transactionId)).archive.sha256);
  assert.ok(existsSync(join(backupRoot, transactionId, "rollback-forensic.tar.gz")));
});

test("runRollback refuses a recorded target plan whose project identity differs from recovery", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    transactionId = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    ).transactionId;
  });
  const dir = join(backupRoot, transactionId);
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.target_plan.identity.project_name = "different-project";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithCleanStopMeasured()),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.match(caught.message, /migration work, not a rolling update/);
  const log = readCallLog(logPath);
  assert.ok(!log.some((line) => line.includes(" compose stop")));
  assert.ok(!log.some((line) => line.includes("find \/data -mindepth")));
});

test("runRollback does not restore when the recorded target container remains running", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    transactionId = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    ).transactionId;
  });
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("rollback-target-remains-running", () =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithCleanStopMeasured()),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.match(caught.message, /not confirmed stopped/);
  assert.ok(!readCallLog(logPath).some((line) => line.includes("find \/data -mindepth")), "must not restore a live volume");
});

test("runRollback stops the union of target and recovery compose candidates", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    transactionId = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    ).transactionId;
  });
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let result;
  try {
    result = withScenario("rollback-id-mismatch", () =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithCleanStopMeasured()),
    );
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.equal(result.phase, "rolled_back");
  const log = readCallLog(logPath);
  assert.ok(log.includes("stop -t 30 sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));
  assert.ok(
    log.includes("inspect sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee --format {{.State.Running}}"),
  );
  assert.ok(!log.some((line) => line.includes(" compose stop")));
});

test("runRollback restores a STARTING transaction when compose up failed after creating a container", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const failureFile = join(root, "first-up-failed");
  const priorFailureFile = process.env.KAOIRO_TEST_UP_FAILURE_FILE;
  process.env.KAOIRO_TEST_UP_FAILURE_FILE = failureFile;
  let caught;
  try {
    withScenario("up-fails-container", () => {
      try {
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured());
      } catch (err) {
        caught = err;
      }
    });
    assert.ok(caught);
    const [transactionId] = readdirSyncNonHidden(backupRoot);
    assert.equal(readJournal(join(backupRoot, transactionId)).phase, "starting");

    const result = withScenario("up-fails-container", () =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithCleanStopMeasured()),
    );
    assert.equal(result.phase, "rolled_back");
    assert.equal(result.destructive, true);
  } finally {
    if (priorFailureFile === undefined) delete process.env.KAOIRO_TEST_UP_FAILURE_FILE;
    else process.env.KAOIRO_TEST_UP_FAILURE_FILE = priorFailureFile;
  }
});

test("runRollback restores a STARTING transaction when compose up created no container", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  const failureFile = join(root, "first-up-failed");
  const priorFailureFile = process.env.KAOIRO_TEST_UP_FAILURE_FILE;
  process.env.KAOIRO_TEST_UP_FAILURE_FILE = failureFile;
  let caught;
  try {
    withScenario("up-fails-no-container", () => {
      try {
        runUpdate({ repo: workDir, target: headSha, maintenanceApproved: true }, configWithCleanStopMeasured());
      } catch (err) {
        caught = err;
      }
    });
    assert.ok(caught);
    const [transactionId] = readdirSyncNonHidden(backupRoot);
    assert.equal(readJournal(join(backupRoot, transactionId)).phase, "starting");

    const result = withScenario("up-fails-no-container", () =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithCleanStopMeasured()),
    );
    assert.equal(result.phase, "rolled_back");
    assert.equal(result.destructive, true);
  } finally {
    if (priorFailureFile === undefined) delete process.env.KAOIRO_TEST_UP_FAILURE_FILE;
    else process.env.KAOIRO_TEST_UP_FAILURE_FILE = priorFailureFile;
  }
});

test("runRollback restores when the target container has already exited", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    transactionId = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    ).transactionId;
  });
  const stopFile = join(root, "stopped-before-rollback");
  writeFileSync(stopFile, "");
  const priorStopFile = process.env.KAOIRO_TEST_STOP_FILE;
  process.env.KAOIRO_TEST_STOP_FILE = stopFile;
  try {
    const result = withScenario("running-clean-stop", () =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithCleanStopMeasured()),
    );
    assert.equal(result.phase, "rolled_back");
  } finally {
    if (priorStopFile === undefined) delete process.env.KAOIRO_TEST_STOP_FILE;
    else process.env.KAOIRO_TEST_STOP_FILE = priorStopFile;
  }
});

test("runRollback refuses before wiping when a container remains running after stop", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    transactionId = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    ).transactionId;
  });
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("rollback-target-remains-running", () =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithCleanStopMeasured()),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.match(caught.message, /not confirmed stopped/);
  assert.ok(!readCallLog(logPath).some((line) => line.includes("find \/data -mindepth")));
});

test("runRollback rechecks that compose reports no running container before wiping", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    transactionId = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    ).transactionId;
  });
  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("rollback-running-reappears", () =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithCleanStopMeasured()),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.match(caught.message, /compose still reports running/);
  assert.ok(!readCallLog(logPath).some((line) => line.includes("find \/data -mindepth")));
});

test("runRollback (destructive) refuses when the pre-deploy archive no longer matches its recorded sha256", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  const dir = join(backupRoot, transactionId);
  // Tamper with the pre-deploy archive AFTER it was recorded — the exact
  // "changed archive" scenario the mutation pin below exists to catch.
  writeFileSync(join(dir, "archive.tar.gz"), Buffer.concat([readFileSync(join(dir, "archive.tar.gz")), Buffer.from("tampered")]));

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("does not match its recorded sha256"));
  // issue #322 M3: refused as part of the pre-destructive recovery-pair
  // check now — BEFORE stopping the container at all, not merely before
  // the wipe. Journal stays at "done" (the state runUpdate itself left
  // it in); no rollback checkpoint is ever written.
  const journal = readJournal(dir);
  assert.equal(journal.phase, "done");
  const log = readCallLog(logPath);
  assert.ok(!log.some((l) => l.startsWith("compose stop")), "must refuse before stopping the container");
});

// クロエ round 4 review B-1 (expanded, e3785ba3 measurement): only the
// sha256 comparison had a dedicated pin — the pre-deploy archive's own
// full-traversal check, the forensic archive's own verification, the
// restored-volume comparison's END-TO-END wiring, the 2+-container
// refusal, and BOTH paths' retag read-back were all silently unpinned
// (mutation showed 191/191 unchanged). Each gets its own test below.

test("runRollback (destructive) refuses when the pre-deploy archive fails full-traversal verification, even with a matching sha256", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  const dir = join(backupRoot, transactionId);
  const archivePath = join(dir, "archive.tar.gz");
  // Corrupt the archive AND fix up the recorded sha256 to match the
  // corrupt bytes — the sha256 check must PASS (same as production data
  // silently corrupted after being archived), isolating this guard from
  // the sha256-mismatch guard already pinned above.
  const corrupt = Buffer.from("not a real gzip stream");
  writeFileSync(archivePath, corrupt);
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.archive.sha256 = createHash("sha256").update(corrupt).digest("hex");
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("failed full-traversal verification"));
  // issue #322 M3: same pre-destructive recovery-pair check as the
  // sha256-mismatch test above — refused before stopping anything.
  const journal = readJournal(dir);
  assert.equal(journal.phase, "done");
  const log = readCallLog(logPath);
  assert.ok(!log.some((l) => l.startsWith("compose stop")), "must refuse before stopping the container");
});

test("runRollback (destructive) refuses when the forensic archive of the current volume state fails verification", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  let caught;
  try {
    withScenario("rollback-forensic-corrupt", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("forensic archive"));
  // Refused before even the FORENSIC checkpoint — the archive it just
  // wrote failed its own verification before advancing past it.
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "rollback_stopped");
});

test("runRollback (destructive) refuses end to end when the restored volume drifts from the recorded required_entries", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  let caught;
  try {
    withScenario("rollback-restore-drifts", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("do not match the recorded required_entries"));
  // Advanced to ROLLBACK_RESTORING (SF-9's checkpoint right before the
  // wipe) before the wipe+restore ran — the drift is only detectable
  // AFTER that, so RESTORED itself is correctly never reached.
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "rollback_restoring");
});

test("runRollback (destructive) refuses when its durable recovery compose file no longer matches the old revision", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  const recoveryPath = join(backupRoot, transactionId, "recovery-compose.yaml");
  writeFileSync(recoveryPath, "# tampered after the update this rollback targets\n");

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError, `expected a DeployError, got: ${caught}`);
  assert.match(caught.message, /recovery compose file .* no longer matches old image revision/);

  const log = readCallLog(logPath);
  assert.ok(!log.some((l) => l.startsWith("compose stop")), "must refuse before stopping the container");
  assert.ok(!log.some((l) => l.includes("find /data -mindepth")), "must refuse before wiping the volume");
  // Refused before the FIRST rollback checkpoint — still "done", exactly
  // like the multiple-containers refusal right below.
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "done");
});

test("runRollback (destructive) refuses before stopping when the recovery .env bytes drift", () => {
  const backupRoot = join(root, "kaoiro-deploy");
  writeFileSync(join(workDir, "server", ".env"), "KAOIRO_UNUSED=before\n");
  let transactionId;
  withScenario("running-clean-stop", () => {
    transactionId = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    ).transactionId;
  });
  writeFileSync(join(workDir, "server", ".env"), "KAOIRO_UNUSED=after\n");

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("running-clean-stop", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError);
  assert.match(caught.message, /recovery effective compose plan env_sha256 has changed/);
  const log = readCallLog(logPath);
  assert.ok(!log.some((l) => l.includes(" stop")), "must refuse before stopping the container");
  assert.equal(readJournal(join(backupRoot, transactionId)).phase, "done");
});

// issue #322 M3 (must-fix): before this fix, rollback's destructive path
// went stop -> forensic -> wipe -> restore, first touching the old image
// at the retag right at the end — a missing image was discovered only
// AFTER the volume had already been wiped and restored, leaving the
// journal at rollback_restored with nothing able to serve it. The image,
// archive, and compose config are now verified as one recovery PAIR
// before any of stop/forensic/wipe runs.
test("runRollback (destructive) refuses when the old image no longer exists, before touching anything", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("rollback-missing-old-image", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError, `expected a DeployError, got: ${caught}`);
  assert.match(caught.message, /no longer exists/);

  const log = readCallLog(logPath);
  assert.ok(!log.some((l) => l.startsWith("compose stop")), "must refuse before stopping the container");
  assert.ok(!log.some((l) => l.includes("find /data -mindepth")), "must refuse before wiping the volume");
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "done");
});

test("runRollback (destructive) refuses when docker-compose.yaml does not render, before touching anything", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  const logPath = join(root, "docker-calls.log");
  process.env.KAOIRO_TEST_CALL_LOG = logPath;
  let caught;
  try {
    withScenario("rollback-compose-config-broken", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  } finally {
    delete process.env.KAOIRO_TEST_CALL_LOG;
  }
  assert.ok(caught instanceof DeployError, `expected a DeployError, got: ${caught}`);
  assert.match(caught.message, /could not render the effective compose plan/);

  const log = readCallLog(logPath);
  assert.ok(!log.some((l) => l.startsWith("compose stop")), "must refuse before stopping the container");
  assert.ok(!log.some((l) => l.includes("find /data -mindepth")), "must refuse before wiping the volume");
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "done");
});

test("runRollback stops every stopped-or-running candidate currently associated with the service", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  const result = withScenario("multiple-containers", () =>
    runRollback(
      { repo: workDir, transaction: transactionId, confirmRestore: true },
      configWithCleanStopMeasured(),
    ),
  );
  assert.equal(result.phase, "rolled_back");
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "rolled_back");
});

test("runRollback (destructive) refuses when the retag read-back disagrees with the old image id", () => {
  let transactionId;
  const backupRoot = join(root, "kaoiro-deploy");
  withScenario("running-clean-stop", () => {
    const update = runUpdate(
      { repo: workDir, target: headSha, maintenanceApproved: true },
      configWithCleanStopMeasured(),
    );
    transactionId = update.transactionId;
  });

  let caught;
  try {
    withScenario("retag-drift", () =>
      runRollback(
        { repo: workDir, transaction: transactionId, confirmRestore: true },
        configWithCleanStopMeasured(),
      ),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("could not restore kaoiro-server:latest"));
  // Reached ROLLBACK_RESTORED (the restore itself succeeded) but never
  // advanced to ROLLED_BACK — the retag is the LAST gate.
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "rollback_restored");
});

test("runRollback (non-destructive) refuses when the retag read-back disagrees with the old image id", () => {
  withScenario("running", () => {
    try {
      runUpdate({ repo: workDir, target: headSha }, configWithOverride());
    } catch (err) {
      assert.ok(err instanceof DeployError);
    }
  });
  const backupRoot = join(root, "kaoiro-deploy");
  const [transactionId] = readdirSyncNonHidden(backupRoot);

  let caught;
  try {
    withScenario("retag-drift", () =>
      runRollback({ repo: workDir, transaction: transactionId, confirmRestore: true }, configWithOverride()),
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof DeployError);
  assert.ok(caught.message.includes("could not restore kaoiro-server:latest"));
  // Never advanced to ROLLED_BACK — still wherever it was before rollback.
  const journal = readJournal(join(backupRoot, transactionId));
  assert.equal(journal.phase, "env_consistency_checked");
});
