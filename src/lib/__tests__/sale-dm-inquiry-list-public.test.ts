import { describe, it, expect } from "vitest";
import { toInquiryListRows } from "@/lib/sale-dm-letter/inquiry-list";
import { filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/field-staff-scope";

const row = (over: Record<string, unknown> = {}) => ({
  id: "i1", draftId: null as string | null, submittedAt: new Date("2026-10-20T00:00:00Z"), name: "山田", phone: "090-0000-0000", email: "a@b.jp",
  contactPref: "phone", contactTime: "夜", message: "要望", handleStatus: "open", handledAt: null, handleNote: "メモ",
  notifyStatus: "pending", notifyLastError: null as string | null, autoReplyStatus: "sent",
  source: "public", propertyAddress: "世田谷区経堂1-2-3",
  ...over,
});

describe("toInquiryListRows(広告ページからの申込)", () => {
  it("宛先なし(draftId=null)の行をそのまま通し、出どころと所在地を返す", () => {
    const [r] = toInquiryListRows([row()], { contact: true, email: true });
    expect(r.draftId).toBeNull();
    expect(r.source).toBe("public");
    expect(r.propertyAddress).toBe("世田谷区経堂1-2-3");
  });
  it("所在地は自由記述と同じ扱い=電話とメールの両方を見られる人にだけ返す", () => {
    expect(toInquiryListRows([row()], { contact: false, email: true })[0].propertyAddress).toBeNull();
    expect(toInquiryListRows([row()], { contact: true, email: false })[0].propertyAddress).toBeNull();
    expect(toInquiryListRows([row()], { contact: false, email: false })[0].propertyAddress).toBeNull();
  });
});

describe("filterDraftsByFieldStaffScope(物件の無い行)", () => {
  const withProp = { property: { createdBy: "u1", assignedTo: null } };
  const noProp = { property: null };
  it("現地担当は物件の無い行(広告ページの申込)を見られない。担当物件の行は見られる", () => {
    expect(filterDraftsByFieldStaffScope([withProp, noProp], { id: "u1", role: "field_staff" })).toEqual([withProp]);
  });
  it("現地担当でなければ物件の無い行も通す", () => {
    expect(filterDraftsByFieldStaffScope([withProp, noProp], { id: "u9", role: "admin" })).toEqual([withProp, noProp]);
  });
});
