import { describe, it, expect } from "vitest";
import { toInquiryListRows, HIDDEN_NAME_PLACEHOLDER } from "@/lib/sale-dm-letter/inquiry-list";

const row = (id: string, handleStatus: string, iso: string) => ({
  id, draftId: `d-${id}`, submittedAt: new Date(iso), name: `名${id}`, phone: "090-0000-0000", email: "a@b.jp",
  contactPref: "phone", contactTime: "夜", message: "要望", handleStatus, handledAt: null, handleNote: "対応メモ",
  notifyStatus: "pending",
  notifyLastError: null as string | null,
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
  it("数字や @ を含むお名前は contact と email の両方を見られる利用者にだけそのまま返す(@codex R13 P1)", () => {
    const withContact = { ...row("a", "open", "2026-09-20T00:00:00Z"), name: "山田 090-1234-5678" };
    const withMail = { ...row("b", "open", "2026-09-20T00:00:00Z"), name: "山田 ｔａｒｏ＠ｅｘ.jp" };
    const plain = row("c", "open", "2026-09-20T00:00:00Z");
    for (const vis of [{ contact: true, email: false }, { contact: false, email: true }, { contact: false, email: false }]) {
      const out = toInquiryListRows([withContact, withMail, plain], vis);
      expect(out.map((r) => r.name)).toEqual([HIDDEN_NAME_PLACEHOLDER, HIDDEN_NAME_PLACEHOLDER, "名c"]);
    }
    const all = toInquiryListRows([withContact, withMail, plain], { contact: true, email: true });
    expect(all.map((r) => r.name)).toEqual(["山田 090-1234-5678", "山田 ｔａｒｏ＠ｅｘ.jp", "名c"]);
  });

  describe("2x2: (contact, email) の組み合わせ", () => {
    it("(true, true): 全項目を返す・freeTextHidden=false", () => {
      const [r] = toInquiryListRows([row("a", "open", "2026-09-20T00:00:00Z")], { contact: true, email: true });
      expect(r).toMatchObject({
        phone: "090-0000-0000", contactPref: "phone", contactTime: "夜",
        message: "要望", handleNote: "対応メモ", email: "a@b.jp",
        contactHidden: false, emailHidden: false, freeTextHidden: false,
      });
    });
    it("(true, false): 電話・希望連絡方法は返すが、contactTime/message/handleNote/email は自由記述扱いで伏せる・freeTextHidden=true", () => {
      const [r] = toInquiryListRows([row("a", "open", "2026-09-20T00:00:00Z")], { contact: true, email: false });
      expect(r).toMatchObject({
        phone: "090-0000-0000", contactPref: "phone", contactTime: null,
        message: null, handleNote: null, email: null,
        contactHidden: false, emailHidden: true, freeTextHidden: true,
      });
    });
    it("(false, true): email は返すが、構造化項目(電話等)と contactTime/message/handleNote は伏せる・freeTextHidden=true", () => {
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

  it("notifyStatus は個人情報ではないので表示権限に関わらずそのまま返す(伏せない・発注者判断 2026-09-18)", () => {
    const src = { ...row("a", "open", "2026-09-20T00:00:00Z"), notifyStatus: "failed" };
    for (const visibility of [
      { contact: true, email: true },
      { contact: true, email: false },
      { contact: false, email: true },
      { contact: false, email: false },
    ]) {
      expect(toInquiryListRows([src], visibility)[0].notifyStatus).toBe("failed");
    }
  });

  // whole-branch review Minor #5: notifyLastError も notifyStatus と同じ扱い(個人情報を
  // 含まない固定の内部コードなので、表示権限に関わらずそのまま返す)。
  it("notifyLastError も表示権限に関わらずそのまま返す(伏せない)", () => {
    const src = { ...row("a", "open", "2026-09-20T00:00:00Z"), notifyStatus: "failed", notifyLastError: "no_recipients" };
    for (const visibility of [
      { contact: true, email: true },
      { contact: true, email: false },
      { contact: false, email: true },
      { contact: false, email: false },
    ]) {
      expect(toInquiryListRows([src], visibility)[0].notifyLastError).toBe("no_recipients");
    }
    const noError = row("b", "open", "2026-09-20T00:00:00Z");
    expect(toInquiryListRows([noError], { contact: false, email: false })[0].notifyLastError).toBeNull();
  });

  it("対応メモ(handleNote)は折り返し番号などを含みうるため message と同じ (contact && email) で伏せる(@codex R10 P1)", () => {
    const src = { ...row("a", "open", "2026-09-20T00:00:00Z"), handleNote: "折り返し 090-1111-2222" };
    expect(toInquiryListRows([src], { contact: true, email: true })[0].handleNote).toBe("折り返し 090-1111-2222");
    expect(toInquiryListRows([src], { contact: true, email: false })[0].handleNote).toBeNull();
    expect(toInquiryListRows([src], { contact: false, email: true })[0].handleNote).toBeNull();
    expect(toInquiryListRows([src], { contact: false, email: false })[0].handleNote).toBeNull();
  });

  // 連絡のつきやすい時間帯(contactTime)は自由入力欄で、申込者がメールアドレス等を
  // 書き込める(構造化項目ではない)ため、message/handleNote と同じ自由記述グループに入れ
  // freeTextHidden(contact && email の両方)で伏せる(@codex L1 P1)。contactPref(enum)は
  // 引き続き contact だけで決まる構造化項目のまま。
  it("時間帯(contactTime)は自由記述なので freeTextHidden(contact && email)で伏せる(@codex L1 P1)", () => {
    const src = { ...row("a", "open", "2026-09-20T00:00:00Z"), contactTime: "夜(携帯: foo@example.com へ連絡)" };
    expect(toInquiryListRows([src], { contact: true, email: true })[0]).toMatchObject({ contactTime: "夜(携帯: foo@example.com へ連絡)", freeTextHidden: false });
    for (const visibility of [{ contact: true, email: false }, { contact: false, email: true }, { contact: false, email: false }]) {
      const [r] = toInquiryListRows([src], visibility);
      expect(r.freeTextHidden).toBe(true);
      expect(r.contactTime).toBeNull();
    }
  });
});
