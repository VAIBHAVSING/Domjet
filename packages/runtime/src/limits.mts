// @ts-nocheck
import { Buffer } from "node:buffer";

export const MAX_HTML_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_SELECTOR_BYTES = 64 * 1024;
export const MAX_RETURNED_STRING_BYTES = 4 * 1024 * 1024;
export const MAX_DOM_COMMAND_BYTES = 64;
export const MAX_DOM_ARGUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_DOM_BATCH_BYTES = 8 * 1024 * 1024;
export const MAX_DOM_BATCH_OPERATIONS = 1_024;
export const MAX_DOCUMENT_METADATA_BYTES = 64 * 1024;
export const MAX_PLATFORM_COMMAND_BYTES = 64;
// Platform requests carry binary arguments as base64, so leave room for the
// 4/3 expansion above the ordinary 8 MiB page-input ceiling.
export const MAX_PLATFORM_REQUEST_BYTES = 12 * 1024 * 1024;
export const MAX_PLATFORM_RESPONSE_BYTES = 12 * 1024 * 1024;
export const MAX_PLATFORM_BINARY_BYTES = 8 * 1024 * 1024;
export const MAX_PLATFORM_RANDOM_BYTES = 65_536;
export const MAX_PLATFORM_KDF_OUTPUT_BYTES = 1024 * 1024;
export const MAX_PLATFORM_PBKDF2_ITERATIONS = 1_000_000;
export const MAX_PLATFORM_PBKDF2_WORK_UNITS = 1_000_000;
export const MAX_RENDER_URL_BYTES = 64 * 1024;
export const MAX_RENDER_RESOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE = 32;
export const RENDER_IMAGE_REQUEST_PROFILES = Object.freeze([
  "no-cors-include",
  "cors-same-origin",
  "cors-include",
]);
export const MAX_SCREENSHOT_DIMENSION = 32_768;
export const MAX_SCREENSHOT_PIXELS = 16_777_216;
export const MAX_SCREENSHOT_PNG_BYTES = 128 * 1024 * 1024;
export const PNG_HEADER_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_PDF_OPTIONS_BYTES = 64 * 1024;
export const MAX_PDF_PAGE_RANGES = 250;
export const MAX_PDF_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_PDF_PAPER_INCHES = 200;
export const PDF_HEADER_SIGNATURE = Object.freeze([0x25, 0x50, 0x44, 0x46, 0x2d]);
export const PDF_OPTION_NAMES = Object.freeze([
  "viewportWidth",
  "viewportHeight",
  "landscape",
  "printBackground",
  "scale",
  "pageRanges",
  "paperWidth",
  "paperHeight",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
]);

export function requireBoundedString(value, maximum, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maximum) {
    throw new RangeError(`${label} exceeds the ${maximum}-byte ABI limit`);
  }
  return value;
}

export function requireBoundedBytes(value, maximum, label) {
  if (!(value instanceof Uint8Array) && !Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) {
    throw new TypeError(`${label} must be a Uint8Array or Buffer`);
  }
  if (value.byteLength > maximum) {
    throw new RangeError(`${label} exceeds the ${maximum}-byte ABI limit`);
  }
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

export function requireValidPngBytes(bytes, label = "screenshot PNG") {
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes) && !ArrayBuffer.isView(bytes)) {
    throw new TypeError(`${label} must return a Uint8Array or Buffer`);
  }
  if (bytes.byteLength < PNG_HEADER_SIGNATURE.length) {
    throw new TypeError(`${label} must contain at least 8 bytes for PNG signature`);
  }
  if (bytes.byteLength > MAX_SCREENSHOT_PNG_BYTES) {
    throw new RangeError(`${label} exceeds the ${MAX_SCREENSHOT_PNG_BYTES}-byte ABI limit`);
  }
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < PNG_HEADER_SIGNATURE.length; i++) {
    if (view[i] !== PNG_HEADER_SIGNATURE[i]) {
      throw new TypeError(`${label} does not start with a valid 8-byte PNG signature`);
    }
  }
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function requireFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function requirePdfPageRange(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`PDF page range ${index} must be an object`);
  }
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== "string" || (name !== "start" && name !== "end")) {
      throw new TypeError(`PDF page range ${index} contains an unknown field ${String(name)}`);
    }
  }
  const normalized = {};
  for (const name of ["start", "end"]) {
    if (!Object.hasOwn(value, name) || value[name] === undefined) continue;
    if (!Number.isSafeInteger(value[name]) || value[name] < 1 || value[name] > 0xffff_ffff) {
      throw new RangeError(`PDF page range ${index} ${name} must be a positive unsigned 32-bit integer`);
    }
    normalized[name] = value[name];
  }
  if (normalized.start !== undefined && normalized.end !== undefined && normalized.start > normalized.end) {
    throw new RangeError(`PDF page range ${index} start must not exceed end`);
  }
  return normalized;
}

