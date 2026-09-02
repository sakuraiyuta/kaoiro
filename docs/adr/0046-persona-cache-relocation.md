---
title: Externalize the extraction cache from the persona ingestion directory
status: accepted
date: 2026-08-03
opened: 2026-08-03
supersedes: []
superseded_by: null
related_specs: [persona-pack-schema, deployment]
related_adrs: [29, 45]
---

# ADR-0046 — Externalize the extraction cache from the persona ingestion directory

## Status

Accepted (2026-08-03, decided through a discussion between クロエ, delegated by
マスター, and ふじ). Partially revises the cache description in F2 / F6 of
[ADR-0029](0029-persona-server-sot-and-pack-distribution.md).

## Context

kaoiro issue #173. `PersonaAssets.build/0` runs `mkdir_p!`, extracts zips, and
deletes stale entries under `<KAOIRO_PERSONA_DIR>/.cache`. This conflicts with
the compose `:ro` overlay example and breaks cold start when the persona dir is
`:ro`. The problem was found during review of ADR-0045.

## Decision

### F1: Separate the cache root outside the persona dir

Specify the cache root with the new env `KAOIRO_PERSONA_CACHE_DIR`. When unset,
use `"kaoiro-persona-cache-<sha256(Path.expand(persona_dir)) の先頭16hex>"`
under `System.tmp_dir!()` as the default. The cache is a regenerable derivative
of the zips, so loss of tmp data is acceptable. Derive the hash from the expanded
path so that differences in relative paths or cwd do not change the namespace.

### F2: Eliminate all writes to the persona dir

`PersonaAssets.build/0` does not write to the persona dir. Remove `mkdir_p!` from
`PersonaWatcher.init` as well. If the ingestion directory is missing, warn, start
with an empty manifest, and disable watching. Enabling it after the directory is
created requires a restart.

### F3: Limit reclaim to cache-key-shaped entries

Reclaim deletes only entries matching the 16-hex cache-key form. This protects
unrelated directories under a mistakenly specified root.

