"use strict";

/**
 * Minimal-yet-extensible ASTERIX parser
 * - Supports multi-record byte streams
 * - Parses common CAT048 items (subset) and leaves unknowns as raw hex
 * - Easy to add more categories: add to CATEGORY_DEFS and DECODERS
 *
 * Notes:
 * - Uses network byte order (big endian)
 * - FSPEC continuation bit = 1 -> more FSPEC bytes follow
 * - Each category’s UAP (User Application Profile) defines which data item
 *   corresponds to each FSPEC bit, in order (bit 7..1 per octet).
 */

// ------------------------------- Byte helpers -------------------------------

function readU16BE(view, off) {
  return (view[off] << 8) | view[off + 1];
}
function readI16BE(view, off) {
  const v = readU16BE(view, off);
  return (v & 0x8000) ? (v - 0x10000) : v;
}
function readU24BE(view, off) {
  return (view[off] << 16) | (view[off + 1] << 8) | view[off + 2];
}
function readU32BE(view, off) {
  return (view[off] * 2 ** 24) | (view[off + 1] << 16) | (view[off + 2] << 8) | view[off + 3];
}
function readI32BE(view, off) {
  const v = readU32BE(view, off) >>> 0;
  return (v & 0x80000000) ? (v - 0x100000000) : v;
}
function toHex(view, off, len) {
  return [...view.slice(off, off + len)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Two’s complement of an N-bit field given as unsigned integer `x`. */
function twosComplement(x, bits) {
  const sign = 1 << (bits - 1);
  return (x & sign) ? (x - (1 << bits)) : x;
}

/** BDS-like BCD decode (common in Mode A/C codes etc.). */
function bcdToString(byte) {
  const hi = (byte >> 4) & 0x0f;
  const lo = byte & 0x0f;
  const nib = n => (n <= 9 ? String(n) : "");
  return nib(hi) + nib(lo);
}

// ------------------------------- FSPEC parsing ------------------------------

/**
 * Parse FSPEC bytes
 * Returns: { bytes: Uint8Array, bits: number[] }
 * - bits is a flat array of 1/0 from MSB->LSB per FSPEC byte, excluding FX bits
 */
function parseFSPEC(view, start) {
  const bytes = [];
  let off = start;
  // Read until a byte with FX (bit LSB) == 0
  while (true) {
    const b = view[off];
    if (b === undefined) throw new Error("Truncated FSPEC");
    bytes.push(b);
    off++;
    if ((b & 0x01) === 0) break; // FX=0 => FSPEC ends
  }
  // Collect bits 7..1 for each FSPEC byte (ignore bit0=FX)
  const bits = [];
  for (const b of bytes) {
    for (let i = 7; i >= 1; i--) {
      bits.push((b >> i) & 0x01);
    }
  }
  return { bytes: Uint8Array.from(bytes), endOffset: off, bits };
}

// ------------------------------- Category defs ------------------------------

/**
 * For each category, define the UAP bit map in order (bit7..1 of FSPEC[0], then FSPEC[1], etc.)
 * Each entry is the data-item ID string you’ll decode in DECODERS.
 *
 * Below is a _common_ UAP for CAT048 (Eurocontrol surface/SSR Track Reports), but
 * editions vary. Adjust to your spec if needed.
 */
const CATEGORY_DEFS = {
  48: {
    // CAT 048 – subset
    uap: [
      // FSPEC1 (bits 7..1)
      "I048/010", // Data Source Identifier
      "I048/020", // Target Report Descriptor
      "I048/040", // Measured Position in Polar
      "I048/070", // Mode-3/A code
      "I048/090", // Flight Level (Mode C)
      "I048/130", // Radar Plot Characteristics (optional subset)
      "I048/220", // Calculated Track Velocity in Polar
      // FSPEC2
      "I048/240", // Aircraft Address (Mode S)
      "I048/250", // Mode S MB Data
      "I048/161", // Track Number
      "I048/042", // Measured Position in Cartesian (alt to I048/040)
      "I048/200", // Calculated Track Velocity (Cartesian)
      "I048/170", // Track Status
      "I048/030", // Warning/Error Conditions
      // FSPEC3 (add more as needed)
      "I048/080", // Mode-3/A Code Confidence (optional)
      "I048/100", // Mode C Confidence (optional)
      "I048/110", // Height Meas (radar measured)
      "I048/120", // Radial Doppler Speed
      "I048/140", // Time of Day
      "I048/230", // Communications/ACAS capability & flight status
      // FSPEC4 (example extras; may be unused depending on spec)
      "I048/260",
      "I048/055",
      "I048/065",
      "I048/071",
      "I048/072",
      "I048/073",
      "I048/075",
    ],
  },
  // Add more categories here (e.g., 21 for ADS-B) with their UAP lists
};

// ----------------------------- Data item decoders ---------------------------

/**
 * Each decoder receives (view, off) and returns { value, length }.
 * Keep decoders tiny and pure; add scaling per spec.
 */
const DECODERS = {
  48: {
    // I048/010 – Data Source Identifier: SAC (1B), SIC (1B)
    "I048/010": (view, off) => {
      if (off + 2 > view.length) throw new Error("Truncated I048/010");
      return {
        value: { sac: view[off], sic: view[off + 1] },
        length: 2,
      };
    },

    // I048/020 – Target Report Descriptor (variable length, FX chaining in LSB)
    "I048/020": (view, off) => {
      let cur = off;
      const octets = [];
      while (true) {
        const b = view[cur];
        if (b === undefined) throw new Error("Truncated I048/020");
        octets.push(b);
        cur++;
        if ((b & 0x01) === 0) break; // FX=0
      }
      // Basic decoding of the first octet (example):
      const b0 = octets[0] ?? 0;
      const dt = (b0 >> 5) & 0x07; // Detection Type (example mapping varies by edition)
      const sim = (b0 >> 4) & 0x01;
      const rab = (b0 >> 3) & 0x01;
      const tst = (b0 >> 2) & 0x01;
      const mea = (b0 >> 1) & 0x01;

      return {
        value: {
          raw: toHex(Uint8Array.from(octets), 0, octets.length),
          detectionType: dt, // map per your spec if needed
          simulated: !!sim,
          reportedAsBad: !!rab,
          testTarget: !!tst,
          meaconing: !!mea,
        },
        length: octets.length,
      };
    },

    // I048/040 – Measured Position in Polar: RHO (2B), THETA (2B)
    // RHO in NM (LSB per spec, often 1/256 NM), THETA in deg (LSB 360/65536)
    "I048/040": (view, off) => {
      if (off + 4 > view.length) throw new Error("Truncated I048/040");
      const rho = readU16BE(view, off);
      const theta = readU16BE(view, off + 2);
      const rangeNM = rho / 256;               // per common CAT048 scaling
      const thetaDeg = (theta * 360) / 65536;  // 16-bit angle
      return {
        value: { rho_raw: rho, theta_raw: theta, range_nm: rangeNM, bearing_deg: thetaDeg },
        length: 4,
      };
    },

    // I048/070 – Mode 3/A (2B): 4 octal digits packed as 12 bits; plus SPI in top bits sometimes
    "I048/070": (view, off) => {
      if (off + 2 > view.length) throw new Error("Truncated I048/070");
      const code = readU16BE(view, off) & 0x1FFF; // 13 bits used in some editions; mask conservative
      // Extract 4 octal digits (A, B, C, D are 3-bit groups)
      const d1 = (code >> 9) & 0x07;
      const d2 = (code >> 6) & 0x07;
      const d3 = (code >> 3) & 0x07;
      const d4 = code & 0x07;
      return {
        value: {
          code_octal: `${d1}${d2}${d3}${d4}`,
          raw: code,
        },
        length: 2,
      };
    },

    // I048/090 – Flight Level (Mode C) (2B): 1/4 FL (LSB = 1/4 * 100 ft)
    "I048/090": (view, off) => {
      if (off + 2 > view.length) throw new Error("Truncated I048/090");
      const raw = readI16BE(view, off);
      const flightLevel = raw / 4; // FL units
      return { value: { raw, flightLevel }, length: 2 };
    },

    // I048/130 – Radar Plot Characteristics (dummy minimal decode as raw variable length w/FX)
    "I048/130": (view, off) => parseFxChainRaw(view, off, "I048/130"),

    // I048/220 – Calculated Track Velocity (Polar): Ground Speed (2B), Heading (2B)
    // Speed LSB often 1/16384 NM/s -> convert to m/s and kt; Heading 360/65536 deg
    "I048/220": (view, off) => {
      if (off + 4 > view.length) throw new Error("Truncated I048/220");
      const gsRaw = readU16BE(view, off);
      const hdgRaw = readU16BE(view, off + 2);
      const nm_per_s = gsRaw / 16384;
      const mps = nm_per_s * 1852;
      const kts = nm_per_s * 3600;
      const heading_deg = (hdgRaw * 360) / 65536;
      return { value: { gs_raw: gsRaw, heading_raw: hdgRaw, mps, kts, heading_deg }, length: 4 };
    },

    // I048/240 – Aircraft Address (Mode S) (3B)
    "I048/240": (view, off) => {
      if (off + 3 > view.length) throw new Error("Truncated I048/240");
      const addr = toHex(view, off, 3).toUpperCase();
      return { value: { icao24: addr }, length: 3 };
    },

    // I048/250 – Mode S MB Data: variable length (first byte count? editions vary)
    // Here, treat as length-prefixed: 1B count of 3B blocks + 1B BDS? (Highly edition-specific)
    // To be safe, decode as FX-chained raw block.
    "I048/250": (view, off) => parseFxChainRaw(view, off, "I048/250"),

    // I048/161 – Track Number (2B)
    "I048/161": (view, off) => {
      if (off + 2 > view.length) throw new Error("Truncated I048/161");
      return { value: readU16BE(view, off), length: 2 };
    },

    // I048/042 – Measured Position Cartesian: X (2B), Y (2B) LSB e.g. 1/256 NM
    "I048/042": (view, off) => {
      if (off + 4 > view.length) throw new Error("Truncated I048/042");
      const x = readI16BE(view, off);
      const y = readI16BE(view, off + 2);
      const nmLSB = 1 / 256;
      return { value: { x_raw: x, y_raw: y, x_nm: x * nmLSB, y_nm: y * nmLSB }, length: 4 };
    },

    // I048/200 – Calculated Track Velocity (Cartesian): Vx (2B), Vy (2B) in NM/s * 128? (varies)
    "I048/200": (view, off) => {
      if (off + 4 > view.length) throw new Error("Truncated I048/200");
      const vx = readI16BE(view, off);
      const vy = readI16BE(view, off + 2);
      // A common scaling: 1/16384 NM/s per LSB (same as polar), but some editions use 1/256 m/s.
      // We’ll assume NM/s * (1/16384) for both:
      const vx_nms = vx / 16384;
      const vy_nms = vy / 16384;
      return {
        value: {
          vx_raw: vx, vy_raw: vy,
          vx_mps: vx_nms * 1852,
          vy_mps: vy_nms * 1852,
          vx_kts: vx_nms * 3600,
          vy_kts: vy_nms * 3600,
        },
        length: 4,
      };
    },

    // I048/170 – Track Status (variable FX-chained)
    "I048/170": (view, off) => parseFxChainRaw(view, off, "I048/170"),

    // I048/030 – Warning/Error Conditions (variable FX-chained)
    "I048/030": (view, off) => parseFxChainRaw(view, off, "I048/030"),

    // I048/080, I048/100, I048/110, I048/120 – Keep as raw FX-chained for now
    "I048/080": (view, off) => parseFxChainRaw(view, off, "I048/080"),
    "I048/100": (view, off) => parseFxChainRaw(view, off, "I048/100"),
    "I048/110": (view, off) => parseFxChainRaw(view, off, "I048/110"),
    "I048/120": (view, off) => parseFxChainRaw(view, off, "I048/120"),

    // I048/140 – Time of Day (3B) in 1/128 s from midnight
    "I048/140": (view, off) => {
      if (off + 3 > view.length) throw new Error("Truncated I048/140");
      const raw = readU24BE(view, off);
      const seconds = raw / 128;
      return { value: { raw, seconds }, length: 3 };
    },

    // I048/230 – Comm/ACAS capability & flight status (1B+?), keep raw minimal decode
    "I048/230": (view, off) => parseFxChainRaw(view, off, "I048/230"),

    // Fallback examples—treat as raw if seen
    "I048/260": (view, off) => parseFxChainRaw(view, off, "I048/260"),
    "I048/055": (view, off) => parseFxChainRaw(view, off, "I048/055"),
    "I048/065": (view, off) => parseFxChainRaw(view, off, "I048/065"),
    "I048/071": (view, off) => parseFxChainRaw(view, off, "I048/071"),
    "I048/072": (view, off) => parseFxChainRaw(view, off, "I048/072"),
    "I048/073": (view, off) => parseFxChainRaw(view, off, "I048/073"),
    "I048/075": (view, off) => parseFxChainRaw(view, off, "I048/075"),
  },
};

/** Helper: decode “FX-chained” variable-length item as raw hex. */
function parseFxChainRaw(view, off, name) {
  let cur = off;
  const octets = [];
  while (true) {
    const b = view[cur];
    if (b === undefined) throw new Error(`Truncated ${name}`);
    octets.push(b);
    cur++;
    if ((b & 0x01) === 0) break; // FX=0
  }
  return { value: { raw: toHex(Uint8Array.from(octets), 0, octets.length) }, length: octets.length };
}

// ------------------------------- Core parsing --------------------------------

/**
 * Parse a single ASTERIX record at `offset`.
 * Returns { record, nextOffset }.
 *
 * Record layout (Eurocontrol standard):
 *   CAT (1B), LEN (2B), then FSPEC + Data Items...
 * Some feeds reverse CAT/LEN; this expects CAT first (most common).
 */
function parseRecord(view, offset) {
  if (offset + 3 > view.length) throw new Error("Truncated header");

  const cat = view[offset];
  const len = readU16BE(view, offset + 1);
  const end = offset + len;
  if (end > view.length) throw new Error("Truncated record body");

  const catDef = CATEGORY_DEFS[cat];
  const uap = catDef ? catDef.uap : null;

  // Parse FSPEC
  const { bytes: fsBytes, endOffset: diStart, bits: fsBits } = parseFSPEC(view, offset + 3);

  const items = {};
  const rawItems = {};
  let cur = diStart;

  if (!uap) {
    // Unknown category: keep payload raw
    rawItems._unknownCategoryPayload = toHex(view, diStart, end - diStart);
    return {
      record: {
        category: cat,
        length: len,
        fspec_hex: toHex(fsBytes, 0, fsBytes.length),
        items,
        rawItems,
      },
      nextOffset: end,
    };
  }

  // Iterate FSPEC bits; for each bit==1, decode the corresponding UAP item
  const decMap = DECODERS[cat] || {};
  for (let i = 0; i < fsBits.length; i++) {
    if (fsBits[i] !== 1) continue;
    const itemId = uap[i]; // may be undefined if FSPEC longer than our UAP
    if (!itemId) {
      // Unknown bit position—raw eat until end? That’s unsafe. Store a flag and break.
      rawItems._excessFSPECBit = true;
      break;
    }
    const decoder = decMap[itemId];
    if (!decoder) {
      // No decoder: best effort—assume 1-octet length prefixed? That’s not safe either.
      // Instead, we can’t infer length without spec: capture the remaining bytes as raw
      // but that would swallow subsequent items. Safer choice: mark unknown and stop to
      // avoid corrupt alignment.
      rawItems[itemId] = { note: "No decoder; parsing stopped to avoid misalignment." };
      // You can choose to break or continue. Breaking minimizes cascading errors.
      break;
    }
    const { value, length } = decoder(view, cur);
    items[itemId] = value;
    cur += length;
    if (cur > end) throw new Error(`Item ${itemId} overflowed record length`);
  }

  // If remaining bytes exist (e.g., because not all FSPEC bits consumed), keep as raw tail
  if (cur < end) {
    rawItems._tail = toHex(view, cur, end - cur);
  }

  return {
    record: {
      category: cat,
      length: len,
      fspec_hex: toHex(fsBytes, 0, fsBytes.length),
      items,
      rawItems,
    },
    nextOffset: end,
  };
}

/**
 * Parse an entire buffer containing 0..N ASTERIX records.
 * Returns array of records. Stops on first structural error.
 */
function parseAsterixStream(buffer) {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const records = [];
  let off = 0;
  while (off < view.length) {
    const { record, nextOffset } = parseRecord(view, off);
    records.push(record);
    off = nextOffset;
  }
  return records;
}

// ------------------------------ Example usage --------------------------------
// (Comment out if bundling for production)
/*
const fs = require("node:fs");
const buf = fs.readFileSync("cat048_sample.bin");
const recs = parseAsterixStream(buf);
console.dir(recs, { depth: null });
*/

// ------------------------------ Exports --------------------------------------
module.exports = {
  parseAsterixStream,
  parseRecord,
  // For extension:
  CATEGORY_DEFS,
  DECODERS,
};
