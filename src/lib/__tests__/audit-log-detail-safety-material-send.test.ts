/**
 * audit-log-detail-safety: 資料送付の監査(@codex 9巡目 P2)。
 * route が実際に書くキー(files / totalSize / outcome / statusChanged / inquiryId / sendId)が
 * 監査ログの画面で読めること。宛先・ファイル名は書かない設計(書いても消える)。
 */
import { describe, it, expect } from "vitest";
import { sanitizeAuditDetail, REDACTED } from "@/lib/audit-log-detail-safety";

describe("資料送付の監査の中身が監査ログ画面で読める", () => {
  it("agent_inquiry_material_send: ファイル数・合計・結果・状態が変わったか", () => {
    expect(
      sanitizeAuditDetail("agent_inquiry_material_send", { files: 2, totalSize: 3000, outcome: "unknown", statusChanged: true }),
    ).toEqual({ files: 2, totalSize: 3000, outcome: "unknown", statusChanged: true });
  });
  it("registry_pdf_mail_send: どの反響のどの送信か", () => {
    expect(sanitizeAuditDetail("registry_pdf_mail_send", { inquiryId: "i1", sendId: "s1" })).toEqual({ inquiryId: "i1", sendId: "s1" });
  });
  it("agent_inquiry_material_apply: 状態が変わったか", () => {
    expect(sanitizeAuditDetail("agent_inquiry_material_apply", { statusChanged: false, contactChanged: true })).toEqual({
      statusChanged: false,
      contactChanged: true,
    });
  });
  it("宛先・ファイル名は書かれても消える", () => {
    expect(sanitizeAuditDetail("agent_inquiry_material_send", { toAddress: "a@x.jp", fileName: "謄本.pdf" })).toEqual({
      toAddress: REDACTED,
      fileName: REDACTED,
    });
  });
});
