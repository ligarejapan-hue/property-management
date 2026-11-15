import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { BelongingsAddNotice, BlockingNotice, PartyReceiptNotes, ReadyNotice, restoredValuesOf } from "../business-docs-section";
import { NEEDS_SELLER_PARTY } from "@/lib/deals/documents/business/receipt-issuer";

describe("領収書の小窓の知らせ(2026-11-05 発注者)", () => {
  it("空欄で出る部分を並べる・止めない(role=status)", () => {
    const html = renderToStaticMarkup(<PartyReceiptNotes notes={["契約日が未入力のため、日付は空欄で出ます"]} />);
    expect(html).toContain("契約日が未入力のため、日付は空欄で出ます");
    expect(html).toContain('role="status"');
  });
  it("知らせが無ければ何も出さない", () => {
    expect(renderToStaticMarkup(<PartyReceiptNotes notes={[]} />)).toBe("");
  });
  it("自社を発行者に選んでいる間・選べる発行者がいない間は出さない", () => {
    const src = readFileSync(join(process.cwd(), "src/components/deals/business-docs-section.tsx"), "utf8");
    expect(src).toContain('{issuer && values.issuer !== "self" && <PartyReceiptNotes notes={(choices.partyNotes ?? []).map((n) => n.label)} />}');
  });
});

describe("発行できない理由の表示(2026-11-06 発注者)", () => {
  it("売主の当事者がいない手付金・残金の領収書は「売主を当事者に登録すると発行できます」", () => {
    const html = renderToStaticMarkup(<BlockingNotice blocking={[NEEDS_SELLER_PARTY]} />);
    expect(html).toContain("売主を当事者に登録すると発行できます");
    expect(html).not.toContain("が無いと出せません");
    expect(html).toContain('role="alert"');
  });
  it("ほかの止める項目は今までどおり・両方あれば両方出す", () => {
    expect(renderToStaticMarkup(<BlockingNotice blocking={["手付金の金額"]} />)).toContain("手付金の金額が無いと出せません。取引の画面で入れてください。");
    const both = renderToStaticMarkup(<BlockingNotice blocking={["手付金の金額", NEEDS_SELLER_PARTY]} />);
    expect(both).toContain("手付金の金額が無いと出せません。");
    expect(both).toContain("売主を当事者に登録すると発行できます");
    expect(both).not.toContain(`${NEEDS_SELLER_PARTY}が無いと`);
  });
  it("何も無ければ出さない", () => {
    expect(renderToStaticMarkup(<BlockingNotice blocking={[]} />)).toBe("");
  });
});

describe("契約のご案内: 今の当事者での初めの値に足りない行の知らせ(2026-11-15 発注者)", () => {
  it("足りない行を並べて「足す」ボタンを出す(止めない・role=status)", () => {
    const html = renderToStaticMarkup(<BelongingsAddNotice lines={["委任状", "実印"]} onAdd={() => {}} />);
    expect(html).toContain("今の当事者では「委任状」「実印」も初めの値に入ります。");
    expect(html).toContain("足す</button>");
    expect(html).toContain('type="button"');
    expect(html).toContain('role="status"');
  });
  it("足りない行が無ければ何も出さない", () => {
    expect(renderToStaticMarkup(<BelongingsAddNotice lines={[]} onAdd={() => {}} />)).toBe("");
  });
});

describe("出す前の確認の一言(2026-11-15)", () => {
  it("準備チェックリストで種類を選んでいない間は「種類を選んでください。」(そろっています とは言わない)", () => {
    const html = renderToStaticMarkup(<ReadyNotice needsKind />);
    expect(html).toContain("種類を選んでください。");
    expect(html).not.toContain("必要な項目はそろっています。");
  });
  it("それ以外は今までどおり「必要な項目はそろっています。」", () => {
    const html = renderToStaticMarkup(<ReadyNotice needsKind={false} />);
    expect(html).toContain("必要な項目はそろっています。");
    expect(html).not.toContain("種類を選んでください。");
  });
  it("種類を選ぶまで押せない条件と同じ条件で切り替える", () => {
    const src = readFileSync(join(process.cwd(), "src/components/deals/business-docs-section.tsx"), "utf8");
    expect(src).toContain('<ReadyNotice needsKind={doc.docType === "prep_checklist" && !str(values.kind)} />');
  });
});

describe("入力の途中の控えから続けるとき(2026-11-06)", () => {
  const issuers = [{ value: "p1", label: "架空 一郎", individual: true }];
  const initial = { issuer: "p1", exempt: null, receivedOn: null };
  it("控えの発行者が今は選べない(前の「自社」)なら初めの値に戻し、知らせる", () => {
    const r = restoredValuesOf({ form: null, issuers }, { issuer: "self", exempt: null, receivedOn: "2026-11-20" }, initial);
    expect(r).toEqual({ values: { issuer: "p1", exempt: null, receivedOn: "2026-11-20" }, dropped: true });
  });
  it("選べる発行者ならそのまま・発行者の無い書類は今までどおり", () => {
    const saved = { issuer: "p1", exempt: "yes", receivedOn: null };
    expect(restoredValuesOf({ form: null, issuers }, saved, initial)).toEqual({ values: saved, dropped: false });
    expect(restoredValuesOf({ form: null, issuers: null }, { x: 1 }, {})).toEqual({ values: { x: 1 }, dropped: false });
  });
});
