/**
 * Makes every H.264 keyframe the relay forwards carry its parameter sets (SPS and PPS).
 *
 * A decoder can only start on a keyframe that comes with them. NVIDIA's encoder repeats
 * them on every keyframe; AMD's (AMF, behind Media Foundation) writes them into the
 * stream's first frame only. Viewers there from the start got them and played on; anyone
 * joining later -- or coming back to the live, or stepping to another quality -- started
 * a decoder on keyframes without them. Chromium's decoder then drops every frame without
 * an error until parameter sets show up: "N recebidos", "sem imagem ainda", erros 0, and
 * the decoder restarted for overload every couple of seconds, forever.
 *
 * So the last parameter sets are remembered and put back in front of a keyframe that came
 * without, in two places. The presenter's session does it at the source, for each
 * simulcast layer: it sees the encoder's first frame even when nobody receives it -- that
 * frame leaves before the relay has registered the broadcast. The relay does it too, per
 * presenter and layer, for clients that don't yet. Only keyframes are looked at, and only up
 * to their first slice: the parameter sets always come before it.
 */

const NAL_TYPE_MASK = 0x1f;
const NAL_SLICE = 1;
const NAL_IDR_SLICE = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_ACCESS_UNIT_DELIMITER = 9;

export interface ParameterSetKeeper {
  /** The keyframe as is, or with the remembered SPS/PPS it came without put back in. */
  complete(keyframe: Uint8Array): Uint8Array;
}

interface StartCode {
  /** The start code's first byte. */
  at: number;
  /** The NAL unit header byte right after it. */
  headerAt: number;
}

/** The next Annex B start code (00 00 01 or 00 00 00 01) from `from` on, if any. */
function nextStartCode(data: Uint8Array, from: number): StartCode | null {
  for (let i = from; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    if (data[i + 2] === 1) return { at: i, headerAt: i + 3 };
    if (data[i + 2] === 0 && data[i + 3] === 1 && i + 4 < data.length) return { at: i, headerAt: i + 4 };
  }
  return null;
}

interface LeadingUnits {
  /** SPS and PPS found before the first slice, each from its start code to the next one. */
  sps: Uint8Array | null;
  pps: Uint8Array | null;
  /** Where a missing SPS goes: after the access unit delimiter that must open the frame, if any. */
  spsAt: number;
  /** Where the first slice's start code begins; -1 when there is none. */
  firstSliceAt: number;
}

/** Reads the NAL units in front of the first slice. Emulation prevention keeps start codes out of their bodies. */
function readLeadingUnits(data: Uint8Array): LeadingUnits {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let spsAt = 0;
  let code = nextStartCode(data, 0);
  while (code) {
    const type = data[code.headerAt]! & NAL_TYPE_MASK;
    if (type === NAL_SLICE || type === NAL_IDR_SLICE) return { sps, pps, spsAt, firstSliceAt: code.at };
    const next = nextStartCode(data, code.headerAt + 1);
    const end = next ? next.at : data.length;
    if (type === NAL_SPS) sps = data.slice(code.at, end);
    else if (type === NAL_PPS) pps = data.slice(code.at, end);
    else if (type === NAL_ACCESS_UNIT_DELIMITER && code.at === 0) spsAt = end;
    code = next;
  }
  return { sps, pps, spsAt, firstSliceAt: -1 };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function createParameterSetKeeper(): ParameterSetKeeper {
  let lastSps: Uint8Array | null = null;
  let lastPps: Uint8Array | null = null;

  return {
    complete(keyframe) {
      const { sps, pps, spsAt, firstSliceAt } = readLeadingUnits(keyframe);
      if (firstSliceAt < 0) return keyframe; // not a picture this understands
      if (sps) lastSps = sps;
      if (pps) lastPps = pps;

      const addSps = sps ? null : lastSps;
      const addPps = pps ? null : lastPps;
      if (!addSps && !addPps) return keyframe;
      // The SPS as early as allowed (after a delimiter), since a PPS refers to it; the PPS
      // right before the slice, after whatever the keyframe does carry (SEI, its own SPS).
      const parts = [
        keyframe.subarray(0, spsAt),
        ...(addSps ? [addSps] : []),
        keyframe.subarray(spsAt, firstSliceAt),
        ...(addPps ? [addPps] : []),
        keyframe.subarray(firstSliceAt),
      ];
      return concat(parts);
    },
  };
}
