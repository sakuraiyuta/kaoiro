# Compaction permission contexts

The JSONL files contain `turn_context` lines extracted byte-for-byte from
three real Codex rollout prefixes, except that the recorded home-directory
prefix is replaced by the synthetic `/home/user`. `manifest.json` binds each
file to its SHA-256, the source prefix's length and SHA-256, and the original
line byte offsets. The file SHA-256 describes the edited file; the source
prefix length, SHA-256 and offsets describe the original recordings and are
provenance only. Only context records are retained; conversation and tool
bodies are excluded.

Replaying the original prefixes through the production reader before the fix
accepted the first context, then rejected all five reads after compaction
(including the four 25 ms retries). Removing only repeated context lines
restored the observation. This fixture pins that measured SDK output shape;
it does not claim to trigger compaction in a newly running SDK process.
