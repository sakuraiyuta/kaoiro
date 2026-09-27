---
title: Issue 426 implementation gates
status: preliminary
last_updated: 2026-09-27
---

# Implementation gates

The source is commit `07ac81f2` plus focused-test commits `862fe452` and `c22d8f54`; reference updates are commit `1d651d65`. The final `wrapper/claude-code/src/host.ts` SHA-256 is `29341e40df15fa8faf405499965a0bc2d957127c2536be92c5e4c787e227f609`, and its rebuilt `dist/host.js` is `5b83a5724ec1a17fbf3fe038804b47112746de8e2533659db8b5e881bb10dd78`. The focused test source is `2e71c190c41808cb594dae3db38831ff4c7e86f9cb165a852f85b1e22738c6bf`. The native runs used SDK 0.3.280 / bundled CLI 2.1.280, `model=sonnet`, a loopback Phoenix server, and real `ServerLink` peers. The production-shaped runs used `permission_mode=auto` and `allowed_tools=[]`; the Agent-notification-only control used `permission_mode=default` and explicit read/MCP allow entries to keep the child `SubagentHandback` tool absent. Every run below used a fresh root and peer ID and checked peer visibility in the server directory before root startup. The temporary driver used the production MCP builder; it wrapped the actual SDK `query` only to record hooks and results, except for the separately identified default-host control. The retired-call control deliberately held one production MCP descriptor invocation without replacing its origin or send handler.

The final driver SHA-256 is `94f2cb15c0cb0a221bff7b2fe7e97646a41ab34c4f17ecc384a533822a61c369`; its independent verifier is `716790afda2c92a755a00113a8d6b47a99f913aa04aa5d69dd583577736fcdcb`. The baseline gate rows used the previously recorded driver SHA-256 `087275ff68ab5554183ca4b4f084a077c85abffe7920c717f87306e9d4b1a09d`; `agent-notice2` used an intermediate scratch revision, while `agent-notice3`, `notice-fold3`, `old-call1`, `four17`, and `four18` used the final driver. The final verifier checked the eleven named gate runs in its combined log (exit 0; SHA-256 `a81914a5ff79a50433748c511f1e7400af4b6e588b3b213948e888f49344a0d8`). Removing one peer-delivery event from a copy of `four16` made the original verifier exit 1 (log SHA-256 `6d584fbe637b6bd9dd57bf7a1adab1693824d505410ccd04ce6f654f44845149`). In the extended verifier, changing only the held call's observed aborted signal to false made its invocation exit 1 (log SHA-256 `f52585b8bc71192be10d46ede32cd4adbd308b2cf8de346209debfd7043d9055`); removing one peer-delivery event from a copy of `four18` also made it exit 1 (log SHA-256 `aba7873e52491cad1a3d03cd23375426b4ecde1a8b7fd24206c7747539ccd91a`). Neither verifier mutates the repository or original logs.

## Native observations and limits