**Addendum (issue #185 must-fix 2, 2026-08-05):** Orphan reclaim in the staging
area (`reclaim_stage_orphans/1`, see F9) follows the same principle. Reclaim
targets only entries whose name **exactly matches** `.stage-` followed by a
22-character random suffix (charset `A-Za-z0-9_-`), using
`~r/^\.stage-[A-Za-z0-9_-]{22}\z/` — not a loose prefix match (a condition that
accepts anything beginning with `.stage-`). Entries such as `.stage-important`
or `.stage-freshtest` that share the prefix but not the exact shape are treated
as persistent and reclaim must never delete them. Use `\z`, not `$`: Elixir/Erlang
`re` follows PCRE conventions, and without `/m`, `$` also matches immediately
before one final newline. An internal review found that this allowed the
(unproducible) shape `.stage-<22文字>\n` to evade exact matching (2026-08-05;
the implementation was fixed, and ふじ pointed out and corrected the stale ADR
wording in round-3).

### F4: Separate the cache failure contract

If the cache root cannot be created or written during cold start, fail fast by
raising. If a rebuild fails while running, retain the current manifest as
last-known-good.

Classify rebuild failures as cache-volume failures for these POSIX atoms:
`:erofs` / `:enospc` / `:edquot` / `:eio` / `:eperm` / `:emfile` / `:enfile` /
`:enomem` / `:enodev` / `:estale`. Raise on cold start and retain
last-known-good while running. `:eacces` is ambiguous because `:zip.unzip` also
reads zips from the ingest dir; classify it as a cache failure only when the path
in the error term is under the cache root.

Treat `:enotdir` / `:eloop` / `:eisdir` / `:einval` / `:enoent` caused by archive
shape as pack errors and skip them. Examples include a zip in which entry `a`
conflicts with `a/b`, or a zip that contains `sprites` as a regular file.

**Addendum (2026-08-04): handling failures in cache-slot operations (delete,
create, and narrowing).** The errno table above is for classifying failures in
cache **reads and writes**, and does not apply unchanged when the slot
`<cache_root>/<hash>` itself cannot be deleted, created, or narrowed to
owner-only mode (chmod).

The reason is that `:eperm` / `:eacces` / `:eexist` / `:enotdir` can occur simply
because **another OS user placed one slot** in a shared cache root (an explicitly
configured root that is group/world-writable produces only a warning). Removing a
foreign non-empty slot requires two levels of permission: permission to unlink
children in the slot depends on the slot directory's own write/execute bits, while
permission to remove the now-empty slot depends on the cache root. Thus, even when
the root is writable, a non-empty slot owned by another user without write bits
cannot be deleted. Classifying this as a cache failure would let one placed
directory stop ingestion of every pack and raise on cold start — the opposite of
ADR-0029's rule that one invalid drop must not stop everything.

Therefore, for failures to delete, create, or narrow a slot, **probe-write the
cache root again**, and classify as follows:

- if the root is still writable and the reason is one of `:eperm` / `:eacces` /
  `:eexist` / `:enotdir` → **skip only that pack** (pack error)
- otherwise (`:eio` / `:estale` / `:enospc` / `:erofs`, etc.), or if the root
  itself is not writable → **cache failure** (as in the table)

Slot-specific I/O failures and stale NFS handles leave the root unharmed, so
using only the root probe would turn into “silently publish a manifest missing the
pack.” The errno limitation is retained for this reason.

### F5: Do not guarantee sharing one persona dir across processes

Do not guarantee a configuration in which multiple server processes share the
same persona dir. In that case, specify a different `KAOIRO_PERSONA_CACHE_DIR`
for each process. Configure `/var/lib/kaoiro/persona-cache` in compose.

### F6: Harden the default tmp root as a predictable shared path

Set `0o700` only on the default root with `File.chmod`. Use the fact that chmod
returns `:eperm` for a non-owner as an effective ownership check. lstat the root
and reject it if it is a symlink. Create the write probe with O_EXCL using
`:write + :exclusive`. Apply this lstat symlink rejection and O_EXCL write probe to
both default and explicitly specified roots.

Treat an explicitly specified root as a trust boundary that delegates the safety
decision to the operator. Do not force chmod on an explicit root, since the server
could damage a shared volume or orchestrator configuration. Only warn for an
explicit root that is group/world-writable. Deduplicate the warning once per
`(root, mode)` to avoid constant warnings (consistent with ADR-0045 F5).

This mitigates preemptive attacks against a predictable shared `/tmp` path, such
as truncating through a symlink or injecting a fake pack for prompt injection.

**Addendum (2026-08-04): slot safety contract.** Preparation and extraction of a
slot(`<cache_root>/<hash>`) must satisfy the following. (1) Detect and reject
special types (such as symlinks) at the slot root and inside the slot with lstat —
the read path never follows anything other than regular files and directories.
(2) Create the slot with an exclusive mkdir (a `mkdir_p` equivalent is forbidden
because it treats an existing symlink as success). (3) Narrow the slot to
owner-only (0700) **before extraction**, and normalize entry modes to owner-only
after extraction — never adopt modes declared by the archive. These are safety
contracts, not implementation details; relaxing them requires revising this ADR.

### F7: Reject zip slip before extraction

Validate every zip entry name with `Path.safe_relative/1` before extraction. If
even one name is rejected, reject the entire pack and do not begin extraction.

Moving the cache onto the same `/var/lib/kaoiro` volume as the authentication DETS
ledger broadened the impact of path traversal. OTP's own `:zip.unzip` also rejects
illegal paths (measured on OTP 29.0.2), but pre-validation provides defense in
depth independent of implementation details and rejection before any write begins.

### F8: Reject excessive extracted size and entry count before extraction

Limit the total extracted size of a pack to **1 GiB (1_073_741_824 byte)** and
the number of entries to **4096**. If either limit is exceeded, reject the pack
without beginning extraction and skip only that pack (ADR-0029). Treat exceeding
a limit as an explicit inspection result rather than an errno; it does not affect
the F4 errno classification.

マスター decided the limits on 2026-08-04. 1 GiB is a margin allowing for
high-resolution images and future extensions (such as 3D models), interpreted as
the binary prefix (1024^3). The 4096-entry limit blocks packs whose total size is
small but whose entry count alone is enormous (inode exhaustion and extraction-
time attacks), while leaving enough room not to reject legitimate packs (a few
dozen sprites to a few hundred for 3D). Count directory entries as one entry too.

**Do not use the declared uncompressed size.** The extracted size returned by
`:zip.list_dir/1` is the declared value in the local header and central directory,
which an attacker can write freely. `:zip.unzip/2` does not consult this declaration
at all and extracts the actual data to the end — measurement on OTP 29.0.2 wrote
10,000,000 bytes without error from an entry declared as 100 bytes in both headers.
Therefore, measure the size limit by actually inflating the raw deflate stream
before extraction. Do not write the output; feed and discard it in fixed 64 KiB
chunks while accumulating only the byte count, keeping memory constant even for a
single huge entry. Stop immediately on reaching the limit, also mitigating
extraction-time attacks.

This decision rejects the original proposal for issue #179 (“inspect the extracted
size returned by `:zip.list_dir/1`”) based on measurement. The reason for rejection
is fixed here so it is not later reopened as “would list_dir be sufficient?”.

