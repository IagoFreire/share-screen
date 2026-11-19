import { describe, expect, it } from "vitest";
import { createParameterSetKeeper } from "./parameterSets.js";

/** One Annex B NAL unit: start code, header byte (nal_ref_idc 3 + type), body. */
function nal(type: number, body: number[], startCode: number[] = [0, 0, 0, 1]): number[] {
  return [...startCode, 0x60 | type, ...body];
}
const AUD = 9;
const SEI = 6;
const SPS = 7;
const PPS = 8;
const IDR = 5;
const SLICE = 1;

const sps = nal(SPS, [0x64, 0x00, 0x1f, 0xac]);
const pps = nal(PPS, [0xee, 0x3c, 0x80]);
const idr = nal(IDR, [0x88, 0x84, 0x21, 0x43]);
const bytes = (...units: number[][]) => new Uint8Array(units.flat());

describe("parameter set keeper", () => {
  it("passes a complete keyframe through untouched", () => {
    const keeper = createParameterSetKeeper();
    const keyframe = bytes(sps, pps, idr);

    expect(keeper.complete(keyframe)).toBe(keyframe);
  });

  it("puts back the parameter sets a later keyframe came without", () => {
    // AMD's encoder writes SPS/PPS into the first frame only: a decoder started on any
    // later keyframe never gets them and silently outputs nothing.
    const keeper = createParameterSetKeeper();
    keeper.complete(bytes(sps, pps, idr));

    expect([...keeper.complete(bytes(idr))]).toEqual([...sps, ...pps, ...idr]);
  });

  it("keeps the access unit delimiter first, the SPS right after it and the PPS right before the slice", () => {
    const keeper = createParameterSetKeeper();
    keeper.complete(bytes(sps, pps, idr));
    const aud = nal(AUD, [0xf0]);
    const sei = nal(SEI, [0x05, 0x01, 0x80]);

    // An AUD, when there is one, must open the access unit (H.264 7.4.1.2.3).
    expect([...keeper.complete(bytes(aud, sei, idr))]).toEqual([...aud, ...sps, ...sei, ...pps, ...idr]);
  });

  it("adds only what is missing, after a parameter set the keyframe does carry", () => {
    const keeper = createParameterSetKeeper();
    keeper.complete(bytes(sps, pps, idr));
    const newSps = nal(SPS, [0x64, 0x00, 0x28, 0xac]); // a new size

    expect([...keeper.complete(bytes(newSps, idr))]).toEqual([...newSps, ...pps, ...idr]);
    // ...and the new one is what later keyframes get.
    expect([...keeper.complete(bytes(idr))]).toEqual([...newSps, ...pps, ...idr]);
  });

  it("reads 3-byte start codes too", () => {
    const keeper = createParameterSetKeeper();
    const short = [0, 0, 1];
    keeper.complete(bytes(nal(SPS, [0x42], short), nal(PPS, [0xce], short), nal(IDR, [0x88], short)));

    expect([...keeper.complete(bytes(nal(IDR, [0x88], short)))]).toEqual([
      ...nal(SPS, [0x42], short),
      ...nal(PPS, [0xce], short),
      ...nal(IDR, [0x88], short),
    ]);
  });

  it("leaves a keyframe alone while it has nothing to add, or when it can't find a slice", () => {
    const keeper = createParameterSetKeeper();
    const bare = bytes(idr);
    expect(keeper.complete(bare)).toBe(bare);

    keeper.complete(bytes(sps, pps, idr));
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    expect(keeper.complete(garbage)).toBe(garbage);
    const noSlice = bytes(nal(SEI, [0x05]));
    expect(keeper.complete(noSlice)).toBe(noSlice);
  });

  it("finds the slice of a keyframe whose first slice isn't an IDR one", () => {
    const keeper = createParameterSetKeeper();
    keeper.complete(bytes(sps, pps, idr));
    const iSlice = nal(SLICE, [0x88]);

    expect([...keeper.complete(bytes(iSlice))]).toEqual([...sps, ...pps, ...iSlice]);
  });
});
