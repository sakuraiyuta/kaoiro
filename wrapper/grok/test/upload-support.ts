import { strToU8, zipSync } from "fflate";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { UploadIntake } from "../src/upload.js";

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** An attach_chunk payload: `<u32 id len><id><u32 index><bytes>`. */
export function chunkPayload(uploadId: string, index: number, bytes: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(uploadId);
  const out = new Uint8Array(8 + id.byteLength + bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, id.byteLength, false);
  out.set(id, 4);
  view.setUint32(4 + id.byteLength, index, false);
  out.set(bytes, 8 + id.byteLength);
  return out;
}

/** attach_open, every chunk, attach_close. */
export function upload(
  intake: UploadIntake,
  uploadId: string,
  filename: string,
  mime: string,
  bytes: Uint8Array,
  chunkSize = 64 * 1024,
): void {
  const chunks = Math.max(1, Math.ceil(bytes.byteLength / chunkSize));
  intake.attachOpen({ upload_id: uploadId, filename, mime, size: bytes.byteLength, chunks });
  for (let index = 0; index < chunks; index += 1)
    intake.attachChunk(chunkPayload(uploadId, index,
      bytes.subarray(index * chunkSize, (index + 1) * chunkSize)));
  intake.attachClose(uploadId);
}

export function recordingIntake(config: WrapperConfig, now?: () => number) {
  const envelopes: Envelope[] = [];
  const intake = new UploadIntake({ config, send: (e) => envelopes.push(e), state: () => "idle",
    ...(now ? { now } : {}) });
  return { intake, envelopes };
}

export function rejections(envelopes: Envelope[]) {
  return envelopes.filter((e) => e.type === "attach_rejected" || e.type === "instruction_rejected")
    .map((e) => ({ type: e.type, ...e.payload }));
}

const contentTypes = (overrides: string) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  `<Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;
const relationships = (target: string, type: string) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="${type}" Target="${target}"/></Relationships>`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const ML = "http://schemas.openxmlformats.org";

/** The smallest OOXML package officeparser 7.2.2 reads, holding `word`. */
export function ooxml(kind: "docx" | "xlsx" | "pptx", word: string): Uint8Array {
  const parts: Record<string, string> = kind === "docx" ? {
    "[Content_Types].xml": contentTypes('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
    "_rels/.rels": relationships("word/document.xml", `${REL}/officeDocument`),
    "word/document.xml": `<w:document xmlns:w="${ML}/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${word}</w:t></w:r></w:p></w:body></w:document>`,
  } : kind === "xlsx" ? {
    "[Content_Types].xml": contentTypes('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'),
    "_rels/.rels": relationships("xl/workbook.xml", `${REL}/officeDocument`),
    "xl/workbook.xml": `<workbook xmlns="${ML}/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": relationships("worksheets/sheet1.xml", `${REL}/worksheet`),
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="${ML}/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${word}</t></is></c></row></sheetData></worksheet>`,
  } : {
    "[Content_Types].xml": contentTypes('<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'),
    "_rels/.rels": relationships("ppt/presentation.xml", `${REL}/officeDocument`),
    "ppt/presentation.xml": `<p:presentation xmlns:p="${ML}/presentationml/2006/main" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": relationships("slides/slide1.xml", `${REL}/slide`),
    "ppt/slides/slide1.xml": `<p:sld xmlns:p="${ML}/presentationml/2006/main" xmlns:a="${ML}/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${word}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  };
  return zipSync(Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)])));
}