**The local header is authoritative for method and flag.** Measurement on OTP
29.0.2 shows that `:zip.unzip/2` extracts using the compression method in the
local header (an entry with STORE in central and DEFLATE locally was inflated, and
the reverse was rejected). Reading method from central would create a bypass
analogous to the declared-size issue, so do not consult central's method. Reject
encrypted entries (general purpose bit 0) because their actual size cannot be
measured by inflation — the same OTP ignores the encryption bit and writes the
ciphertext unchanged, so it cannot be passed through. Reject methods other than
DEFLATE and STORE in the same way.

**Measure data descriptors (general purpose bit 3) using central-directory
comp_size.** When bit 3 is set, the local-header size is a placeholder and OTP
extracts using central-directory comp_size (stdlib 8.0.1 `zip.erl`
`get_z_file/9`: `GPFlag band 8 =:= 8 -> ZipFile#zip_file.comp_size`). Take the
measured read span from the same field. An implementation that reads only the
local header counts the entry as 0 bytes and lets it bypass the limit — measurement
with csize 0 locally and the true value centrally read 0 bytes, while
`:zip.unzip/2` wrote 10,000,000 bytes (measured). Do not reject bit 3 because
streaming zip writers (Java `ZipOutputStream`, Go `archive/zip`, etc.) set it
routinely; read the same field as the extractor. Take the flag used for the
decision from the local header itself (also matching `get_z_file/9`), so a flag set
only in central cannot switch the source of trust.

**Resolve ZIP64 sentinels with the local extra field.** When a 32-bit size field is
`0xffffffff`, the real size is in the ZIP64 extended information extra field (id
0x0001). When bit 3 is absent, OTP resolves this on the local side before
extraction, so measurement also reads the local extra (do not substitute central —
without bit 3, local is authoritative and can differ from central).

The reader must use **the same loop as OTP's `update_zip64/2`**. This record is not
a fixed layout that can be indexed; after consuming 8 bytes, reevaluate whether
that field is still a sentinel. If the 64-bit value itself is `0xffffffff`, OTP
consumes another 8 bytes as the same field. Reading a fixed position therefore
takes comp_size one field too early. Measurement (using reduced limits for a
practical test size) placed three 64-bit fields in the payload: the fixed-position
version misread the second value as comp_size and measured a tiny value, while
`:zip.unzip/2` read the third as authoritative and extracted 1 MB. The test fixes
the limit at 999,999 bytes to demonstrate the bypass. The ratio scales directly,
so the same construction can scale beyond 1 GiB of extracted data and bypass the
production limit in the same way.

Accordingly, the authoritative compressed size is selected in this order: bit 3
set → central-directory comp_size / bit 3 clear and 32-bit value is a sentinel →
local ZIP64 extra (resolved by the loop above) / otherwise → local-header 32-bit
field.

**Bound enumeration itself before enumeration.** All of the size and count checks
above operate on the result of `:zip.list_dir/1`, but they are meaningless unless
`list_dir` itself is bounded. OTP materializes the entire central directory, so a
1 GiB archive can require several GB of BEAM heap (measured: 203 MB / 5.7 seconds
for 400,000 entries). Therefore, read the EOCD (end of central directory) **before**
`list_dir` and bound it using three declared values. Use each only to reject when
the declaration exceeds a limit; never use it as a reason to trust the declaration.

