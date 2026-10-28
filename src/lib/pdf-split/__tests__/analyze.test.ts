import { describe, expect, it, vi } from "vitest";
import { analyzeBundlePdf, type AnalyzeDeps } from "../analyze";
import { MAX_SPLIT_PAGES, REGISTRY_KIND } from "../segments";

const PDF = Buffer.from("%PDF-1.7");
const SUMMARY =
  "物件名 藤和氷川台コープ710号室\n専有面積 59.55㎡\n間取り 2LDK\n所在地 練馬区\n交通 駅徒歩3分\n構造 鉄骨鉄筋コンクリート造\n管理費 月額 13,350円";

function deps(texts: string[] | null, ocr: AnalyzeDeps["ocr"] = async () => ({ ok: true, ocr: "done", texts: new Map() })): AnalyzeDeps {
  return {
    readPageTexts: async () => (texts === null ? null : { total: texts.length, texts }),
    ocr,
  };
}

describe("analyzeBundlePdf", () => {
  it("文字のあるページは文字で、文字の無いページは見出しの読み取りで見分け、分け方の案を返す", async () => {
    const ocr = vi.fn<AnalyzeDeps["ocr"]>(async () => ({
      ok: true,
      ocr: "done",
      texts: new Map([
        [2, "東京都練馬区氷川台4丁目162-2-710全部事項証明書(建物)"],
        [3, "東京都練馬区氷川台4丁目162-2-710全部事項証明書(建物)権利部"],
      ]),
    }));
    const r = await analyzeBundlePdf(PDF, deps([SUMMARY, "", " "], ocr));
    expect(ocr).toHaveBeenCalledWith(PDF, [2, 3]);
    expect(r).toEqual({
      pageCount: 3,
      pageKinds: ["property_summary", REGISTRY_KIND, REGISTRY_KIND],
      segments: [
        { from: 1, to: 1, kind: "property_summary" },
        { from: 2, to: 3, kind: REGISTRY_KIND },
      ],
      ocr: "done",
      tooManyPages: false,
    });
  });

  it("全ページに文字があれば読み取りを呼ばない", async () => {
    const ocr = vi.fn<AnalyzeDeps["ocr"]>();
    const r = await analyzeBundlePdf(PDF, deps([SUMMARY], ocr));
    expect(ocr).not.toHaveBeenCalled();
    expect(r?.ocr).toBe("skipped");
    expect(r?.segments).toEqual([{ from: 1, to: 1, kind: "property_summary" }]);
  });

  it("読み取りが使えないときは、そのページを「前の書類の続き」にして続ける", async () => {
    const r = await analyzeBundlePdf(PDF, deps([SUMMARY, ""], async () => ({ ok: false, reason: "unavailable" })));
    expect(r?.ocr).toBe("unavailable");
    expect(r?.segments).toEqual([{ from: 1, to: 2, kind: "property_summary" }]);
  });

  it("ページが多すぎる PDF は分けない(読み取りもしない)", async () => {
    const ocr = vi.fn<AnalyzeDeps["ocr"]>();
    const texts = Array.from({ length: MAX_SPLIT_PAGES + 1 }, () => "");
    const r = await analyzeBundlePdf(PDF, deps(texts, ocr));
    expect(ocr).not.toHaveBeenCalled();
    expect(r).toEqual({
      pageCount: MAX_SPLIT_PAGES + 1,
      pageKinds: [],
      segments: [{ from: 1, to: MAX_SPLIT_PAGES + 1, kind: null }],
      ocr: "skipped",
      tooManyPages: true,
    });
  });

  it("文字を読めない PDF は null(=分けずにいつもどおり保存する)", async () => {
    expect(await analyzeBundlePdf(PDF, deps(null))).toBeNull();
  });
});
