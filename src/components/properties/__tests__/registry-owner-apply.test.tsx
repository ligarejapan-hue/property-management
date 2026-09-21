/**
 * 「謄本から所有者を反映」の画面まわり。
 *
 * vitest は env=node(jsdom 無し)のため、表示だけの部品は `renderToStaticMarkup` で、
 * 出す/出さないの条件はソースの走査で固定する。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";

import RegistryOwnerPreviewList from "@/components/properties/registry-owner-preview-list";

const PAGE = path.join(
  process.cwd(),
  "src/app/(dashboard)/properties/[id]/page.tsx",
);
const BUTTON = path.join(
  process.cwd(),
  "src/components/properties/registry-owner-apply-button.tsx",
);

/** 手元(CRLF)と CI(LF)で判定が変わらないよう改行を揃える。 */
function readSource(file: string): string {
  return fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
}

describe("下見の表示", () => {
  it("氏名・住所・持分を出す", () => {
    const html = renderToStaticMarkup(
      <RegistryOwnerPreviewList
        fileName="謄本(所有者事項)_2026-09-15.pdf"
        owners={[
          {
            name: "山田太郎",
            address: "東京都渋谷区神宮前三丁目12番3号",
            share: "3分の1",
          },
        ]}
      />,
    );
    expect(html).toContain("山田太郎");
    expect(html).toContain("東京都渋谷区神宮前三丁目12番3号");
    expect(html).toContain("持分 3分の1");
    expect(html).toContain("謄本(所有者事項)_2026-09-15.pdf");
  });

  it("何人登録されるかを先に伝える", () => {
    const html = renderToStaticMarkup(
      <RegistryOwnerPreviewList
        fileName="x.pdf"
        owners={[
          { name: "山田太郎", address: "東京都1-1", share: null },
          { name: "山田花子", address: "東京都1-1", share: null },
        ]}
      />,
    );
    expect(html).toContain("2名を登録します");
  });

  it("⚠住所が読めなかった所有者は、その旨を出す（空欄で黙らせない）", () => {
    const html = renderToStaticMarkup(
      <RegistryOwnerPreviewList
        fileName="x.pdf"
        owners={[{ name: "山田太郎", address: null, share: null }]}
      />,
    );
    expect(html).toContain("住所は読み取れませんでした");
  });

  it("⚠1人も読み取れなかったときは手入力へ誘導する", () => {
    const html = renderToStaticMarkup(
      <RegistryOwnerPreviewList fileName="x.pdf" owners={[]} />,
    );
    expect(html).toContain("読み取れませんでした");
    expect(html).toContain("手入力");
  });
});

describe("ボタンを出す条件（物件ページ）", () => {
  const src = readSource(PAGE);

  it("⚠所有者が0件のときだけ出す（既にいる物件への二重登録を防ぐ）", () => {
    expect(src).toContain("owners.length === 0 && registryOwnerAttachmentCount > 0");
  });

  it("⚠謄本の件数は所有者事項(owner)だけを数える", () => {
    expect(src).toContain("property.registryAttachmentCounts?.owner ?? 0");
  });

  it("所有者を追加できる人にだけ出す（showAdd の中に置く）", () => {
    const showAddBlock = src.slice(
      src.indexOf("{showAdd && ("),
      src.indexOf("{owners.length === 0 ? ("),
    );
    expect(showAddBlock).toContain("RegistryOwnerApplyButton");
  });
});

describe("反映の安全策（ボタン部品）", () => {
  const src = readSource(BUTTON);

  it("⚠確認画面を挟む（押しただけでは登録しない）", () => {
    // 押したときに呼ぶのは下見(GET)で、登録(POST)は確認後のボタンから。
    expect(src).toContain("onClick={openPreview}");
    expect(src).toContain("この内容で登録");
    const openPreviewBody = src.slice(
      src.indexOf("const openPreview"),
      src.indexOf("const apply"),
    );
    expect(openPreviewBody).not.toContain("applyRegistryOwners");
  });

  it("⚠すでに所有者がいると返ってきたら登録ボタンを押せない", () => {
    expect(src).toContain("!preview?.alreadyHasOwners");
  });

  it("登録中は閉じられない（二重送信を防ぐ）", () => {
    expect(src).toContain('onClose={phase === "applying" ? undefined : close}');
  });

  it("失敗したときは理由を画面に出す", () => {
    expect(src).toContain('role="alert"');
  });
});
