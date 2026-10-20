import { describe, expect, it } from "vitest";
import { toIpcResult } from "./ipcResult.js";

describe("toIpcResult", () => {
  it("wraps a resolved value", async () => {
    expect(await toIpcResult(Promise.resolve(42))).toEqual({ ok: true, value: 42 });
  });

  it("carries a rejection's message as-is, so the page can show it", async () => {
    const result = await toIpcResult(Promise.reject(new Error("O login não foi concluído. Tente de novo.")));
    expect(result).toEqual({ ok: false, message: "O login não foi concluído. Tente de novo." });
  });

  it("uses a generic pt-BR message for non-Error rejections", async () => {
    expect(await toIpcResult(Promise.reject("boom"))).toEqual({ ok: false, message: "Algo deu errado. Tente de novo." });
  });
});
