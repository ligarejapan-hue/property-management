import { describe, it, expect } from "vitest";
import {
  MATERIAL_SEND_LIMITS,
  selectableForMaterialSend,
  checkMaterialSelection,
  fillMaterialTemplate,
  propertyDisplayName,
  isSingleAddress,
  sendStateLabel,
  isDefiniteSmtpFailure,
  MATERIAL_SEND_LIMIT_LABEL,
  DEFAULT_MATERIAL_SUBJECT,
  type MaterialAttachmentRow,
} from "@/lib/agent-inquiry/material-send";

const PID = "11111111-1111-4111-8111-111111111111";
const row = (o: Partial<MaterialAttachmentRow> = {}): MaterialAttachmentRow => ({
  id: "a1", targetType: "property", targetId: PID, type: "general", isDeleted: false,
  fileName: "図面.pdf", fileSize: 1000, fileUrl: "/uploads/attachments/x.pdf", mimeType: "application/pdf",
  createdAt: new Date("2026-10-01T00:00:00Z"), ...o,
});
const perm = (...pairs: [string, string][]) => pairs.map(([resource, action]) => ({ resource, action, granted: true }));
const REG = perm(["registry_pdf", "preview"], ["registry_pdf", "download"]);

describe("送ってよい添付(spec §3)", () => {
  it("ふつうの添付は送れる", () => expect(selectableForMaterialSend(row(), PID, [])).toBe(true));
  it("反響資料・査定報告書は送れない", () => {
    expect(selectableForMaterialSend(row({ type: "referral" }), PID, REG)).toBe(false);
    expect(selectableForMaterialSend(row({ type: "report" }), PID, REG)).toBe(false);
  });
  it("知らない種類は送れない(許可リスト)", () => expect(selectableForMaterialSend(row({ type: "photo" }), PID, REG)).toBe(false));
  it("削除済み・別の物件・物件以外は送れない", () => {
    expect(selectableForMaterialSend(row({ isDeleted: true }), PID, [])).toBe(false);
    expect(selectableForMaterialSend(row({ targetId: "other" }), PID, [])).toBe(false);
    expect(selectableForMaterialSend(row({ targetType: "owner" }), PID, [])).toBe(false);
  });
  it("謄本は preview と download の両方が要る", () => {
    expect(selectableForMaterialSend(row({ type: "registry" }), PID, REG)).toBe(true);
    expect(selectableForMaterialSend(row({ type: "registry" }), PID, perm(["registry_pdf", "preview"]))).toBe(false);
    expect(selectableForMaterialSend(row({ type: "registry" }), PID, [])).toBe(false);
  });
});

describe("選んだ添付の確かめ", () => {
  it("1つも無いと NO_FILES", () => expect(checkMaterialSelection([], [], PID, [])).toEqual({ ok: false, code: "NO_FILES" }));
  it("21個は TOO_MANY", () => {
    const ids = Array.from({ length: 21 }, (_, i) => `a${i}`);
    expect(checkMaterialSelection(ids.map((id) => row({ id })), ids, PID, [])).toEqual({ ok: false, code: "TOO_MANY" });
  });
  it("頼んだ ID が DB に無い(他の物件・消えた)なら NOT_SELECTABLE", () => {
    expect(checkMaterialSelection([row()], ["a1", "zz"], PID, [])).toEqual({ ok: false, code: "NOT_SELECTABLE" });
  });
  it("1つでも送れないものが混ざれば NOT_SELECTABLE", () => {
    expect(checkMaterialSelection([row(), row({ id: "a2", type: "referral" })], ["a1", "a2"], PID, REG))
      .toEqual({ ok: false, code: "NOT_SELECTABLE" });
  });
  it("上限はファイルの合計 20MB(2026-10-19 発注者決定・メールでは約 27MB になることは承知の上)", () => {
    expect(MATERIAL_SEND_LIMITS.maxTotalBytes).toBe(20 * 1024 * 1024);
    expect(MATERIAL_SEND_LIMIT_LABEL).toBe("20MB");
  });
  it("合計がちょうど上限は通る・1バイト超えると TOO_LARGE", () => {
    const max = MATERIAL_SEND_LIMITS.maxTotalBytes;
    expect(checkMaterialSelection([row({ fileSize: max })], ["a1"], PID, [])).toMatchObject({ ok: true, totalSize: max });
    expect(checkMaterialSelection([row({ fileSize: max - 10 }), row({ id: "a2", fileSize: 11 })], ["a1", "a2"], PID, []))
      .toEqual({ ok: false, code: "TOO_LARGE" });
  });
  it("通ったら頼んだ順で返す", () => {
    const r = checkMaterialSelection([row({ id: "a1" }), row({ id: "a2" })], ["a2", "a1"], PID, []);
    expect(r.ok && r.rows.map((x) => x.id)).toEqual(["a2", "a1"]);
  });
});

