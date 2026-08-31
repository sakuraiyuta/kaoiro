---
title: extract cache external
status: accepted
date: 2026-08-03
opened: 2026-08-03
supersedes: []
superseded_by: null
related_specs: [persona-pack-schema, deployment]
related_adrs: [29, 45]
---

# ADR-0046 — extract cache external

## Status

Accepted (2026.03, determined by master delegation Chthe relevant entry + Note consultation).
[ADR-0029](0029-persona-server-sot-and-pack-distribution.md) F2 / F6
partially revise the cache description.

## Context

kaoiro issue #173. `PersonaAssets.build/0`
`<KAOIRO_PERSONA_DIR>/.cache` to `mkdir_p!`, zip,stale.
This is inconsistent with the `:ro` overlay example of compose and the persona of `:ro`
cold start is broken in dir. The problem was found during the ADR-0045 review.

## Decision

### F1: cache root separation outside persona dir

Specify cache root with new env `KAOIRO_PERSONA_CACHE_DIR`. Unset
`System.tmp_dir!()`
`"kaoiro-persona-cache-<sha256(Path.expand(persona_dir)) Home16hex>"`
default. cache is a recyclable derivative from zip and tmp loss is acceptable.
hash is the path after expand so that namespace cannot be shaken by relative path or cwd
Take from.

### F2: Disco e writing to persona dir

`PersonaAssets.build/0` does not write to persona dir.
`PersonaWatcher.init` Import directory
Put the missing warn, start with the empty manifest and record watch.
Reboot is required to enable the directory.

### F3: reclaim is limited to entry in cache-key format

reclaim only removes entry matching 16 key cache-key format. Error
Protect the unrelated directory under the specified root

**(issue #185 must-fix 2, 2026 05):**the relevant entryging area orphan reclaim
(see `reclaim_stage_orphans/1`, F9) also follows the same principles. F9
charset `A-Za-z0-9_-`
**Strictly matched**entry only and regular expressions
`~r/^\.stage-[A-Za-z0-9_-]{22}\z/` — even starting with `.stage-`
It is not a loose condition). `.stage-important`
`.stage-freshtest` does not match the exact shape
entry is treated as persistence, and reclaim is never deleted. `\z` instead of `$`:
Elixir/Erlang `re` is a P  style, and `$` without `/m` is just before the end of the string.
`.stage-<22English>\n`
shape is found inthe relevant entry- review
(2026 05, the implementation side has been modified, Note left the description of this ADR old
round-3).

### F4: Separate cache failure contract

fail-fast if cache root is not created or written at cold start
raise. If you failure with the running rebuild,
last-known-good

`:erofs` /
`:enospc` / `:edquot` / `:eio` / `:eperm` / `:emfile` / `:enfile` / `:enomem` /
`:enodev` / `:estale`. cold start
keep last-known-good. `:eacces` also zip `:zip.unzip` ingest dir
cache only if path in error term is cache root
Disability and classification.

`:enotdir` / `:eloop` / `:eisdir` / `:einval` /
`:enoent` skips as pack error. entry `a`
zip with zip or `sprites` as a normal file.

**Compensation (2026 04): Handling of failure of cache slot operations (remove, create, and stenosis).**
errno table above
cache**Read and Write**to classify
`<cache_root>/<hash>` deleting/creating/owner-only mode
(chmod) does not apply as it is.

Reason: `:eperm` / `:eacces` / `:eexist` / `:enotdir`
**others in group/world-writable
Only the OS user has one slot. foreign non-empty slot
ing two-stage permissions — the permission to unlink the child in the slot is slot
directory own write/execute bit dependent and empty slot itself
ing permission depends on cache root. so even if root is written,
Unempty slots without write bits cannot be deleted. cache failure
When sorted, all packs can be pulled in one directory
raise with start — ADR-0029 “Do not stop the entire drop”
reversal.

Thus, if you want to remove, create, and mode stenosis of slots,
rewrite-probe

- The root is still written and the reason is `:eperm` / `:eacces` / `:eexist` /
`:enotdir`**This pack only skip** (pack error)
- other (`:eio` / `:estale` / `:enospc` / `:erofs`, etc.), or root
I can't write it.**cache failure**(as shown)

