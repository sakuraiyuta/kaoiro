---
title: Issue 426 implementation gates
status: preliminary
last_updated: 2026-09-27
---

# Implementation gates

The source is commit `07ac81f2` plus focused-test commit `862fe452`; reference updates are commit `1d651d65`. The final `wrapper/claude-code/src/host.ts` SHA-256 is `29341e40df15fa8faf405499965a0bc2d957127c2536be92c5e4c787e227f609`, and its rebuilt `dist/host.js` is `5b83a5724ec1a17fbf3fe038804b47112746de8e2533659db8b5e881bb10dd78`. The test source is `79bf9e4d2ec953021ed04aeae223697d747d3a5b98ad2f572b27f2573907ada4`. The native runs used SDK 0.3.280 / bundled CLI 2.1.280, `model=sonnet`, `permission_mode=auto`, `allowed_tools=[]`, a loopback Phoenix server, and real `ServerLink` peers. Every run below used a fresh root and peer ID and checked peer visibility in the server directory before root startup. The temporary driver used the production MCP builder; it wrapped the actual SDK `query` only to record hooks and results, except for the separately identified default-host control.

The driver at SHA-256 `087275ff68ab5554183ca4b4f084a077c85abffe7920c717f87306e9d4b1a09d` generated the final runs. Its independent verifier at SHA-256 `7c413aca5538353f3bf9564c5a4aac5084c68568a35a16a6ffc0a270326a88fb` checked actual events and exited 0 for the six measured controls. Removing one peer-delivery event from a copy of `four16` made that verifier exit 1; the negative log is SHA-256 `6d584fbe637b6bd9dd57bf7a1adab1693824d505410ccd04ce6f654f44845149`. The verifier never mutates the repository or the original logs.

## Native observations and limits

| Gate | Result from final built path | Still missing |
| --- | --- | --- |
| 1: independent ledger | `ledger6`: one background Agent hand-back opened a fresh prompt after wrapper result index 0. One root send, server acceptance, and peer delivery used the completed input; one peer-origin result index 1 settled the independent owner. Process and verifier exit 0. | A held call captured under an earlier retired token was not re-exercised natively in this run; the existing issue #422 control covers that source behavior. |
| 1: live wrapper basis | `basis6`: peer A turn 1, B turn 3; B's hand-back arrived under B's live root prompt ID. The final wrapper send used `in_reply_to=3`, was accepted, and was delivered. `basis7`: A/B/C turns 1/3/5 were accepted; B's hand-back again folded into B's live ID after C was queued. The first final send retained basis 3 and was rejected with `stale_reply_basis(expected_peer_turn=5, supplied_basis=3)` without peer delivery. The model then used recovery and made a separate basis-5 send, which the server accepted; that later send is **not** counted as the stale control. Both processes and verifier cases exit 0. | None for the measured live-fold basis comparison. |
| 2: four-Agent owner | `four16`: all four child hand-back hooks had the root session and matched four background task IDs; four root sends, four server acceptances, and four peer deliveries followed. Four hand-backs and four notifications reused the hand-back opener's prompt ID. One peer-origin result at index 1 carried the opener task's identity, followed by exactly one owner `turn_end`; process and verifier exit 0. | A final-built notification-first independent opener joined by another task's hand-back was not emitted. Distinct later reports, exact duplicate reports/notifications, coalesced prompts, and a candidate with no root hook were not all produced by the native CLI. Focused controls do not replace these native observations. |
| 2: long busy notification | `four12`, `four13`, and `four14` each exited 0 and delivered four distinct task summaries. Their notification candidates either joined a live owner before its terminal or received a fresh prompt soon after an idle interval began. | None showed a **previously armed** notification candidate whose matching root prompt arrived after more than 10 seconds of intervening root busy time. This is missing native positive evidence after three workload attempts, not a failed host admission. The separate fake-time test pins the timer logic. |
| 3: inherited issue #422 paths | `bash1`: background Bash task notifications, a `task-notification` terminal, one root send, one acceptance and one peer delivery; zero Agent or `SubagentHandback` hooks. `default1`: `AgentHost` used its default SDK query with no injected `queryFn`, read an actual document, and completed one meaningful turn. Both processes and verifier cases exit 0. `four16` also exercised Agent notifications and same-ID folds. | The full earlier issue #422 native matrix (old-call hold, forged foreign root prompt, and separate expiry ordering) was not reproduced with this build. Existing focused controls and the original issue #422 evidence remain separate evidence. |
| 4: focused admission | Final `pnpm test` passes 597 Claude tests, including exact rendering, child/root owner checks, later root prompt membership, root-ID capacity, distinct same-task reports and replay, both candidate kinds under fake time, and input barrier release. Eight independent guard/wiring mutations below each turned a targeted test red and restored green. | Native duplicate/coalesced/no-hook schedules and some capacity/session-change cases remain unobserved. |
| 5: terminal | Focused tests reject wrong opener identity with a valid opener body, wrong origin with otherwise valid fields, wrong body, missing index, and notification/peer origin swaps. Separate opener-origin and opener-identity mutations turned their targeted tests red and restored green. The native `four16` opener result settled once. | Separate hand-back-specific mutation controls for session/index, exact retired-result duplicates, Stop attempts, and cancel/EOF/reset/watchdog paths were not completed; inherited host lifecycle tests cover portions of these paths. |

The long-busy and notification-first native controls are missing. This record does **not** label the prototype deploy-ready. The accepted [design](../../plans/issue-426-agent-handback-admission.md#verification-gate) requires a director decision on those gaps before landing.

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

| Package | `pnpm test` | `pnpm typecheck` | `pnpm build` |
| --- | --- | --- | --- |
| `wrapper/agent-common` | exit 0, 399 tests | exit 0 | exit 0 |
| `wrapper/claude-code` | exit 0, 597 tests | exit 0 | exit 0 |
| `runner` | exit 0, 774 tests | exit 0 | exit 0 |

Package log hashes (test / typecheck / build) are:

| Package | Test log SHA-256 | Typecheck log SHA-256 | Build log SHA-256 |
| --- | --- | --- | --- |
| `wrapper/agent-common` | `2392009e1b73b0dc8365320715ee9ae4b1d4d4874f68f8b4cbb3bedb8e7c3072` | `adb116e051a69a2cd4927c69cba19cf2f8e4255068a938a917011922ad2a1946` | `158fa6982cf0ae73189ac58c725ea907ff38ffcdd00a178f70d55c8155c1c4cf` |
| `wrapper/claude-code` | `c84d4ed03c05ef775cec4d6e83ca136aac87defdf11a2d9b9bc6e7433ef63f3b` | `6746f9b2f9f35573f941cd1b193a3c469a79dbe0a2c870aa70b3cc34b8d29740` | `daae07167126661ce73c27ac2a2a68e5da80446b5ae6b793e54d30191c9ec649` |
| `runner` | `439ee89cceaaf72ac3200d9946c568d941d5c29de135b0e22cfd606d52f482dd` | `4d6b05cf1719864ff5b761984debccb6e37aaf252adedf5e6624bc5f9daea0df` | `44fc3be8e15288d0015ee45287c70d4ae953655b979ac37182f2577eca7a0214` |

`git diff --check` and markdownlint on the changed reference/evidence pages exited 0; 32 relative links in those pages resolved, and a deliberately missing link failed the checker. The raw logs remain under `tmp/fuji-426/` until the issue closes.
