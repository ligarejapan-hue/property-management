import { describe, it, expect } from "vitest";
import { toInquiryListRows } from "@/lib/sale-dm-letter/inquiry-list";

const row = (id: string, handleStatus: string, iso: string) => ({
  id, draftId: `d-${id}`, submittedAt: new Date(iso), name: `名${id}`, phone: "090-0000-0000", email: "a@b.jp",
  contactPref: "phone", contactTime: "夜", message: "要望", handleStatus, handledAt: null, handleNote: null,
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
  it("連絡先を見る権限が無ければ、名前と日時と状態だけ(連絡先系は null・contactHidden=true・emailHidden=true)", () => {
    const [r] = toInquiryListRows([row("a", "open", "2026-09-20T00:00:00Z")], { contact: false, email: true });
    expect(r).toMatchObject({ name: "名a", phone: null, email: null, contactPref: null, contactTime: null, message: null, contactHidden: true, emailHidden: true });
  });
  it("連絡先を見る権限が無ければ、対応メモ(handleNote)も伏せる(折り返し番号を含みうる・@codex P1)", () => {
    const [r] = toInquiryListRows([{ ...row("a", "open", "2026-09-20T00:00:00Z"), handleNote: "折り返し 090-1111-2222" }], { contact: false, email: true });
    expect(r.handleNote).toBeNull();
  });
  it("連絡先を見る権限があれば対応メモを返す(メールだけ伏せる権限でも返す)", () => {
    const src = { ...row("a", "open", "2026-09-20T00:00:00Z"), handleNote: "折り返し済み" };
    expect(toInquiryListRows([src], { contact: true, email: true })[0].handleNote).toBe("折り返し済み");
    expect(toInquiryListRows([src], { contact: true, email: false })[0].handleNote).toBe("折り返し済み");
  });
  it("電話は見られるがメールは見られない権限では、電話等は返りメールだけ伏せる(contactHidden=false・emailHidden=true)", () => {
    const [r] = toInquiryListRows([row("a", "open", "2026-09-20T00:00:00Z")], { contact: true, email: false });
    expect(r).toMatchObject({ phone: "090-0000-0000", email: null, contactPref: "phone", contactTime: "夜", message: "要望", contactHidden: false, emailHidden: true });
  });
  it("両方の権限があれば全項目・contactHidden=false・emailHidden=false", () => {
    const [r] = toInquiryListRows([row("a", "open", "2026-09-20T00:00:00Z")], { contact: true, email: true });
    expect(r).toMatchObject({ phone: "090-0000-0000", email: "a@b.jp", message: "要望", contactHidden: false, emailHidden: false });
  });
});
