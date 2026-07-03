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
