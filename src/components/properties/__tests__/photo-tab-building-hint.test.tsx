import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BUILDING_PHOTOS_ANCHOR,
  PhotoTabBuildingHint,
} from "../photo-tab-building-hint";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(dir, rel), "utf8");

describe("物件写真の案内文: 棟写真へのリンク", () => {
  it("棟があるときは、その棟の棟写真の位置へ飛ぶリンクを出す", () => {
    const html = renderToStaticMarkup(
      <PhotoTabBuildingHint propertyType="apartment_unit" building={{ id: "b-1", name: "サンプルマンション" }} />,
    );
    expect(html).toContain(`href="/buildings/b-1#${BUILDING_PHOTOS_ANCHOR}"`);
    expect(html).toContain("サンプルマンション");
    expect(html).toContain("棟写真");
  });

  it("棟の名前が空でもリンクは出す(名前の代わりに「棟の詳細」)", () => {
    const html = renderToStaticMarkup(
      <PhotoTabBuildingHint propertyType="apartment_unit" building={{ id: "b-2", name: "" }} />,
    );
    expect(html).toContain(`href="/buildings/b-2#${BUILDING_PHOTOS_ANCHOR}"`);
  });

  it("区分マンション・棟なし: 物件名を入れると棟につながる案内と編集ボタン", () => {
    const html = renderToStaticMarkup(
      <PhotoTabBuildingHint propertyType="apartment_unit" building={null} onEditProperty={() => {}} />,
    );
    expect(html).toContain("物件名(マンション名)を入れると棟につながり、共用部・外観の写真を部屋どうしで共有できます");
    expect(html).toContain("<button");
  });

  it("区分マンション・棟なし・編集できない: ボタンは出さない", () => {
    const html = renderToStaticMarkup(
      <PhotoTabBuildingHint propertyType="apartment_unit" building={null} />,
    );
    expect(html).toContain("物件名(マンション名)を入れると");
    expect(html).not.toContain("<button");
  });

  it("それ以外の種別: この物件の写真です。", () => {
    const html = renderToStaticMarkup(
      <PhotoTabBuildingHint propertyType="land" building={null} />,
    );
    expect(html).toContain("この物件の写真です。");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<button");
  });

  it("物件詳細は写真タブへ種別と編集ボタンの導線を渡している", () => {
    const page = read("../../../app/(dashboard)/properties/[id]/page.tsx");
    expect(page).toMatch(/<PhotoTab[\s\S]{0,400}propertyType=\{property\.propertyType\}/);
    expect(page).toMatch(/<PhotoTab[\s\S]{0,600}onEditProperty=\{/);
  });

  it("物件詳細は写真タブへ棟(id・名前)を渡している", () => {
    const page = read("../../../app/(dashboard)/properties/[id]/page.tsx");
    expect(page).toMatch(/<PhotoTab[\s\S]{0,200}building=\{/);
  });

  it("棟詳細の棟写真の枠に同じアンカーidが付き、読み込み後にそこへ移動する", () => {
    const page = read("../../../app/(dashboard)/buildings/[id]/page.tsx");
    expect(page).toContain("id={BUILDING_PHOTOS_ANCHOR}");
    expect(page).toContain("scrollIntoView");
    // 保存後の読み直しで再び飛ばない(移動は最初の1回だけ)
    expect(page).toContain("anchorScrolledRef.current = true");
  });
});
