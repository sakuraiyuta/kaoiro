// Shared test helpers — kept here so the wire format definitions live in
// one place. A spec change to the binary frame layout updates this single
// builder instead of every test that constructs a payload.

/** Builds an `attach_chunk` binary payload matching the spec layout:
 *  `<u32 upload_id_len BE><upload_id utf8><u32 chunk_index BE><bytes>`. */
export function buildChunkPayload(
  uploadId: string,
  chunkIndex: number,
  bytes: Uint8Array,
): ArrayBuffer {
  const idBytes = new TextEncoder().encode(uploadId);
  const out = new Uint8Array(4 + idBytes.byteLength + 4 + bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, idBytes.byteLength, false);
  out.set(idBytes, 4);
  view.setUint32(4 + idBytes.byteLength, chunkIndex, false);
  out.set(bytes, 4 + idBytes.byteLength + 4);
  return out.buffer;
}