| Gate | Result from final built path | Still missing |
| --- | --- | --- |
| 1: independent ledger | `ledger6`: one background Agent hand-back opened a fresh prompt after wrapper result index 0. One root send, server acceptance, and peer delivery used the completed input; one peer-origin result index 1 settled the independent owner. Process and verifier exit 0. | The separate `old-call1` control below re-exercises a held retired call; this ledger run did not hold one. |
| 1: live wrapper basis | `basis6`: peer A turn 1, B turn 3; B's hand-back arrived under B's live root prompt ID. The final wrapper send used `in_reply_to=3`, was accepted, and was delivered. `basis7`: A/B/C turns 1/3/5 were accepted; B's hand-back again folded into B's live ID after C was queued. The first final send retained basis 3 and was rejected with `stale_reply_basis(expected_peer_turn=5, supplied_basis=3)` without peer delivery. The model then used recovery and made a separate basis-5 send, which the server accepted; that later send is **not** counted as the stale control. Both processes and verifier cases exit 0. | None for the measured live-fold basis comparison. |
| 2: four-Agent owner | `four16`: all four child hand-back hooks had the root session and matched four background task IDs; four root sends, four server acceptances, and four peer deliveries followed. Four hand-backs and four notifications reused the hand-back opener's prompt ID. One peer-origin result at index 1 carried the opener task's identity, followed by exactly one owner `turn_end`; process and verifier exit 0. | A final-built notification-first independent opener joined by another task's hand-back was not emitted. Distinct later reports, exact duplicate reports/notifications, coalesced prompts, and a candidate with no root hook were not all produced by the native CLI. Focused controls do not replace these native observations. |
| 2: long busy notification | `four12`, `four13`, and `four14` each exited 0 and delivered four distinct task summaries. Their notification candidates either joined a live owner before its terminal or received a fresh prompt soon after an idle interval began. | None showed a **previously armed** notification candidate whose matching root prompt arrived after more than 10 seconds of intervening root busy time. This is missing native positive evidence after three workload attempts, not a failed host admission. The separate fake-time test pins the timer logic. |
| 3: inherited issue #422 paths | `bash1`: background Bash notification and `task-notification` terminal, one send/acceptance/delivery, zero Agent or hand-back hooks. `agent-notice3`: one Agent notification with **zero** child hand-back hooks, an independent `task-notification` terminal, one send/acceptance/delivery. `notice-fold3`: a Bash notification folded into a live wrapper input under its prompt ID; the originless wrapper result settled after one send/acceptance/delivery. `old-call1`: a real MCP send captured under T1 was released only after T2's different prompt was admitted; its original signal was aborted, the handler returned `stale_tool_call` with `send_not_attempted`, and no `OLD` body reached the server. `default1`: an uninjected default host read a document and completed one turn. All accepted processes and verifier cases exit 0. | A forged foreign root prompt and separate native expiry ordering were not re-emitted. The original issue #422 evidence and focused controls cover their prior and deterministic observations. |
| 4: focused admission | Final `pnpm test` passes 612 Claude tests, including exact rendering, owner checks, later root prompt membership, root-ID capacity, same-task replay, both candidate kinds under fake time, and barrier release. Fourteen separate guard/wiring mutations below each made its targeted test red and restored green. | Native duplicate/coalesced/no-hook schedules and some capacity/session-change cases remain unobserved. |
| 5: terminal | Focused tests reject wrong opener identity, origin, body, session, missing/regressing index, and notification/peer origin swaps; an exact retired-result duplicate cannot settle the newer owner. Stop followed by another tool and Stop settles only on ResultMessage. Both independent and wrapper-fold owners were exercised through interrupt, reset, EOF, watchdog fail-stop, and admission fail-stop; delayed hand-back authority did not bind to a replacement token where one was permitted, and remained frozen when none was permitted. Individual origin, identity, body, session, missing-index, regressing-index, and duplicate mutations turned red and restored green. The native `four16` opener result settled once. | The native CLI did not emit each adverse terminal/lifecycle ordering; focused controls pin those branches. |

