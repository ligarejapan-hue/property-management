import { describe, it, expect } from "vitest";
import { parseLocalhostOcrUrl, isLocalhostOcrUrl } from "../url-allowlist";

describe("parseLocalhostOcrUrl / isLocalhostOcrUrl (strict localhost allowlist)", () => {
  it("http://127.0.0.1:PORT/ocr を許可", () => {
    expect(isLocalhostOcrUrl("http://127.0.0.1:8089/ocr")).toBe(true);
  });
  it("http://localhost:PORT/ocr を許可", () => {
    expect(isLocalhostOcrUrl("http://localhost:8089/ocr")).toBe(true);
  });
  it("https は拒否（egress 防止）", () => {
    expect(isLocalhostOcrUrl("https://127.0.0.1:8089/ocr")).toBe(false);
  });
  it("外部ドメインは拒否", () => {
    expect(isLocalhostOcrUrl("http://ocr.example.com/ocr")).toBe(false);
  });
  it("private / LAN IP は拒否", () => {
    expect(isLocalhostOcrUrl("http://192.168.1.10:8089/ocr")).toBe(false);
    expect(isLocalhostOcrUrl("http://10.0.0.5:8089/ocr")).toBe(false);
    expect(isLocalhostOcrUrl("http://172.16.0.5:8089/ocr")).toBe(false);
  });
  it("任意ホスト(*.internal)は拒否", () => {
    expect(isLocalhostOcrUrl("http://ocr.internal:8089/ocr")).toBe(false);
  });
  it("suffix 偽装は拒否", () => {
    expect(isLocalhostOcrUrl("http://127.0.0.1.evil.com/ocr")).toBe(false);
    expect(isLocalhostOcrUrl("http://localhost.evil.com/ocr")).toBe(false);
  });
  it("::1 は拒否（127.0.0.1 / localhost のみ）", () => {
    expect(isLocalhostOcrUrl("http://[::1]:8089/ocr")).toBe(false);
  });
  it("資格情報埋め込みは拒否", () => {
    expect(isLocalhostOcrUrl("http://user:pass@127.0.0.1:8089/ocr")).toBe(false);
  });
  it("path が /ocr 以外は拒否（env typo で別サービスへ送らない）", () => {
    expect(isLocalhostOcrUrl("http://127.0.0.1:3000/anything")).toBe(false);
    expect(isLocalhostOcrUrl("http://127.0.0.1:8089/")).toBe(false);
    expect(isLocalhostOcrUrl("http://127.0.0.1:8089/ocr/extra")).toBe(false);
  });
  it("query / hash 付きは拒否", () => {
    expect(isLocalhostOcrUrl("http://127.0.0.1:8089/ocr?x=1")).toBe(false);
    expect(isLocalhostOcrUrl("http://127.0.0.1:8089/ocr#h")).toBe(false);
  });
  it("空 / 不正 / null / undefined は null", () => {
    expect(parseLocalhostOcrUrl("")).toBeNull();
    expect(parseLocalhostOcrUrl("   ")).toBeNull();
    expect(parseLocalhostOcrUrl("not a url")).toBeNull();
    expect(parseLocalhostOcrUrl(null)).toBeNull();
    expect(parseLocalhostOcrUrl(undefined)).toBeNull();
  });
});