describe("文面の差し込み(spec §4)", () => {
  const v = { propertyName: "サンプル荘 101", companyName: "△△不動産", contactName: null, senderName: "山田" };
  it("4つを全部置き換え・同じものが2回でも全部", () => {
    expect(fillMaterialTemplate("{物件名}/{物件名} {会社名} {担当者名} {自分の名前}", v))
      .toBe("サンプル荘 101/サンプル荘 101 △△不動産 ご担当者 山田");
  });
  it("知らない差し込みはそのまま", () => expect(fillMaterialTemplate("{住所}", v)).toBe("{住所}"));
  it("既定の件名", () => expect(fillMaterialTemplate(DEFAULT_MATERIAL_SUBJECT, v)).toBe("【資料送付】サンプル荘 101"));
  it("物件名=名前+部屋番号・名前が無ければ所在地", () => {
    expect(propertyDisplayName({ name: "サンプル荘", roomNo: "101", town: "品川区" })).toBe("サンプル荘 101");
    expect(propertyDisplayName({ name: null, roomNo: null, town: "品川区南品川" })).toBe("品川区南品川");
  });
});

describe("宛先は1件だけ", () => {
  it.each([["a@example.jp", true], ["a@x.jp, b@y.jp", false], ["a@x.jp\nBcc: c@z.jp", false], ["a@x.jp;b@y.jp", false], ["", false], ["山田 <a@x.jp>", false]])(
    "%s → %s",
    (to, ok) => expect(isSingleAddress(to)).toBe(ok),
  );
});

describe("記録の表示", () => {
  const now = new Date("2026-10-18T10:00:00Z");
  it("送信中は10分を過ぎると結果不明", () => {
    expect(sendStateLabel({ result: "sending", createdAt: new Date("2026-10-18T09:55:00Z") }, now)).toBe("送信中");
    expect(sendStateLabel({ result: "sending", createdAt: new Date("2026-10-18T09:49:59Z") }, now)).toBe("結果不明");
  });
  it("送信中でも、送れたか分からない失敗(errorCode あり)はすぐ結果不明(@codex 4巡目 P1)", () => {
    expect(sendStateLabel({ result: "sending", createdAt: now, errorCode: "ETIMEDOUT" }, now)).toBe("結果不明");
  });
  it("送る前に断られたとはっきり分かる失敗だけを「送れなかった」にする", () => {
    for (const c of ["EAUTH", "EENVELOPE", "EMESSAGE", "EDNS", "ETLS"]) expect(isDefiniteSmtpFailure(c)).toBe(true);
    for (const c of ["ETIMEDOUT", "ESOCKET", "ECONNECTION", "EPROTOCOL", null]) expect(isDefiniteSmtpFailure(c)).toBe(false);
  });
  it("sent/failed", () => {
    expect(sendStateLabel({ result: "sent", createdAt: now }, now)).toBe("送信済み");
    expect(sendStateLabel({ result: "failed", createdAt: now }, now)).toBe("送れなかった");
  });
});
