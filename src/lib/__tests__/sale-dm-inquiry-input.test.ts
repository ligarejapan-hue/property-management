import { describe, it, expect } from "vitest";
import { parseInquiryForm, INQUIRY_ERROR_MESSAGES, HONEYPOT_FIELD } from "@/lib/sale-dm-letter/inquiry-input";

const form = (v: Record<string, string>) => (k: string) => (k in v ? v[k] : null);
const OK = { name: "山田 太郎", phone: "090-1234-5678", consent: "yes" };

describe("parseInquiryForm", () => {
  it("必須だけで通る(任意は null)", () => {
    expect(parseInquiryForm(form(OK))).toEqual({
      kind: "ok",
      value: { name: "山田 太郎", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: null },
    });
  });
  it("全角の数字・ハイフンは半角にそろえる。前後の空白は落とす", () => {
    const r = parseInquiryForm(form({ ...OK, name: "  山田  ", phone: "０９０ー１２３４ー５６７８" }));
    expect(r).toMatchObject({ kind: "ok", value: { name: "山田", phone: "090-1234-5678" } });
  });
  it("honeypot の欄名は自動入力に狙われにくい名前(website/URL 系ではない)", () => {
    expect(HONEYPOT_FIELD).toBe("hp_extra_note");
  });
  it("honeypot が埋まっていれば bot(他の不備より先に判定)", () => {
    expect(parseInquiryForm(form({ [HONEYPOT_FIELD]: "http://spam" }))).toEqual({ kind: "bot" });
  });
  it("必須の欠落と同意なしをまとめて返す", () => {
    const r = parseInquiryForm(form({}));
    expect(r).toEqual({ kind: "invalid", errors: ["name_required", "phone_required", "consent_required"] });
  });
  it("上限超過", () => {
    const r = parseInquiryForm(form({ ...OK, name: "あ".repeat(51), contactTime: "a".repeat(61), message: "b".repeat(1001) }));
    expect(r).toEqual({ kind: "invalid", errors: ["name_too_long", "contact_time_too_long", "message_too_long"] });
  });
  it("電話番号: 数字/ハイフン/+/空白以外、20字超、数字10桁未満はいずれも不正", () => {
    for (const phone of ["090-1234-567a", "0".repeat(21), "03-1234-567", "(03)1234-5678"]) {
      expect(parseInquiryForm(form({ ...OK, phone }))).toEqual({ kind: "invalid", errors: ["phone_invalid"] });
    }
    expect(parseInquiryForm(form({ ...OK, phone: "+81 90 1234 5678" }))).toMatchObject({ kind: "ok", value: { phone: "+819012345678" } });
    // 発注者決定(2026-09-26): 保存はハイフンありにそろえる(区切る位置は携帯/固定で違う=市外局番の表で判定)。
    expect(parseInquiryForm(form({ ...OK, phone: "090　1234　5678" }))).toMatchObject({ kind: "ok", value: { phone: "090-1234-5678" } });
    expect(parseInquiryForm(form({ ...OK, phone: "09012345678" }))).toMatchObject({ kind: "ok", value: { phone: "090-1234-5678" } });
    expect(parseInquiryForm(form({ ...OK, phone: "0466123456" }))).toMatchObject({ kind: "ok", value: { phone: "0466-12-3456" } });
  });
  it("メール: 形式不正・254字超は不正。空は null", () => {
    expect(parseInquiryForm(form({ ...OK, email: "not-mail" }))).toEqual({ kind: "invalid", errors: ["email_invalid"] });
    expect(parseInquiryForm(form({ ...OK, email: `${"a".repeat(250)}@x.jp` }))).toEqual({ kind: "invalid", errors: ["email_invalid"] });
    expect(parseInquiryForm(form({ ...OK, email: "  " }))).toMatchObject({ kind: "ok", value: { email: null } });
  });
  it("希望連絡方法: 列挙外は不正・メール希望なのにメールが空は不正", () => {
    expect(parseInquiryForm(form({ ...OK, contactPref: "fax" }))).toEqual({ kind: "invalid", errors: ["contact_pref_invalid"] });
    expect(parseInquiryForm(form({ ...OK, contactPref: "email" }))).toEqual({ kind: "invalid", errors: ["email_required_for_pref"] });
    expect(parseInquiryForm(form({ ...OK, contactPref: "email", email: "a@b.jp" }))).toMatchObject({ kind: "ok", value: { contactPref: "email", email: "a@b.jp" } });
  });
  it("制御文字は落とす(要望の改行は残す)", () => {
    const r = parseInquiryForm(form({ ...OK, name: "山田\u0000太郎", message: "一行目\r\n二行目\u0007" }));
    expect(r).toMatchObject({ kind: "ok", value: { name: "山田太郎", message: "一行目\n二行目" } });
  });
  it("お名前に数字や @ (全角含む)があれば name_invalid(連絡先を名前欄に書かせない・@codex R13)", () => {
    for (const name of ["山田 090-1234-5678", "山田０９０", "taro@example.jp", "山田＠example"]) {
      expect(parseInquiryForm(form({ ...OK, name }))).toEqual({ kind: "invalid", errors: ["name_invalid"] });
    }
    expect(parseInquiryForm(form({ ...OK, name: "山田・太郎 (やまだ)" }))).toMatchObject({ kind: "ok" });
  });
  it("同意は consent=yes のときだけ", () => {
    expect(parseInquiryForm(form({ ...OK, consent: "no" }))).toEqual({ kind: "invalid", errors: ["consent_required"] });
  });
  it("すべてのエラーに日本語の文言がある", () => {
    const keys = ["name_required", "name_too_long", "name_invalid", "phone_required", "phone_invalid", "email_invalid", "email_required_for_pref", "contact_pref_invalid", "contact_time_too_long", "message_too_long", "consent_required"] as const;
    for (const k of keys) expect(INQUIRY_ERROR_MESSAGES[k].length).toBeGreaterThan(0);
  });
});