export function requirePdfOptions(value = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("PDF options must be an object");
  }
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== "string" || !PDF_OPTION_NAMES.includes(name)) {
      throw new TypeError(`PDF options contain an unknown field ${String(name)}`);
    }
  }
  const own = (name) => Object.hasOwn(value, name) ? value[name] : undefined;

  const viewportWidth = own("viewportWidth") ?? 800;
  const viewportHeight = own("viewportHeight") ?? 600;
  if (!Number.isSafeInteger(viewportWidth) || viewportWidth < 1 || viewportWidth > MAX_SCREENSHOT_DIMENSION) {
    throw new RangeError(`PDF viewportWidth must be an integer between 1 and ${MAX_SCREENSHOT_DIMENSION}`);
  }
  if (!Number.isSafeInteger(viewportHeight) || viewportHeight < 1 || viewportHeight > MAX_SCREENSHOT_DIMENSION) {
    throw new RangeError(`PDF viewportHeight must be an integer between 1 and ${MAX_SCREENSHOT_DIMENSION}`);
  }
  if (viewportWidth * viewportHeight > MAX_SCREENSHOT_PIXELS) {
    throw new RangeError(
      `PDF viewport pixel count (${viewportWidth * viewportHeight}) exceeds the ${MAX_SCREENSHOT_PIXELS} pixel limit`,
    );
  }

  const landscape = own("landscape") ?? false;
  const printBackground = own("printBackground") ?? false;
  if (typeof landscape !== "boolean") throw new TypeError("PDF landscape must be a boolean");
  if (typeof printBackground !== "boolean") throw new TypeError("PDF printBackground must be a boolean");

  const scale = requireFiniteNumber(own("scale") ?? 1, "PDF scale");
  if (scale < 0.1 || scale > 2) throw new RangeError("PDF scale must be between 0.1 and 2");

  const pageRanges = own("pageRanges") ?? [];
  if (!Array.isArray(pageRanges)) throw new TypeError("PDF pageRanges must be an array");
  if (pageRanges.length > MAX_PDF_PAGE_RANGES) {
    throw new RangeError(`PDF pageRanges exceeds the ${MAX_PDF_PAGE_RANGES}-entry safety limit`);
  }
  const normalizedRanges = pageRanges.map(requirePdfPageRange);

  const paperWidth = requireFiniteNumber(own("paperWidth") ?? 8.5, "PDF paperWidth");
  const paperHeight = requireFiniteNumber(own("paperHeight") ?? 11, "PDF paperHeight");
  if (paperWidth <= 0 || paperWidth > MAX_PDF_PAPER_INCHES) {
    throw new RangeError(`PDF paperWidth must be greater than 0 and at most ${MAX_PDF_PAPER_INCHES} inches`);
  }
  if (paperHeight <= 0 || paperHeight > MAX_PDF_PAPER_INCHES) {
    throw new RangeError(`PDF paperHeight must be greater than 0 and at most ${MAX_PDF_PAPER_INCHES} inches`);
  }

  const marginTop = requireFiniteNumber(own("marginTop") ?? 0.3937, "PDF marginTop");
  const marginBottom = requireFiniteNumber(own("marginBottom") ?? 0.3937, "PDF marginBottom");
  const marginLeft = requireFiniteNumber(own("marginLeft") ?? 0.3937, "PDF marginLeft");
  const marginRight = requireFiniteNumber(own("marginRight") ?? 0.3937, "PDF marginRight");
  for (const [name, margin] of [
    ["marginTop", marginTop],
    ["marginBottom", marginBottom],
    ["marginLeft", marginLeft],
    ["marginRight", marginRight],
  ]) {
    if (margin < 0) throw new RangeError(`PDF ${name} must be non-negative`);
  }
  const effectiveWidth = landscape ? paperHeight : paperWidth;
  const effectiveHeight = landscape ? paperWidth : paperHeight;
  if (marginLeft + marginRight >= effectiveWidth || marginTop + marginBottom >= effectiveHeight) {
    throw new RangeError("PDF margins must leave a positive printable area");
  }

  const normalized = {
    viewportWidth,
    viewportHeight,
    landscape,
    printBackground,
    scale,
    pageRanges: normalizedRanges,
    paperWidth,
    paperHeight,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
  };
  requireBoundedString(JSON.stringify(normalized), MAX_PDF_OPTIONS_BYTES, "PDF options");
  return normalized;
}

export function requireValidPdfBytes(bytes, label = "PDF output") {
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes) && !ArrayBuffer.isView(bytes)) {
    throw new TypeError(`${label} must return a Uint8Array or Buffer`);
  }
  if (bytes.byteLength > MAX_PDF_OUTPUT_BYTES) {
    throw new RangeError(`${label} exceeds the ${MAX_PDF_OUTPUT_BYTES}-byte ABI limit`);
  }
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < PDF_HEADER_SIGNATURE.length + 5) {
    throw new TypeError(`${label} is too short to contain a valid PDF envelope`);
  }
  for (let index = 0; index < PDF_HEADER_SIGNATURE.length; index += 1) {
    if (view[index] !== PDF_HEADER_SIGNATURE[index]) {
      throw new TypeError(`${label} does not start with %PDF-`);
    }
  }
  const eof = [0x25, 0x25, 0x45, 0x4f, 0x46];
  const eofOffset = view.at(-1) === 0x0a ? view.byteLength - eof.length - 1 : view.byteLength - eof.length;
  for (let index = 0; index < eof.length; index += 1) {
    if (view[eofOffset + index] !== eof[index]) {
      throw new TypeError(`${label} does not end with %%EOF and an optional newline`);
    }
  }
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function requireRenderImageRequestProfile(value) {
  if (typeof value !== "string" || !RENDER_IMAGE_REQUEST_PROFILES.includes(value)) {
    throw new TypeError(
      `render image request profile must be one of ${RENDER_IMAGE_REQUEST_PROFILES.join(", ")}`,
    );
  }
  return value;
}