slot-specific I/O failures andlele NFS handles leave root intact
so, if only root probe is set to the condition, "pack is silent and missing manifest"
permission The errno table is limited to that.

### F5: Multiple process sharing of the same persona dir is not guaranteed

Do not guarantee the configuration of the same persona dir shared by multiple server processes.
`KAOIRO_PERSONA_CACHE_DIR`
compose sets `/var/lib/kaoiro/persona-cache`.

### F6: Default tmp root harden as predictable shared path

Set `0o700` only for default root. chmod is non-owner
`:eperm` is used as a substantial ownership check. root
link probe write is made with `:write + :exclusive` O EXCL.
This lstat statlink rejection and O EXCL write probe are used for both default and explicit root


explicitly specified root is trust boundary to delegate safety decisions to operators. server
chmod can break the configuration of shared volume and orchestrator.
does not force chmod to explicit root. group/world-writable
Warnings dedup only once per `(root, mode)` and avoid warn at all times
ADR-0045 F5

This is a precursive attack against a predictable shared `/tmp` path, i.e.  link
to ease prompt injection by using truncate or false pack.

**Supplement (2026 04): Safety contract for slot.**slot(`<cache_root>/<hash>`)
Preparation and deployment meet the following: (1) slot root and slot internal special type
(linklink, etc.) detects and rejects with lstat — normal file directory
There is no other way to read. (2) Create slots with exclusive mkdir
(`mkdir_p` equivalent is not possible because it treats existing linklinks). (3) slot
**Before**stenosis to owner-only(0700), and then enter mode
normalize to owner-only — do not get the mode the relevant entry-the relevant entryd by the archive. These are
It is a safety contract rather than implementation details, and mitigation requires revision of this ADR.

### F7: De  zip slip before deploying

Verify with `Path.safe_relative/1` before deploying all entry names in zip. Rejected name
If there is one, the whole pack will be rejected and will not be expanded.

cache moved to the same `/var/lib/kaoiro` volume as the authentication DETS ledger.
The impact range of traversal spreads. OTP also defines Illegal path
(OTP 29.0.2) is a multi-layer defense that does not depend on the implementation details and denying before writing
Place pre-verification to get.

### F8: Disable at the limit before deploying the size and number of entries after deployment

Total size after pack deployment**1 GiB (1_073_741_824 byte)**Number of entries
**4096 results**Restrict to: Packs that exceed one will be rejected without starting the deployment
pack only skip (ADR-0029). The upper limit is not errno, but as an explicit test
F4 errno class does not affect.

The maximum value is 2026the relevant entry-04. 1 GiB is a high resolution image and future extension
(e.g., 3D model, etc.), interpreted as 2-decimal prefix (1024^3). 4096 founded
"Total size is small, but only a huge amount of pack"
Unsuccessful pack (sprite hundreds of dozens to 3D)
I had enough space. directory entry.

**Uncompressed size is not used.**`:zip.list_dir/1`
local header
The central directory's declaring value can be freely written by the attacker. `:zip.unzip/2`
Expand real data to the end without any reference — OTP 29.0.2 in real-time, both headers
10,000,000 byte without an error.
The size limit is actually inflate the raw deflate stream before deploying. Output
byte count is only calculated by destroying the fixed chunk of 64 KiB.
Memory is constant even in a single giant entry. As soon as the limit is reached, the deployment time
Attacks are also mitigated simultaneously.

This decision is because the original issue #179 (`:zip.list_dir/1` returns the size after the deployment
that was rejected by actual survey. "List dir"
Fix the basis of rejection here so that it is not returned.

**method and flag are local header.**OTP 29.0.2 `:zip.unzip/2`
local header compression method (central is DEFLATE
entry is inflate and inverted). The implementation of reading method from central returns
The method of central is not referenced because it becomes the same type of bypass. Encryption entry
(general purpose bit 0) rejects because inflate cannot measure the actual amount — the
I re the encryption bit and write it as it is, so it is not possible to stick. DEFLATE
Reject method values other than STORE.

