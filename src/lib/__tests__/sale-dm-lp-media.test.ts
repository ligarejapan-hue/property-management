import { describe, it, expect } from "vitest";
import { validateMediaPlan, mediaPlanIssueMessage, reconcileSectionMedia, referencedAssetIds, buildImagePrompt, LP_MEDIA_MAX_ASSETS, type MediaPlan } from "../sale-dm-letter/lp-media";

const H = ["売却の進め方", "費用について", "よくある不安"];
const plan = (over: Partial<MediaPlan> = {}): MediaPlan => ({
  hero: { assetId: "a1" },
  sections: [
    { heading: "売却の進め方", media: { kind: "figure", figureKind: "sale_flow" } },
    { heading: "費用について", media: { kind: "asset", assetId: "a2" } },
  ],
  ...over,
});

describe("validateMediaPlan", () => {
  it("小見出しが本文に無ければ UNKNOWN_HEADING、重複は DUPLICATE_HEADING", () => {
    expect(validateMediaPlan(plan({ sections: [{ heading: "無い見出し", media: null }] }), H)).toEqual({ code: "UNKNOWN_HEADING", heading: "無い見出し" });
    expect(validateMediaPlan(plan({ sections: [{ heading: "費用について", media: null }, { heading: "費用について", media: null }] }), H)).toEqual({ code: "DUPLICATE_HEADING", heading: "費用について" });
  });
  it("写真は合計10枚まで(ヒーロー含む・同じ写真の再利用は1枚と数える)", () => {
    const many = Array.from({ length: LP_MEDIA_MAX_ASSETS }, (_, i) => ({ heading: `h${i}`, media: { kind: "asset" as const, assetId: `x${i}` } }));
    const headings = many.map((s) => s.heading);
    expect(validateMediaPlan({ hero: { assetId: "hero" }, sections: many }, headings)).toEqual({ code: "TOO_MANY_ASSETS", limit: 10 });
    expect(validateMediaPlan({ hero: { assetId: "x0" }, sections: many }, headings)).toBeNull();
  });
  it("知らない図の種類は UNKNOWN_FIGURE", () => {
    const p = plan({ sections: [{ heading: "売却の進め方", media: { kind: "figure", figureKind: "nope" as never } }] });
    expect(validateMediaPlan(p, H)).toEqual({ code: "UNKNOWN_FIGURE", figureKind: "nope" });
  });
  it("正常なら null・メッセージは日本語", () => {
    expect(validateMediaPlan(plan(), H)).toBeNull();
    expect(mediaPlanIssueMessage({ code: "TOO_MANY_ASSETS", limit: 10 })).toContain("10");
  });
});

describe("reconcileSectionMedia(貼り直しで小見出しが変わったとき)", () => {
  it("見出しが一致する行だけ引き継ぎ、無くなった行は落とし、新しい見出しは未設定で足す", () => {
    const out = reconcileSectionMedia(H, ["費用について", "新しい節", "売却の進め方"], plan().sections);
    expect(out).toEqual([
      { heading: "費用について", media: { kind: "asset", assetId: "a2" } },
      { heading: "新しい節", media: null },
      { heading: "売却の進め方", media: { kind: "figure", figureKind: "sale_flow" } },
    ]);
  });
  it("見出しが全部消えたら空", () => {
    expect(reconcileSectionMedia(H, [], plan().sections)).toEqual([]);
  });
});

describe("referencedAssetIds", () => {
  it("ヒーローと節の写真を重複なしで返す(図は含めない)", () => {
    expect(referencedAssetIds(plan())).toEqual(["a1", "a2"]);
    expect(referencedAssetIds({ hero: null, sections: [] })).toEqual([]);
  });
});

describe("buildImagePrompt", () => {
  const base = { leadSummary: "ご所有の{{物件種別}}の相場と進め方", appeal: "inheritance", propertyKind: "house", style: "photo" as const };
  it("枠に合った縦横比と画風・決まり文句・英語の定型行を含む", () => {
    const hero = buildImagePrompt({ ...base, slot: { kind: "hero" } });
    expect(hero).toContain("16:9");
    expect(hero).toContain("文字を入れない");
    expect(hero).toContain("ロゴ");
    expect(hero).toContain("no text");
    expect(hero).toContain("photo");
    const sec = buildImagePrompt({ ...base, slot: { kind: "section", heading: "費用について" }, style: "flat" });
    expect(sec).toContain("4:3");
    expect(sec).toContain("費用について");
    expect(sec).toContain("flat");
  });
  it("差し込み記号は要旨から取り除く・所有者情報を渡す口が無い", () => {
    const p = buildImagePrompt({ ...base, slot: { kind: "hero" } });
    expect(p).not.toContain("{{");
    expect(buildImagePrompt.length).toBe(1);
    expect(buildImagePrompt({ ...base, slot: { kind: "hero" }, ownerName: "山田" } as never)).not.toContain("山田");
  });
  it("訴求の軸と種別を日本語で反映(生の値は出ない)", () => {
    const p = buildImagePrompt({ ...base, slot: { kind: "hero" } });
    expect(p).toContain("相続");
    expect(p).toContain("戸建");
    expect(p).not.toContain("inheritance");
  });
});
