import { describe, it, expect } from "vitest";
import { expandLpText, extractPhone, splitBodyIntoSections, buildLpRenderInput, LP_RENDER_INPUT_KEYS, type LpSourceRows } from "../sale-dm-letter/lp-render-input";

const rows = (over: Partial<LpSourceRows> = {}): LpSourceRows => ({
  variant: { headline: "ご所有の{{物件種別}}のご売却について", lead: "{{物件所在}}周辺で売却をご検討の方へ", bodyText: "はじめに一言。\n\n■売却の進め方\n流れの説明。\n\n二段落目。\n■費用について\n費用の説明。", faqJson: [{ q: "費用は？", a: "無料です。" }] },
  media: [
    { slot: "hero", heading: null, figureKind: null, asset: { publicId: "a".repeat(32), width: 1600, height: 900, deletedAt: null } },
    { slot: "section", heading: "売却の進め方", figureKind: "sale_flow", asset: null },
    { slot: "section", heading: "費用について", figureKind: null, asset: { publicId: "b".repeat(32), width: 1200, height: 900, deletedAt: null } },
  ],
  property: { address: "東京都世田谷区経堂1-2-3 ○○ハイツ101", propertyType: "house" },
  company: { senderName: "株式会社リガーレ", senderContact: "TEL 03-1234-5678 / info@example.com" },
  ...over,
});

describe("expandLpText", () => {
  it("町名までの所在と種別を差し込む", () => {
    expect(expandLpText("{{物件所在}}の{{物件種別}}", { location: "世田谷区経堂", propertyType: "戸建" })).toBe("世田谷区経堂の戸建");
  });
  it("解決できない記号は一般語に置換し、波括弧を残さない", () => {
    const out = expandLpText("{{物件所在}}の{{物件種別}}", { location: null, propertyType: null });
    expect(out).toBe("ご所有の物件の周辺の不動産");
    expect(out).not.toMatch(/[{}]/);
  });
});

describe("extractPhone", () => {
  it("連絡先の文字列から電話番号だけを取り出す(tel: 用にハイフン除去)", () => {
    expect(extractPhone("TEL 03-1234-5678 / info@example.com")).toBe("0312345678");
    expect(extractPhone("090 1234 5678")).toBe("09012345678");
    expect(extractPhone("info@example.com")).toBeNull();
    expect(extractPhone(null)).toBeNull();
  });
});

describe("splitBodyIntoSections", () => {
  it("最初の■より前を intro に、■ごとに段落を分ける(空行区切り・LF正規化)", () => {
    const r = splitBodyIntoSections("はじめに。\r\n\r\n■A\r\n一\r\n\r\n二\r\n■B\r\n三");
    expect(r.intro).toEqual(["はじめに。"]);
    expect(r.sections).toEqual([{ heading: "A", paragraphs: ["一", "二"] }, { heading: "B", paragraphs: ["三"] }]);
  });
  it("同じ■見出しが2回あっても2つの節として並ぶ(表示は本文どおり)", () => {
    expect(splitBodyIntoSections("■A\nx\n■A\ny").sections.length).toBe(2);
  });
});

describe("buildLpRenderInput", () => {
  it("差し込み済みの見出し/リード・節ごとの枠・ヒーロー・会社案内・電話を組み立てる", () => {
    const out = buildLpRenderInput(rows(), { mode: "live", unsubscribeUrl: "https://lp.example.com/u/x", phoneTapToken: "tok" });
    expect(out.headline).toBe("ご所有の戸建のご売却について");
    expect(out.lead).toBe("東京都世田谷区経堂周辺で売却をご検討の方へ");
    expect(out.intro).toEqual(["はじめに一言。"]);
    expect(out.sections[0]).toEqual({ heading: "売却の進め方", paragraphs: ["流れの説明。", "二段落目。"], media: { kind: "figure", figureKind: "sale_flow" } });
    expect(out.sections[1].media).toEqual({ kind: "asset", image: { publicId: "b".repeat(32), width: 1200, height: 900 } });
    expect(out.hero).toEqual({ publicId: "a".repeat(32), width: 1600, height: 900 });
    expect(out.company).toEqual({ name: "株式会社リガーレ", contact: "TEL 03-1234-5678 / info@example.com", phone: "0312345678" });
    expect(out.faq).toEqual([{ q: "費用は？", a: "無料です。" }]);
    expect(out.phoneTapToken).toBe("tok");
    expect(out.form).toBeNull();
  });
  it("削除済みの写真・知らない図・本文に無い見出しの行は枠なし(null)になる", () => {
    const out = buildLpRenderInput(rows({ media: [
      { slot: "hero", heading: null, figureKind: null, asset: { publicId: "z".repeat(32), width: 1, height: 1, deletedAt: new Date() } },
      { slot: "section", heading: "売却の進め方", figureKind: "nope", asset: null },
      { slot: "section", heading: "無い見出し", figureKind: "sale_flow", asset: null },
    ] }), { mode: "preview", unsubscribeUrl: null, phoneTapToken: null });
    expect(out.hero).toBeNull();
    expect(out.sections.map((s) => s.media)).toEqual([null, null]);
  });
  it("所在が読めない物件でも波括弧は出ない・faqJson が壊れていれば空配列", () => {
    const out = buildLpRenderInput(rows({ property: { address: null, propertyType: null }, variant: { ...rows().variant, faqJson: "broken" } }), { mode: "live", unsubscribeUrl: null, phoneTapToken: "t" });
    expect(out.headline).toBe("ご所有の不動産のご売却について");
    expect(out.lead).not.toMatch(/[{}]/);
    expect(out.faq).toEqual([]);
  });
  it("入力型のキー集合は固定(氏名・番地・所有者住所・token 以外の識別子が増えたら落ちる)", () => {
    const out = buildLpRenderInput(rows(), { mode: "live", unsubscribeUrl: null, phoneTapToken: "t" });
    expect(Object.keys(out).sort()).toEqual([...LP_RENDER_INPUT_KEYS].sort());
    expect(LP_RENDER_INPUT_KEYS).toEqual(["mode", "headline", "lead", "intro", "sections", "faq", "hero", "company", "unsubscribeUrl", "phoneTapToken", "form"]);
    for (const k of LP_RENDER_INPUT_KEYS) expect(/name|zip|address|owner|recipient/i.test(k) && k !== "company").toBe(false);
  });
});