data descriptor (general purpose bit 3)
permission ** The entry with bit 3 is the size of the local header and OTP is
Read and deploy central directory comp size (stdlib 8.0.1 `zip.erl`)
`get_z_file/9`: `GPFlag band 8 =:= 8 -> ZipFile#zip_file.comp_size`.
Take a real reading span from there. local header
0 byte and count to make the upper limit test simple — write true value to csize 0 and central
0 byte, `:zip.unzip/2` 10,000,000 byte
bit 3 is streaming zip writer (Java `ZipOutputStream`, Go `archive/zip`, etc.)
Read the same field as the extractor instead of reject to stand on a daily basis. flag
the local header. (This is the same as `get_z_file/9`)
Make sure to switch the trust destination with the flag you set up.

**ZIP64 sendinel resolves with local extra field.**32-bit size field
ZIP64 extended extra information field
(id 0x0001). If bit 3 is missing, OTP solves this on the local side and then expands it
read local extra (not substitute for Central — local without bit 3
It’s just a book and it’s different from Central.

Read**Same loop as `update_zip64/2` in OTP**must be. This record
is indexable, not fixed layout, but 8 byte each time
Re-evaluate sentinel ? When 64-bit value itself is `0xffffffff`, OTP is further
8 byte is consumed as the same field, so if you read it in a fixed position, one comp size is
Take from. Real-time (tests use a reduced upper limit to perform validation on aSize scale): payload
The fixed position version is comp size with the second value
`:zip.unzip/2` reads 3rd as a single, 1 MB
Expanded. 999,999 bypass
As the ratio expands as it is, the same configuration can be scaled to 1 GiB expansion,
The upper limit of production is also the same type bypass.

More than the above, the compression size is determined in the following priority order. Bit 3 Yes → central
directory comp size / bit 3 None and 32-bit sentinel → local ZIP64 extra
32-bit field of local header.

**bound the enumeration itself before enumerating.**Both the size and number of tests above
The `list_dir` itself is bound
No means. OTP materializes all central directory
1 GiB archive may require several GB of BEAM heap
in 203 MB / 5.7 seconds). `list_dir`
****bound by three declaration values. If the declaration exceeds the limit
It is not possible to use it only in the direction of playing.

|Name|Why bound|
|---|---|
|entry number| `get_central_dir/4`Note`N = EOCD#eocd.entries`Note`get_cd_loop/6`pass to loop count (stdlib 8.0.1)`zip.erl`1916-1921). Subtotal Declaration**Reduce**You can't add only (actual survey: 40,000 archives, but 10the relevant entry-the relevant entrys areHomed by 1ms.`list_dir`The return is 11 elements, but the breakdown is`:zip_file`10 Items +`:zip_comment`The number of entries is limited to the previous one. Excessive file declaration`bad_central_directory`throw|
| `filesize - the relevant entry central offset` | `get_cd_loop/6`is expected to return to offset and read forward, so the maximum number of bytes the enumeration can be touched. This span is offset**Close**If you want to throw a record first, it will be thrown.|
|ZIP64 record| `find_eocd64/5`after reading locator previous 12 byte,**Before getting central offset**Read the number of declaring bytes`zip.erl`2121-2138). If you don't bound this step, you can put the record in front of the file and file a huge body offset, andthe relevant entry the central offset near the EOF. The read is already over when theInspection test passes|

**No filed central directory size.**OTP
Don’t read anywhere, don’t bound anything.

**Maximum budget 4 MiB (`@max_entries * 1024`).**sound pack central
directory is about 800 KB (fixed 46 byte + name 100)
extra 30) so there is a margin of about 5 times. central directory tail and ZIP64
record**permission**It fits to this one — the same as for each area
The upper limit can be used double, and the question "how much it can be enumerated" is originally
It is a question for the total.

**entry The number is not blocked.**`get_cd_loop/6` for each
name + extra + comment read, and even three 16-bit entry, so maximum in 1 entry
KB OTP also returns name and comment in charlist, so 64-bit
In the VM, it is swelled to 16 byte. OTP 29.0.2: with 64 KB name
500 entries: 31 MB on disk, heap 516 MB, a ification 16.5 times. entry Number limit
268 MB pack requires about 4.2 GB, and **1 GiB archive
Not touching the maximum of 4096 entries. span bound
The same a ification rate for Mi MiB is about 66 MB.

