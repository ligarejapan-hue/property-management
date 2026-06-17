import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isRegistryOcrConfigured,
  requestOcrText,
} from "../client";

const URL_OK = "http://127.0.0.1:8089/ocr";
const ORIG = process.env.REGISTRY_OCR_URL;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

function setUrl(v: string | undefined) {
  if (v === undefined) delete process.env.REGISTRY_OCR_URL;
  else process.env.REGISTRY_OCR_URL = v;
}
function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  setUrl(ORIG);
  vi.restoreAllMocks();
});

describe("isRegistryOcrConfigured", () => {
  it("未設定で false", () => {
    setUrl(undefined);
    expect(isRegistryOcrConfigured()).toBe(false);
  });
  it("外部 URL で false", () => {
    setUrl("https://x.example.com/ocr");
    expect(isRegistryOcrConfigured()).toBe(false);
  });
  it("localhost で true", () => {
    setUrl(URL_OK);
    expect(isRegistryOcrConfigured()).toBe(true);
  });
});

describe("requestOcrText", () => {
  it("未設定 → NOT_CONFIGURED", async () => {
    setUrl(undefined);
    await expect(
      requestOcrText(PDF, vi.fn() as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("成功 → OcrResponse（localhost へ POST・redirect:error）", async () => {
    setUrl(URL_OK);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okResponse({ text: "謄本テキスト", pages: 2, warnings: [] }));
    const r = await requestOcrText(PDF, fetchFn as unknown as typeof fetch);
    expect(r.text).toBe("謄本テキスト");
    expect(r.pages).toBe(2);
    expect(fetchFn).toHaveBeenCalledWith(
      URL_OK,
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("timeout → TIMEOUT", async () => {
    setUrl(URL_OK);
    const err = new Error("t");
    err.name = "TimeoutError";
    const fetchFn = vi.fn().mockRejectedValue(err);
    await expect(
      requestOcrText(PDF, fetchFn as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("500 → UPSTREAM", async () => {
    setUrl(URL_OK);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("err", { status: 500 }));
    await expect(
      requestOcrText(PDF, fetchFn as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("response schema 不正 → BAD_RESPONSE", async () => {
    setUrl(URL_OK);
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ nope: true }));
    await expect(
      requestOcrText(PDF, fetchFn as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("size 超過 → TOO_LARGE（fetch を呼ばない）", async () => {
    setUrl(URL_OK);
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    const fetchFn = vi.fn();
    await expect(
      requestOcrText(big, fetchFn as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