The long-busy and notification-first native controls remain missing. This record does **not** label the prototype deploy-ready. The accepted [design](../../plans/issue-426-agent-handback-admission.md#verification-gate) requires a director decision on those gaps before landing.

## Native raw-log manifest

All paths below are under `tmp/fuji-426/` in the shared repository. The three hashes per row refer to `native-<run>-events.jsonl`, `native-<run>.stdout`, and `native-<run>.stderr`, respectively.

| Run (process exit 0) | Events SHA-256 | stdout SHA-256 | stderr SHA-256 |
| --- | --- | --- | --- |
| `ledger6-final` | `58a7f85a2de833ceb4abd1a07deb67c7fc666128d295a99ee23d60378de8c956` | `5934eae9e58d382206367355a3926dd4437e6d2b8c5e3440574cddff30b61c99` | `83a5d1c71ccf43b83cf6d8b897e742b2673992dcd0cd92a7dbef331092df4281` |
| `basis6-ok` | `a76324972075176d9c5001ec7a5484967ffc554c9e725ff94c8ca5a0bc439e74` | `76ed042e50580d68d2fd0a680e86908b641c871a309d7d883a91288b8a16b9a3` | `4d401438a8c0af0885a2a54cdad8c53b4643f11516ffae12a7c825f57ac609cb` |
| `basis7-final-stale` | `baeb01049075c3850063ac878a90458f70863431bf7bf643e0bd336e1ced4c93` | `dd6f5e9097d952b282c89fc59dfc2630e00de45567e65bc60c28f62db72f1dce` | `6a6b44bd765e700c8923a57df38877a7a715e745d6f5ac2dae8b36c2b58a8d5b` |
| `four16-final` | `7efa10a1a68188e9256e8f8820bb6323bd22a982a04c8fb872297fb415da0f1b` | `b15057fdabccfc55a55243352219f064676b204ced92e1063ba0db5ed10a9ff2` | `9356aca980d6a51103ffb4a5c40035541b7acb0f3f6f4124e1e168e780795f8a` |
| `four12-busy` | `bc2482622821bfb4524a950d64cb1cff7bc117ca73aac42656ec6bffa7d4489d` | `0cec1ee993e6ba719b555cdcdd74c495b6ab3b86fc07fb2a83e7fb7daf94654b` | `959f72ea0930d495a73b0907060e6654f46662d318dd9c1bb1efa5aa612a5288` |
| `four13-busy` | `fd27667bc51119fb67a14d16bb41956e38d2e53c1a415f5e407a6660821d0dad` | `6a9ede01e55f53b4dfeab5ca54518ae4f13afc2e05c8c9c395c70d8b1c53eec8` | `1964189844bec84c36df6ff7c2172398023003e79a7d53a47eded749eada1217` |
| `four14-busy` | `f9c671175803688fbac348f9aad029c3dffb8f425772beac5c6684139138d711` | `ccbf0aa4e65b9435ec15e84984084291fb4110b3e878aadd346f842b2176faf9` | `e9b49906fec0b7477b599530f27836830a6ea47e4e9cf0cbbf7447a514847fa9` |
| `bash1-gate3` | `ad8ca0a53c9b1ed6faea75e8076199c864dd11a93cc28973ff65f30847d933a1` | `d2418146d51ca6922cf63f704a9ffa6260a8c782ec365639b94b1574bb00f0e8` | `7db8f264575351b0b99a7aa2b87344581a047f49579e142d13d1d9a8fd364883` |
| `default1-gate3` | `2b262489a293bc344ebe675e7c62e3ed8e2c8eb7dba7240ac5684e296d96e0dd` | `67c7e1ad3de13f9f560920d124a32970d86e5356b10a93b24ef42e14d3085996` | `1ec8f50c4d286cb42c9efa987df82de5a698eb707bc58300a3e71cd39f9e1797` |
| `agent-notice2` | `1519c6d4edc872ef0e47125afb0cfed4e52582ff99699047a6ffeef9dad8723d` | `502997de9876031ff27331740cc11bfd4bbc7c52b302df7071a882e5442d4dee` | `80a1a8e4d5c552fca1f4abeb0655a6c4da4eb32530a602c84e153da4dd497a06` |
| `agent-notice3` | `cdb6b79817a1485b291e209da6af11a98a0785bc683f32c46e2c96dad85fe994` | `d4670675c2c7d8dd9b0c3c680e1e9014febf7a1e98fc50123efac2ac3b82a1aa` | `17d0efeef95557c3647d11a508f75517f64a98d9b05d9fca83a6faf1bb820af7` |
| `notice-fold3` | `e87a64c55313ded22684df7bac370a3208c7ade25b2ff4bde0fa24c24c87f517` | `65920811caf7b7eb5918776d3943f3b6c88a72a760cf870b7b6a69fff0061e24` | `aad1ba1db85455177632ac81f9f7a1f170e44a213112a43308f2421ac8401d5c` |
| `old-call1` | `e46c30c9718cb511b37957f2d99ff9cfde663150aa119787bae80413ce9ccf34` | `2f42e49232fb5c06c28e675a2064b0fded1973d36070cbe061bd48b8db1a7af8` | `a40ce05f9b053e43da11769d898391dc5e4a1007a4694f82b5f8f475f62de475` |
| `four17-postmutation` | `df4382f4469c3abccf99ccd0a9081450d2c2fdd63a26408810e4590bb9ada857` | `5cdcc6f947f3743140c8d8cff0de55c59ef4398fc896705c073b944d3d953872` | `6699a9c812476902c8cb3529805b197b71532aa6cf0ac0a85d94b52e7b6fb922` |
| `four18-final` | `bd108086acaed4421e0131745694d84b440fab7a8d394192ce898997b49aadfd` | `e8b24d076189d14c6c4d22e11c4e3d5b92eba9ea45a14dff17a6c3ba7642bf5f` | `020bd2ae7ccf6f8228966fbae6b5bd3720b4eca5487584bc3cf75ec9b32a6664` |

The temporary manifest checker (`tmp/fuji-426/verify-evidence-manifest.py`, SHA-256 `b5c4c4228b8832f4562f34380713bcc0ebd6011c2cc30e7e578d140c5a7196c7`) matched all 45 file hashes in the 15 rows (exit 0). Altering one hash in a copy of this page made the same checker exit 1 (negative log SHA-256 `56bc5473b10baf8fde9f66f088c1ee9e735a3ae47f6c0b97e105e21be90e26ee`).

`four17-postmutation` ran after the terminal-body source mutation was byte-for-byte restored. Its source and rebuilt host hashes match the header; all four root sends, acceptances, and peer deliveries passed the extended verifier, and the opener's peer-origin result index 1 ended one independent owner. After an additional interrupt-cleanup mutation was restored, `four18-final` used the same source and built hashes. It produced four fresh hand-back opener IDs, four accepted sends and peer deliveries, result indices 0–7 in order, four peer results identifying their respective opener tasks, and four notification results; its last hand-back opener also received a same-ID notification fold. All four child hooks carried the root session. The final native result is a distinct measured ordering, verified separately rather than forced into `four17`'s coalesced shape.

The bounded notification-fold attempts were: `notice-fold1`, whose temporary prompt used a relative path under the isolated CLI working directory and whose Bash job failed; `notice-fold2`, whose completed Bash notification opened a fresh prompt after its wrapper turn; and accepted `notice-fold3`, whose notification arrived during the second wrapper turn and reused that turn's prompt ID. Their event-log SHA-256 values are `7391bc1edbb7e1dbe0415d328e09785e70890a688bba0c23a83c240b98cc1ffa`, `ddf840498c5e2f3afcbc607352d9b9fbe4d048937594f19accb97187dd5f32f6`, and the accepted manifest value above. `agent-notice1` was excluded after its default-mode child reached an unresolved permission wait; its event log is `91626b073a43bf166f223e1986f6d60bc864dad2c4d784068ae2df5eb9328adc`. Both `agent-notice2` and the final-driver `agent-notice3` used explicit read/MCP allow entries and had zero child hand-back hooks; each completed an independent notification send.

## Focused mutation and package gates

Each mutation changed only the named guard/wiring, ran the matching focused Vitest selection, and restored the original source bytes before a green rerun. The source and rebuilt host hashes at the top of this record were checked after restoration. All red exits were 1 and all restored green exits were 0.

| Mutation | Red log SHA-256 | Restored green log SHA-256 |
| --- | --- | --- |
| Disarm on root turn start | `b5fb129d90e12b43766f4ac921dbde58a6867e6a883427a1258889cd890d3e7c` | `e749c85cf8496fbeb7f8d6914d68ba417a858592f8f7c40b29fb5fe2d3b8189c` |
| Rearm after terminal | `d55c60a3c2f705aff5b2a2d35ff5261fe06a4e4e738d1c0c0fdcdec5f5aa59e5` | `19cc621e63e78799b1fabefeeb588a6efd1521db289f98dbc2f2a92c90c6f7e6` |
| Observed-root-prompt membership | `c987b79792794c746e816d55e7a6d28ec32734a088d19ac976bdf1b77e5bd55e` | `47a7007bf17a85189c12cd725db4cc867665801d1f33b6b4f4fbef5130930f29` |
| Exact candidate rendering | `11e2001574b03c0c444e601c7cf165fa1b19ec054f4b7a959cbccf94256bcf19` | `6c32ad356b60530b1dee0d11a8fa3e7e4aa436149dd514b5cdae168c06b36200` |
| Root tool owner | `60ea93735c8c951463cb8cf4aab2560219464dafb04a98071f1ac049f83d1786` | `6df435e6fd1cf15cf943d243055c351f34a9f38b71a6d63a62f4890579aa4727` |
| Terminal opener origin | `4068d574b6c3f3a83f1709380b7939d5c76b1342a62f38219189b6330431891b` | `c284100fe58bba036c66b1876126dd5ae853d6f8c887e87353c940ce72bd6862` |
| Terminal opener identity | `8637908a9b98e2d588e45250d87362a887367f52671a5270330af899f729ed2b` | `e4e38aa311bb971bdc4c9aa769dca4240ffa61937fc6936b5324d536852cc8b1` |
| Same-task report replay fingerprint | `564691f3290415855a47fe37b2370b133bf5162c5c94955b6eca9989199ed365` | `31c998a8df8dff8262411438adbdaf21b75cd267113a9329730005c6c9518756` |
| Terminal result session | `157b8ccae496e1e8f5ac10e36558a5a1fb7b00686cdb8208051a0b0639bf199d` | `c94426d55f33c05c2cf2a918021ab131dec81a0d03eabdc6ca23c96fa317ae92` |
| Missing result index | `b68aca14862d817cd0f6f29ea591bf9f5b07b779a1e1ac229d653acb8bbfac1f` | `21cd05cb555adf74d0808fdb352f85ffdc827016b3e0a0ed9d50cea2820bc2fc` |
| Regressing result index | `2e238cc7c54bcbc7c4bd3adbeeb1626d7530878517f2bca61fff07ff2f09a016` | `2a833b1a7084297eb08a6041e525b153f2cc9fb94aaf65437a3c072cd854eb31` |
| Exact retired-result duplicate | `ec4605ebe4a51432c0555622f07201b65ac0b192fc2132d5543a220aac737c33` | `42dcc779050687b3eaf286c85a5dadd5cc3ac2133a7b34167df60f9182077e74` |
| Terminal opener body | `681571a4ea13b16c538222c1db66ebbff9828638c264458aff79047b207b56a2` | `9b776e6ad49f45dd7f1c958dcb734ead4f4021b9be6bcdf27ac23cdc052e1eb8` |
| Interrupt candidate cleanup | `560cadc01a417e4a8a30b1928e821a4546873998a013122cb79a00a82921407a` | `a290895befd79bfedb67022fa51f5ba56945c3fa0683b355b5b9a3f4c843c544` |

| Package | `pnpm test` | `pnpm typecheck` | `pnpm build` |
| --- | --- | --- | --- |
| `wrapper/agent-common` | exit 0, 399 tests | exit 0 | exit 0 |
| `wrapper/claude-code` | exit 0, 612 tests | exit 0 | exit 0 |
| `runner` | exit 0, 774 tests | exit 0 | exit 0 |

Package log hashes (test / typecheck / build) are:

| Package | Test log SHA-256 | Typecheck log SHA-256 | Build log SHA-256 |
| --- | --- | --- | --- |
| `wrapper/agent-common` | `4908c516cfc092406833571af6e9fe249e3c06727ca53ac59c719d508a9e5dd6` | `adb116e051a69a2cd4927c69cba19cf2f8e4255068a938a917011922ad2a1946` | `158fa6982cf0ae73189ac58c725ea907ff38ffcdd00a178f70d55c8155c1c4cf` |
| `wrapper/claude-code` | `eb90c1e72c2e5c32e46ad12060cc6062466c95e5d2ddcc9eb7d8e193780e105e` | `6746f9b2f9f35573f941cd1b193a3c469a79dbe0a2c870aa70b3cc34b8d29740` | `daae07167126661ce73c27ac2a2a68e5da80446b5ae6b793e54d30191c9ec649` |
| `runner` | `00e9fc61db7275eb053beeeb3e9598bda229d310a454439d00dc331d24facb0c` | `4d6b05cf1719864ff5b761984debccb6e37aaf252adedf5e6624bc5f9daea0df` | `44fc3be8e15288d0015ee45287c70d4ae953655b979ac37182f2577eca7a0214` |

The final evidence diff passed `git diff --check` and markdownlint (exit 0 each). Its one relative link resolved, while a deliberately missing target failed the same checker. The baseline check of 32 links across the earlier reference/evidence changes also passed. The raw logs remain under `tmp/fuji-426/` until the issue closes.
