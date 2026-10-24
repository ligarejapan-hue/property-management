import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ default: {} }));

import { sendsDownloadIntent } from "../download-intent";
import { OWNER_PII_DOC_KINDS, OWNER_PII_DOCUMENT_TYPES } from "@/lib/uploads-authorization";

describe("sendsDownloadIntent(ダウンロードで保存として受け取らせる書類)", () => {
  it.each(["registry", "referral", "report"])("★%s は download=1 を付ける(@codex PR#500 16巡目)", (type) => {
    expect(sendsDownloadIntent({ type })).toBe(true);
    expect(sendsDownloadIntent({ type, docKind: null })).toBe(true);
  });
  it.each(["general", null, undefined])("%s は付けない(従来どおり)", (type) => {
    expect(sendsDownloadIntent({ type })).toBe(false);
    expect(sendsDownloadIntent({ type, docKind: "sales_contract" })).toBe(false);
  });
  it("★本人確認書類(general でも docKind=identity_document)は付ける=サーバーの定型名で保存させる(@codex PR#571)", () => {
    expect(sendsDownloadIntent({ type: "general", docKind: "identity_document" })).toBe(true);
  });
  it("★守りの判定(uploads-authorization の PII の type / docKind)と食い違わない(画面側はサーバー専用の部品を読めないので別に書いている)", () => {
    for (const type of OWNER_PII_DOCUMENT_TYPES) expect(sendsDownloadIntent({ type })).toBe(true);
    for (const docKind of OWNER_PII_DOC_KINDS) expect(sendsDownloadIntent({ type: "general", docKind })).toBe(true);
  });
});
