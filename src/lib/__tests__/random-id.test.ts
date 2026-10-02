import { describe, it, expect } from "vitest";
import { safeRandomId } from "../random-id";

describe("safeRandomId", () => {
  it("非空の文字列を返し、連続呼び出しで一意", () => {
    const a = safeRandomId();
    const b = safeRandomId();
    expect(a).toBeTruthy();
    expect(typeof a).toBe("string");
    expect(a).not.toBe(b);
  });

  it("crypto.randomUUID 未対応(HTTP等)でもフォールバックで ID を返す", () => {
    const original = globalThis.crypto;
    // secure context 外を模擬: randomUUID を持たない crypto に差し替え
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      const id = safeRandomId();
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});

import { vi } from "vitest";
import { safeUuidV4 } from "@/lib/random-id";
import { z } from "zod";
describe("safeUuidV4(押し直しの鍵=サーバーは UUID の形だけを受ける)", () => {
  const isUuid = (s: string) => z.string().uuid().safeParse(s).success;
  it("いつもの環境で UUID v4 の形", () => {
    const id = safeUuidV4();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("4");
  });
  it("★平文 HTTP(crypto.randomUUID が無い)でも UUID v4 の形(登録が 422 で落ちない)", () => {
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 255; return a; } });
    try {
      const id = safeUuidV4();
      expect(isUuid(id)).toBe(true);
      expect(id[14]).toBe("4");
      expect("89ab").toContain(id[19]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("crypto がまったく無い環境でも UUID v4 の形", () => {
    vi.stubGlobal("crypto", undefined);
    try {
      expect(isUuid(safeUuidV4())).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
