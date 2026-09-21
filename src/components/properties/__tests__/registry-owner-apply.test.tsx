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

  it("⚠持分の割合は保存されないと明示する（登録されると誤解させない）", () => {
    const html = renderToStaticMarkup(
      <RegistryOwnerPreviewList
        fileName="x.pdf"
        owners={[{ name: "山田太郎", address: "東京都1-1", share: "3分の1" }]}
      />,
    );
    expect(html).toContain("持分の割合は保存されません");
  });
});

describe("ボタンを出す条件（物件ページ）", () => {
  const src = readSource(PAGE);

  it("⚠所有者が0件のときだけ出す（既にいる物件への二重登録を防ぐ）", () => {
    expect(src).toContain("owners.length === 0 &&");
    expect(src).toContain("registryOwnerAttachmentCount > 0 &&");
  });

  it("⚠server が必須にしている import:write が無い人には出さない", () => {
    expect(src).toContain("canApplyRegistryOwners");
  });

  it("⚠ボタンの出し分けに、氏名の項目ごとの書き込み権限を含める", () => {
    // server は書く項目ごと(owner_name / owner_address)に確かめて 403 にする。
    // 氏名は必ず書くのでボタンの条件に入れる(入れないと「下見して確認まで進めるのに
    // 必ず 403」になる)。
    const gate = src.slice(src.indexOf("const canWriteOwnerName ="));
    expect(gate).toContain('hasEditPerm("owner_name")');
    expect(src).toContain(
      "canApplyRegistryOwners={canImportWrite && canWriteOwnerName}",
    );
    expect(src).toContain('p.resource === "import" && p.action === "write"');
  });

  it("⚠住所の権限はボタンで一律に閉じない（住所の無い謄本は氏名の権限だけで反映できる）", () => {
    // 住所を書く権限が無くても、読み取った所有者に住所が無ければ server は通す。
    // ボタンの条件に住所の権限を入れると、その人が使える操作まで隠してしまう。
    // → 住所の権限は部品に渡し、下見の結果に住所があるときだけ止める。
    const gate = src.slice(src.indexOf("const canWriteOwnerAddress ="));
    expect(gate).toContain('hasEditPerm("owner_address")');
    expect(src).not.toContain("canApplyRegistryOwners={canImportWrite && canWriteOwnerName &&");
    expect(src).toContain("canWriteOwnerAddress={canWriteOwnerAddress}");
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

  it("⚠下見の結果に住所があり、住所を書く権限が無ければ登録ボタンを押せない（理由を出す）", () => {
    // server は住所を書く権限を「住所がある所有者」にだけ求める。同じ判定を確認画面で行い、
    // 住所の無い謄本は氏名の権限だけで反映できるようにする。
    expect(src).toContain("owners.some((o) => o.address) && !canWriteOwnerAddress");
    expect(src).toContain("!needsAddressPerm");
    expect(src).toContain("住所を書き込む権限がありません");
  });

  it("⚠登録に成功したら、画面を読み直す前に成功を見せる", () => {
    // 読み直し(ページの fetchProperty)は失敗しても内部で受け止めて正常に返るため、
    // 先に閉じると、読み直しに失敗したとき利用者は成功を知るすべが無くなる。
    expect(src).toContain('setPhase("done")');
    expect(src).toContain("名の所有者を登録しました");
    // 読み直しは「閉じる」を押してから
    const finishBody = src.slice(
      src.indexOf("const finish = useCallback"),
      src.indexOf("const openPreview"),
    );
    expect(finishBody).toContain("close();");
    expect(finishBody).toContain("await onApplied();");
  });

  it("登録中は閉じられない（二重送信を防ぐ）", () => {
    expect(src).toContain('onClose={phase === "applying" ? undefined : close}');
  });

  it("失敗したときは理由を画面に出す", () => {
    expect(src).toContain('role="alert"');
  });
});
