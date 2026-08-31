---
title: System-footer.md and user-footer.md
status: accepted
date: 2026-08-03
opened: 2026-08-02
supersedes: []
superseded_by: null
related_specs: [persona-personality-injection, persona-pack-schema]
related_adrs: [29, 44, 46]
---

# ADR-0045 — Ex  file of common footer

## Status

Accepted(2026。02 draft, 2026。03 master decision).
[ADR-0029](0029-persona-server-sot-and-pack-distribution.md)
partially revise F5/D5 (not supersede).

When drafting
[#165](https://github.com/sakuraiyuta/kaoiro/issues/165)
([ADR-0044](0044-coordination-injection-004l.md) implementation)
Home****I used to accept the tuning, but the s ical trial
Because it was a mutual wait that the ADR mechanism was required, the mechanism and
I separate the sentence and confirm it only. Built-in default
It is current at the time of drafting, and the statement of the cooperative guidance is the same issue
([ADR-0044](0044-coordination-injection-004l.md) F1
Comment

## Context

Common footer is always on the system prompt end of all agents
HomeーJapanese termxir's module attribute when drafting while being a parameter
`@common_footer`
was hardcoded. Rebuild and redepro  server for changing one character
is required.

ADR-0044 F1
#165
A). “ProtoHomeing Short Action Principles to Measure Shortages”
The natural way to proceed is not rotated because the build is required for each trial.

Personality description (`personality.md`) is already a file in pack,
The operator can edit. Only common footer is left on the code side.

There are two s. `:ro`
I can not design the premise to export files from the server side.  More
Install directory extraction cache
[ADR-0046](0046-persona-cache-relocation.md)
`:ro` mount. footer
Use a dedicated root (F1) for mana pack and separation.

## Decision

### F1: The default footer is "built-in default + file priority"

The default statement is built in the server binary, and in the footer installation directory
`system-footer.md` is a built-in version.**Completely replace**。
Use the built-in version (fail-closed) if the file is returned / empty (trim)
not

The footer installation directory is specified by env `KAOIRO_FOOTER_DIR`.
**If not set, file priority is disabled**(with built-in version only, without user-footer)
`KAOIRO_PERSONA_DIR`
Not set. 2 sorts of separation — mount persona dir with `:ro`
Default pack dir does not mix SoT and operation files in pack
git / docker build context
container like `./footers:/etc/kaoiro/footers:ro`
`:ro` assume mount. Changes to env/path are reflected in the server restart
(watcher monitoring root is fixed on startup).

Built-in default physical entity is not module attribute
`server/priv/footers/system-footer.md` release
`priv/`
`File.read!` Operator
View this file with the repository or release and check the default statement.
`.example` does not require double management, docs reprinting or dumping tasks
(open-question footer-default-visibility at drafting is integration to this ADR)


### F2: Owner's own footer`user-footer.md`1 piece

footer `user-footer.md` in footer prompt
**Close**to link.
`preset + personality → system-footer → user-footer` Contact Us
personal is the same empty line (`\n\n`) as the existing personality / footer binding.
When it is empty or missing, it will be re ed to "not enough". read error
Follow (cold start shrinks and keeps the normal value before running).
Both `system-footer.md` / `user-footer.md` are common for all persona
Only ** and another persona file (`user-footer.<persona_id>.md`)
Don't have it. mana-specific instructions in pack `personality.md`
Express by side.

### F3: The operator footer is not placed in the repository

`system-footer.md` / `user-footer.md` is equivalent to env
The configuration file of the operation side, and the repository does not commit. F1
`.gitignore` /
`.dockerignore` ex s are no longer needed (repo-tracked under pack dir)
(It was required for drafting).

### F4: Reflection from next connection via watcher

`KAOIRO_FOOTER_DIR` Only at the same directory
`system-footer.md` / `user-footer.md`**Full file name matching**
Watcher monitors the mana pack watcher. Any `*.md`
do not spread), rebuild without   restart. debounce window
If you update the two files at the same time, you may temporarily have a new and old snapshot
tolerant (to be astringent in the rebuild of the uterus). wrapper in connection
does not work from the snapshot of the next connection wrapper
([ADR-0029](0029-persona- -sot-and-pack-packbution.md) Maintain F9).
If the directory is missing or not read even if `KAOIRO_FOOTER_DIR` is set,
cold start is fail-soft (built-in version only + warn) and watch remains invalid
Start. server does not mkdir (`:ro` premise). Create a directory
Reboot is required for activation.