| declared value | why it provides a bound |
|---|---|
| entry count | `get_central_dir/4` passes `N = EOCD#eocd.entries` directly as the loop count to `get_cd_loop/6` (stdlib 8.0.1 `zip.erl` 1916-1921). An under-declaration can only **reduce** enumeration, not increase it (measured: an archive with 400,000 entries declaring 10 finishes enumeration in 1 ms. `list_dir` returns 11 elements, consisting of 10 `:zip_file` entries + one `:zip_comment`; only the former count toward the entry limit). An over-declaration throws `bad_central_directory` when the file runs out |
| `filesize - 申告 central offset` | `get_cd_loop/6` seeks to the declared offset and only reads forward, so this bounds the bytes enumeration can touch. An under-declared offset makes this span **larger** and is rejected early; an over-declared offset throws because no record exists at the seek target |
| declared ZIP64-record body length | After reading the 12 bytes at the locator, `find_eocd64/5` reads the declared byte count **before obtaining the central offset** (`zip.erl` 2121-2138). Without bounding this stage, a record placed at the front of the file can declare a huge body while declaring a central offset near EOF, so the read has already completed when the span check passes |

**Do not use the declared central-directory size.** OTP never reads this field, so
bounding it bounds nothing.

**Use one 4 MiB budget (`@max_entries * 1024`).** Even at the 4096-entry limit, a
healthy pack's central directory is about 800 KB (fixed 46 bytes + roughly 100 for
name + roughly 30 for extra), leaving about five times of headroom. Add the central-
directory tail and declared ZIP64-record length **together** against this one
budget — separate budgets would allow the same limit to be spent twice, and “how
much can enumeration cost?” is inherently a question about the total.

**Entry count alone does not close the hole.** `get_cd_loop/6` reads name + extra +
comment for each entry, each with a 16-bit length, so one entry can pull up to 192
KB. OTP also returns name and comment as charlists, which expand to 16 bytes per
character on a 64-bit VM. Measurement (OTP 29.0.2): 500 entries with 64 KB names
used 31 MB on disk versus 516 MB of heap, a 16.5× amplification. Extrapolated to
the entry limit, a 268 MB pack would require about 4.2 GB and **would hit neither
the 1 GiB archive limit nor the 4096-entry limit**. The span bound closes this path;
at 4 MiB the same amplification fits in about 66 MB.

**Copy OTP's EOCD search procedure.** An independent implementation can choose a
different position when decoys are planted. OTP scans one byte at a time **forward**
from `eof - window` and takes the first structural match, doubling the window when
it misses (22 → 44 → ... → min(0xffff+42, filesize)). Conventional backward
scanning takes the last record, so the two implementations can rely on different
EOCDs. Copy the asymmetry that combines `entries_on_disk` and `entries` with AND
only in the section with a locator. Use **OTP's macro value**, not the field width
from the ZIP specification — the locator is physically 20 bytes, but
`?END_OF_CENTRAL_DIR_64_LOCATOR_SZ` is `(4+8+4)` = 16 (`zip.erl`:253), and the
implementation uses that value. Using the specification's 20 makes the search
window 4 bytes wider than OTP's; the lookahead alone can then choose a decoy at a
position OTP never examines and invalidate all three bounds at once (reproduced
by measurement). The scan window itself (up to about 131 KB over the entire
doubling loop) cannot be scaled by an attacker and is outside the budget.

**Bound STORE by the archive's own size.** DEFLATE closes at the stream terminator,
but STORE has no terminator and its length exists only in a forgeable declaration.
The unforgeable value is the archive file size. STORE does not expand, so binding
the archive itself to the same 1 GiB limit also keeps STORE-derived extraction
within the limit. For accounting, add a STORE entry using the comp_size selected by
the priority above. An under-declaration cannot bypass this — the extractor also
reads only that same comp_size, so actual writes are reduced by the same amount
(a data-descriptor form with csize 0 in **both** local and central is rejected as
an entire archive by OTP, measured for both DEFLATE / STORE. If central retains the
true value, extraction succeeds; therefore central is authoritative for comp_size
of a bit-3 entry as above).

