import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import RegistryParcelTargetPicker, {
  mainParcelLabel,
  parcelTargetLabel,
} from "../registry-parcel-target-picker";

const rows = [
  { id: "a", kind: "land" as const, location: null, number: "1番2", realEstateNumber: null, area: null },
  { id: "b", kind: "building" as const, location: "架空町二丁目", number: "1番1の2", realEstateNumber: null, area: null },
];

describe("取得する土地・建物を選ぶ欄(2026-11-06)", () => {
  it("足した行が無ければ何も出さない(今までどおり)", () => {
    expect(renderToStaticMarkup(<RegistryParcelTargetPicker rows={[]} value={null} onChange={() => {}} />)).toBe("");
  });
  it("1筆目・1棟目と足した行を並べ、選んだものに印", () => {
    const html = renderToStaticMarkup(
      <RegistryParcelTargetPicker rows={rows} mainLotNumber="1番1" mainBuildingNumber={null} value="b" onChange={() => {}} />,
    );
    expect(html).toContain("取得する土地・建物");
    expect(html).toContain("1筆目・1棟目（地番 1番1）");
    expect(html).toContain("土地 1番2");
    expect(html).toContain("建物 架空町二丁目 1番1の2");
    expect((html.match(/checked=""/g) ?? []).length).toBe(1);
    expect(html.indexOf('checked=""')).toBeGreaterThan(html.indexOf("土地 1番2"));
  });
  it("見出しの文字", () => {
    expect(mainParcelLabel(null, null)).toBe("1筆目・1棟目");
    expect(mainParcelLabel("1番1", "1番1")).toBe("1筆目・1棟目（地番 1番1 / 家屋番号 1番1）");
    expect(parcelTargetLabel(rows[0])).toBe("土地 1番2");
  });
});

describe("取得の画面への配線(ソース)", () => {
  const src = readFileSync(path.join(__dirname, "..", "registry-location-search-button.tsx"), "utf8");
  it("★検索・取得・取り込み・事前確認のすべてに選んだ行を渡す(どれか1つ漏れると別の謄本を探す)", () => {
    expect(src).toContain("searchRegistryCandidates(propertyId, ref, targetParcelId)");
    expect(src).toContain("fetchRegistryPreflight([propertyId], targetParcelId)");
    expect(src).toMatch(/approvedPreflight,\s+targetParcelId,\s+\);/);
    expect(src).toMatch(/recoverLiveRef,\s+targetParcelId,\s+\);/);
    expect(src).toMatch(/preflightReload,\s+targetParcelId,\s+\);/);
  });
  it("選べるのは検索の前と候補なしの取り込みだけ(候補を選んだあとは行を見せるだけ)", () => {
    expect((src.match(/<RegistryParcelTargetPicker/g) ?? []).length).toBe(2);
    expect(src).toContain("取得する土地・建物：{parcelTargetLabel(targetRow)}");
  });
});