### F5:   results always visualize with rebuildJapanese term

Each layer of rebuild
`input_state=file|missing|empty|read_error` /
`effective_source=file|built-in|last-known-good|with absent` 2 axis
SHA-256 to log at info level
(e.g. if system is missing, input state= ing and
effective source=built-in). read error adds an absolute path
(not silent failure). Length warn threshold cannot be set
(No ground threshold, always warn is ignored). With a notice to hypertrophy
3-layerJapanese term delivery string tracking (negative below) isJapanese term by number of characters + hash
The theory of length collateral is determined by this
(The point of the sentence was used asionion-footer-scope at the time of drafting,
#165

### F6: Reading Meaning

- UTF-8 Required Effective value**BOM removal → CRLF→LF normalization → trim**in order
Normalized body (the number of characters of F5 / hash is also effective
to do). invalid UTF-8
do not fall).
-only file  link FIFO   read error
Watcher (FIFO `File.read` block or external target change
to avoid problems that cannot be picked up).
- read error of cold start is the same as missing (system → built-in version, user →
None temporary read error in operation**Maintain previous normal values**
(Accidentic save or permission change short window, only new connection rules disappear
to prevent F5 warn
- The byte cap is not available.
not specified).

## Consequences

### Positive

- ADR-0044 F1
“Starting and measuring from A” (#165)
- kaoiro default (`system-footer.md`) and operation rules (`user-footer.md`)
It is separated and keeps original instructions while incorporating default updates.
- footer root only read-only access, even `:ro` mount configuration
not broken (separation from the `.cache` write problem of pack ingest).
container foot only 2 footer without subst ting bundled packs
can be edited.

### Negative

- Prompt injection layer is 3 (personality / system / user),
It becomes difficult to track the actually delivered string. F5 rebuild log
Ensure the starting point of tracking with (from + number of characters).
- For operators with `system-footer.md`, the default update of kaoiro
(the reason for the existence of `user-footer.md`).
- The operator's free description will always consume the context of all agents.
The warning threshold is not set (FVisualization keeps the state to be aware of obesity by log visualization.

### Neutral

- ADR-0029 F5 (combination is the responsibility of the server side, wrapper is the receipt string as it is
injection) does not change. Changes: “Does SoT code or files on the sentence?”
1 point.
- F1 `priv/footers/system-footer.md`
open-question footer-default-visibility
close).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|footer to persona directory root|Pack ingest`.cache`Write`:ro`git / docker build root root separation`KAOIRO_FOOTER_DIR`Both problems disappear|
|Write the default sentence when starting| `:ro`Not working in a mount environment. Once exported, the distribution side update does not reach the existing installation|
| `system-footer.md`fail-closed|Existing environment is immediately dead by upgrade. Migration procedure is required and footer is stronger than ADR-0029 F3|
|common + persona separate user footer 2 layers|The infusion layer becomes four and the real prompt tracking is |
|persona separate user footer only|All common rules need to edit files for all persona|
|Commit the footer file to the repository|It becomes a collision source because the content changes according to the environment. same as env|
|Hot-swapping to connection medium-session|ADR-0029 F9 collision with F9|
|server Only when restarting|Impairs the main purpose of ex ation without the trial and error cost of the sentence|
|Default Text:`system-footer.md.example`Distribution|Double control of the built-in version and example, resulting in misunderstanding ofJapanese termhronization. F1`priv/`If you embed a real file, you can show the real thing itself|
|Default Text: Reprint to docs|The source is md internal code block, and it collapses and reprints drift|
|Default Text: Dump with the mix task|execution environment premise (container operation)`docker exec`)。`priv/`Alternative to real files|
|length guard: server warn (L2)|No threshold ground. Always warn is ignored. Alternative to F5 log visualization|