**Prefer cheap rejection in the inspection order.** Archive size → central metadata
preflight (entry count / span / ZIP64 body length, before `:zip.list_dir/1`) → zip
slip / local-header consistency (F7) → measured inflation. Do not spend up to 1 GiB
of inflation CPU on a zip bomb with traversal that can be rejected by its names
alone. Both F7 and this inspection layer perform no writes, and this invariant is
maintained regardless of changes to the order.

### F9: Close the preflight/extraction TOCTOU gap with staging (issue #185, ふじ 2026-08-05 spec)

The F7 / F8 preflight (`verify_archive/1`) and `:zip.unzip/2` originally opened
the `zip_path` controlled by the ingest writer independently — the inspection
itself reopened `:zip.list_dir/1` twice and `File.open(raw)` several times, and
including extraction's `:zip.unzip/2` meant reopening the same path at least five
times in total. There was no guarantee that both saw the same bytes, so a party
able to write to the ingest dir could replace the archive after inspection and
before extraction, invalidating both F7 and F8 (the old Negative statement,
resolved below).

**Mitigations considered.** (a) Pass one binary read to both preflight and
extraction — with a 1 GiB limit, reading all at once would break the existing
64 KiB streaming design (F8) and itself create a new memory DoS, so reject it.
(b) Re-hash immediately after preflight — narrows the window but does not close
it, so reject it. (c) Use OTP's fd-retaining `:zip.zip_open/2` API throughout —
stdlib 8.0.1 source confirms that `zip_open` calls `file:open` once for a path and
then `zip_get`/`zip_list_dir` use only pread/read on the same fd without reopening,
but `zip_get/1` (without the memory option) writes each entry directly to disk and
cannot “measure only the extracted size without retaining the contents.” Rebuilding
F8's streaming-inflate measurement through this API, or replacing `:zip.unzip/2`
with a custom implementation, is excessive for this issue's severity (Low), so
reject it (it may be revisited if severity increases).

**Adopted method.** Copy the archive read from ingest into a private staging area
under the trusted cache root, which the ingest writer cannot touch (temporary dir
from exclusive mkdir 0700 + file from exclusive create 0600; the basename is a
random value solely for collision avoidance, not a security boundary). Open the
source **exactly once**, then perform a 64 KiB-chunk **bounded copy** from that fd
(limit `limit + 1` byte, with one extra byte to distinguish exactly-at-limit from
over-limit, and read no further). Compute SHA-256 on the same pass and compare the
**full digest on the staged side** with the **full digest precomputed for
identification**. If they differ, conclude that the source changed during ingest,
**skip the pack as a race** (log wording that distinguishes it from a malformed
archive), and retry on the next watcher-triggered rebuild. If they match, all later
F7 / F8 preflight and `:zip.unzip/2` operations inspect **only the staged file**;
never touch the original ingest path again.

**What this method guarantees.** An opened fd is bound to the original inode, so
renaming/relinking the ingest-side path after copy begins does not affect the
already-open fd (a general POSIX property). **However, truncation/overwrite of the
same inode is observable** — if the original file is rewritten on the same inode
before the copy completes, the staged side may contain a mixture of old and new
bytes. This does not mean that “the fd guarantees a point-in-time snapshot of the
source.” The guarantee is consistency: preflight and extraction see the same,
stable artifact generated by the **bounded copy**, which cannot change afterward.
Even if mixed bytes are staged, F7 / F8 and `:zip.unzip/2` consistently inspect and
extract that entire staged artifact, so safety is not broken (an invalid shape is
rejected, while a valid shape is extracted consistently).

**This guarantee holds only inside the trust boundary.** It assumes that the
ingest writer cannot write to the cache root (the same assumption as F6's trust
boundary). As F6 states, making an explicitly specified cache root
group/world-writable is left to the operator; such a root can make the staging
area reachable by the ingest writer, so this section's guarantee does not apply.

**Stage cleanup.** Delete the generated staging area on every path: success, pack
error, cache error, and exception raise. For normal return values (success / pack
error / cache error), merge the cleanup result with `merge_cleanup_error/2` and
return it. `rescue` covers only exceptions (error exceptions raised by `raise`);
after cleanup, `reraise` them. This layer uses `try`/`rescue`, not `try`/`after`,
and does not catch throw / exit (untrappable termination including those cases is
handled by the orphan reclaim below as the last line of defense).

