import { describe, it, expect } from "vitest";
import { toInquiryListRows } from "@/lib/sale-dm-letter/inquiry-list";

const row = (id: string, handleStatus: string, iso: string) => ({
  id, draftId: `d-${id}`, submittedAt: new Date(iso), name: `名${id}`, phone: "090-0000-0000", email: "a@b.jp",
  contactPref: "phone", contactTime: "夜", message: "要望", handleStatus, handledAt: null, handleNote: "対応メモ",
});

describe("toInquiryListRows", () => {
  it("並べ替えはしない(DB の submittedAt desc, id desc の順をそのまま保つ)", () => {
    const out = toInquiryListRows([
      row("a", "done", "2026-09-20T00:00:00Z"),
      row("b", "open", "2026-09-18T00:00:00Z"),
      row("c", "in_progress", "2026-09-21T00:00:00Z"),
    ], { contact: false, email: false });
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(out.every((r) => r.phone === null && r.contactHidden)).toBe(true);
  });

  // message/handleNote(自由記述・メールアドレス等を含みうる)は contact と email の
  // 両方が揃ったときだけ返す(@codex R10 P1)。構造化項目(phone/contactPref/contactTime)は
  // 従来どおり contact だけで決まり、email は email だけで決まる(互いに独立)。
  describe("2x2: (contact, email) の組み合わせ", () => {
    it("(true, true): 全項目を返す・freeTextHidden=false", () => {
      const [r] = toInquiryListRows([row("a", "open", "2026-09-20T00:00:00Z")], { contact: true, email: true });
      expect(r).toMatchObject({
        phone: "090-0000-0000", contactPref: "phone", contactTime: "夜",
        message: "要望", handleNote: "対応メモ", email: "a@b.jp",
        contactHidden: false, emailHidden: false, freeTextHidden: false,
      });
    });
    it("(true, false): 構造化項目(電話等)は返すが、message/handleNote/email は伏せる・freeTextHidden=true", () => {
      const [r] = toInquiryListRows([row("a", "open", "2026-09-20T00:00:00Z")], { contact: true, email: false });
      expect(r).toMatchObject({
        phone: "090-0000-0000", contactPref: "phone", contactTime: "夜",
        message: null, handleNote: null, email: null,
        contactHidden: false, emailHidden: true, freeTextHidden: true,
      });
    });
    it("(false, true): email は返すが、構造化項目(電話等)と message/handleNote は伏せる・freeTextHidden=true", () => {
      const [r] = toInquiryListRows([row("a", "open", "2026-09-20T00:00:00Z")], { contact: false, email: true });
      expect(r).toMatchObject({
        phone: null, contactPref: null, contactTime: null,
        message: null, handleNote: null, email: "a@b.jp",
        contactHidden: true, emailHidden: false, freeTextHidden: true,
      });
    });
    it("(false, false): 名前と日時と状態以外は全て伏せる・3フラグとも true", () => {
      const [r] = toInquiryListRows([row("a", "open", "2026-09-20T00:00:00Z")], { contact: false, email: false });
      expect(r).toMatchObject({
        name: "名a", phone: null, contactPref: null, contactTime: null,
        message: null, handleNote: null, email: null,
        contactHidden: true, emailHidden: true, freeTextHidden: true,
      });
    });
  });

  it("対応メモ(handleNote)は折り返し番号などを含みうるため message と同じ (contact && email) で伏せる(@codex R10 P1)", () => {
    const src = { ...row("a", "open", "2026-09-20T00:00:00Z"), handleNote: "折り返し 090-1111-2222" };
    expect(toInquiryListRows([src], { contact: true, email: true })[0].handleNote).toBe("折り返し 090-1111-2222");
    expect(toInquiryListRows([src], { contact: true, email: false })[0].handleNote).toBeNull();
    expect(toInquiryListRows([src], { contact: false, email: true })[0].handleNote).toBeNull();
    expect(toInquiryListRows([src], { contact: false, email: false })[0].handleNote).toBeNull();
  });
});
