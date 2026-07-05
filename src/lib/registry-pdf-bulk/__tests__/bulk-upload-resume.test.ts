import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadSentKeys,
  recordSentKeys,
  clearSentKeys,
} from "../bulk-upload-resume";

function makeLocalStorageStub(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("bulk-upload-resume", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("window が無ければ no-op(空集合・throwしない)", () => {
    expect(loadSentKeys().size).toBe(0);
    recordSentKeys(["a"]);
    clearSentKeys();
    expect(loadSentKeys().size).toBe(0);
  });

  it("record→load でキーが往復し、重複は集合で吸収", () => {
    vi.stubGlobal("window", { localStorage: makeLocalStorageStub() });
    recordSentKeys(["k1", "k2"]);
    recordSentKeys(["k2", "k3"]);
    expect([...loadSentKeys()].sort()).toEqual(["k1", "k2", "k3"]);
  });

  it("clear で消える", () => {
    vi.stubGlobal("window", { localStorage: makeLocalStorageStub() });
    recordSentKeys(["k1"]);
    clearSentKeys();
    expect(loadSentKeys().size).toBe(0);
  });

  it("壊れた JSON は空集合にフォールバック", () => {
    const stub = makeLocalStorageStub();
    stub.setItem("registry-pdf-bulk:sent-keys", "{not json");
    vi.stubGlobal("window", { localStorage: stub });
    expect(loadSentKeys().size).toBe(0);
  });
});