To cover cases such as a VM crash where the deletion itself did not run, reclaim
orphans whose names exactly match the pattern through the random suffix of
`.stage-*` (issue #185 ふじ round-2 review, 2026-08-05). Initially an age-gate of
10 minutes protected them because `rebuild/0` had no global lock and needed to
avoid cleaning staging areas still in use by another concurrent rebuild.
**must-fix 1** serialized `rebuild/0` itself through
`KaoiroServer.PersonaRebuildLock`, guaranteeing that only one rebuild runs at a
time in this BEAM node. No live staging area can therefore exist when `build/1`
starts. Remove the age-gate, move the call to `reclaim_stage_orphans/1` to the
start of `build/1` (before pack processing), and immediately reclaim entries
matching F3's exact name pattern without a condition.

Measurement also confirmed that the source for entry enumeration by
`:zip.unzip/2` is the central directory (local entries absent from central are not
extracted). Counting entries from the central directory therefore matches the
extractor's behavior.

## Consequences

### Positive

- Cold start works even when the persona dir is mounted read-only.
- The persona pack's source of truth and the write destination for regenerable
  extracted data are separated.
- Failure to create the cache root fails clearly at startup, while a transient
  failure during operation preserves the existing manifest.
- An attack that fills the cache volume with one highly compressed pack (a zip
  bomb) is blocked before extraction begins. Because the cache shares a volume
  with the authentication DETS ledger, this also prevents degradation of the
  revocation store (F8).

### Negative

- A writable volume or tmp area is additionally required for the cache root.
- When one persona dir is shared by multiple processes, the operator must ensure
  the cache root is separated.
- Misclassifying an archive-shape errno as a cache failure turns merely placing a
  file in the ingest dir into an availability DoS that raises on cold start.
- Even a valid pack is inflated once before extraction, so extraction costs
  effectively two passes of CPU (negligible for packs of a few MB, F8).
- Placing many packs within the limit in the ingest dir is outside F8. Overall
  cache capacity management belongs to another layer.
- **`verify_archive/1` materializes the central directory twice.** The inspection
  body and `verify_entry_names/1` each call `:zip.list_dir/1`, so enumeration costs
  two passes. They are sequential and the first charlist becomes unreachable once
  converted to binary names, so peak usage is not simply doubled. The 4 MiB budget
  caps each pass at approximately 66 MB.
- **A pack with a central directory over 4 MiB is skipped even if it is healthy.**
  The budget is a limit, not an empirical or declaration-validation value, and can
  reject a legitimate pack with extremely long names or comments. We chose this
  direction after judging such a pack nonexistent (skip only that pack, ADR-0029).
- **The EOCD search window is outside the budget.** The doubling loop reads up to
  about 131 KB. Since OTP itself reads with the same limit, an attacker cannot
  scale it, but it is inaccurate to say that “all bytes read before enumeration
  are within 4 MiB.”
- ~~There is a TOCTOU gap between preflight and extraction.~~ **Resolved (F9,
  issue #185, 2026-08-05).** Unify the inspection target as a staging artifact
  under the trusted cache root, and detect and skip an ingest-side replacement as
  a race by comparing the staged full digest with the identification full digest.
  The guarantee holds only inside the trust boundary (F6) — see F9 for details.

### Neutral

- Even if the default cache under tmp disappears, it is regenerated from the zip
  on the next ingestion.
- A missing ingestion directory is represented by an empty manifest with watching
  disabled, and does not recover automatically before restart.
- The F8 limits (1 GiB / 4096 entries / `@max_central_dir_bytes` 4 MiB) are all
  module-attribute constants and cannot be changed through environment variables.
  Treat an operational need for changes as a separate issue (decided in issue
  #179). マスター decided 1 GiB and 4096 entries (2026-08-04), while クロエ decided
  4 MiB as an internal margin without a product judgment (2026-08-04).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Keep the default as `<persona_dir>/.cache` and change only compose | The default behavior for a custom `:ro` dir remains broken |
| Cross-process-safe atomic cache | Excessive for internal operations |
| Branch on writability at startup | Behavior becomes environment-dependent and loses predictability |