**The EOCD search procedure is shown in OTP.**adopt when decoy is inserted
The location is different. OTP from `eof - window`**permission**1 bytes
Grab the first structural match and double the window (22 → 44 → ... →
min(0xff+42, filesize). Inertial backward scanning is to collect the last record,
EOCD `entries_on_disk`
Copy `entries` to AND. Constant field on ZIP specification
not in width**OTP Macro Value**— locator is physical 20 byte but
`?END_OF_CENTRAL_DIR_64_LOCATOR_SZ` is `(4+8+4)` = 16 (`zip.erl`:253),
The implementation works with the value. The search window becomes 4 bytes wider than OTP,
3 bounds at the same time with only pre-reading decoy in the position where OTP never sees
Disable (repro ). The scanning window itself (maximum 131 KB) is
The attacker cannot scale, so it is not eligible for the budget.

**Store boundary is given in the archive's own size.**DEFLATE is real-time at the end of stream
Close, but there is no end in FORE and its length is only in the false declaration field.
False is an archive file size, and STORE does not affect the archive
If you tied up the same 1 GiB limit, you will always have the limit of the deployment from the store. Accounting
Add the store entry in comp size, which is determined in the above priority order. Bypass
— because the deployment side only reads the same comp size minutes, the actual writing is also reduced
(local and central)**Two**The data descriptor form with csize is
DEFLATE / STORE central
bit 3 entry comp size is


**The inspection order is preferred.**archive size → central metadata
preflight (entry number / span / ZIP64 body.. `:zip.list_dir/1`
local header (F7) → inflate With traversal that can be rejected by name
zip bomb does not allow up to 1 GiB inflate CPU. F7
Both are layers that do not write at all, and this unchanged condition does not depend on the order.

### F9: Close preflight and deployment TOCTOU withgingging (issue #185, Note 2026 2005 )

F7/F8 preflight (`verify_archive/1`) and `:zip.unzip/2` both initially
`zip_path` can be controlled by ingest writer.
`:zip.list_dir/1` twice, `File.open(raw)` multiple times,
If `:zip.unzip/2` is included, the same path should be opened more than 5 times. The same byte column
ingest dir
F7/F8
(Old Negative)

**Considered deal.**(a) Pass binary once to both preflight and deployment —
If the upper limit is 1 GiB or higher, b  read will present 64 KiB streaming design (F
rejected because it breaks itself becomes a new memory DoS. (b) retargeting the preflight   —
Rejected because the window is narrowed but there is no blockage. (c) OTP `:zip.zip_open/2` fd retention API
`zip_open` `file:open`
`zip_get`/`zip_list_dir` does not reopen only with the same fd pread/read
`zip_get/1` (without memory option)
Each entry is designed directly to the disk, and the contents are not preserved by measuring only the size after deployment.
Not available. How to make F8 streaming inflatethe relevant entry via this API
`:zip.unzip/2` severity of this issue
(Low) is considered to be excessive, and is not allowed to reexamine if severity is up.

**Adopt applied.**ingest writer
trusted cache root is a privategingging area (exclusive mkdir 0700)
temporary dir + exclusive create 0600 files, basename is collision avoided
only once source to a dedicated random value not a security boundary)
open**fd to 64 KiB chunk**bound copy**
byte — 1 byte to distinguish just the upper limit and the upper limit, not read more)
SHA-256**staged side full digest**Note
**full digest**permission If it does not match "intake"
Determines that the source has changed, and the pack is**race as skip**(malformed
log in a language that can be distinguished from archive) and to the next watcher-t ed rebuild
Retry. F7/F8 preflight and `:zip.unzip/2` are
**ging only files**See the original ingest path.

**This approach guarantees.**open fd links to the original inode
If the path of the ingest side is replaced with rename/relink, it is already open
fd is not included (the general nature of POSIX). *Inode
truncate/overwrite** — the same inode of the original file before copy is completed
If you change the above, you can get a new and old mixed byte column on the staged side. This nature is
does not mean "fd guarantees snapshot at the point of source" —
"**bounded copy" is generated and is not stable
factfacts see the same preflight and expansion**.
F7/F8 and `:zip.unzip/2` are
staged factfact
(If it is unfair form, it will only be disthe relevant entryed consistently if it is a legitimate form).

**This warranty is only established inside trust boundary.**cache root
writer is not able to write (same as F6 trust boundary). F6
As stated, the operation of explicit cache root to group/world-writable is
is delegated to the decision of the operator, and thegingging area itself is
This clause does not apply because it can be reachable from ingest writer.

**stage**success / pack error /
cache error / raise raise Normal return value
`merge_cleanup_error/2`
Let's merge with cleanup results. `rescue` is sent by `raise`
`reraise` `try`/`after`
not `try`/`rescue`.
(including those un pable stakes are the following orphan reclaims
Defending line).

`.stage-*`
reclaim orphans of  ing patterns that are strictly matched to random suffix
(issue #185 Note round-2 Review, 2026.05) Initially 10 minutes
age-gate is protected, but there is no global lock in `rebuild/0`.
To prevent other re rebuild from accidentally cleaning thegingging area still in use
Comment**must-fix 1**`rebuild/0`
`KaoiroServer.PersonaRebuildLock` and in this BEAM node
`build/1` starts because it guarantees only one rebuild at the same time
There is no live liveging area at the time. age-gate
`reclaim_stage_orphans/1`
prev) Im ate entry of exact name matching specified by entry, F3 without condition
reclaim to approach.

`:zip.unzip/2` entry enumeration is central directory
local entry is not deployed. entry number central
Counting from the directory matches the behavior of the deployment.

## Consequences

### Positive

- mount the persona dir read-only and can be cold start.
- a persona pack and a recyclable extract are separated.
- Uncreated cache root fails clearly at startup and in running temporary failure
keep manifest.
- Start to deploy an attack (zip bomb) that fills the cache volume with one high compression pack
Can be blocked before. cache is the same volume as the authentication DETS ledger, so this is expired
Store deterioration prevention (F )

### Negative

- writable volume or tmp area for cache root is required separately.
- cache root separation for multiple processes sharing the same persona dir
The operator is required to collateral.
- If the errno from the archive shape is accidentally categorized to the cache failure side, it is ingest dir
It becomes the availability DoS to raise the cold start just by putting the file.
- Inflate 1 time before deployment even with a legitimate pack, so the deployment is real 2 times CPU
(F , which can be ignored in a few MB packs.
- Attacks that align packs in the upper limit to ingest dir are out of the range of F8.  cache
Total capacity management is required to handle in another layer.
- **`verify_archive/1` materializes the central directory twice.**
`:zip.list_dir/1`
2 enumeration costs 2 times are se tial and 1 char charlist to binary name
akak is not simply doubled because it becomes unreachable when converted.
4 The MiB's budget is about 66 MB.
- **4 PACK with central directory beyond MiB skip even if it is healthy
** The budget is the upper limit value without validation of the return value, name and comment
You can play a legitimate pack with extreme length. I chose this direction by determining that it is not real
(This pack only skip, ADR-0029).
- **The EOCD search window is outside the budget.**Up to 131 KB of doubled loops.
OTP itself cannot scale to the attacker because it reads at the same limit, but read before enumeration
It is not accurate to say that all bytes are within 4 MiB.
- There is TOCTOU between ~~preflight and deployment. F9 issue #185
2026.05). ** ForInspectionging factfact under trusted cache root
staged full digest
Detect and skip replacement as race. guarantee inside trust boundary
(F6) Only valid — see F9 for details.

### Neutral

- Even if the default cache under tmp is lost, zip is regenerated with the following import.
- The missing directory is empty manifest and watch disabled.
Don't auto-restart until restart.
- Maximum F8 (1 GiB / 4096 / `@max_central_dir_bytes` 4 MiB)
module attribute is a constant and cannot be changed by environment variable. Operational changes
Issue #179 1 GiB and 4096
the relevant entry- MiB is a master decision (2026 (2004).
ed as a margin (2026 (2004).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Default`<persona_dir>/.cache`Only compose changes| custom `:ro`dir's default behavior remains a bug|
|ic cache|Excessive for inner ring operation|
|Can be written on startup|Behavior becomes environmentally dependent and loses predictiveness|
