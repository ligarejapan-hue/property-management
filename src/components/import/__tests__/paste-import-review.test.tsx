/**
 * vitest は env=node（jsdom なし）なので renderToStaticMarkup + 文字列 assert で検証する。
 * クリックや state 遷移はここでは見られない（リポジトリの既定の作法）。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PasteImportReview, foldNoColumnFieldsIntoNote } from "../paste-import-review";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";

const draft = buildPasteDraft(
  "■査定ナンバー： SA-1\n■物件所在地： 東京都A区B1-2-3グリーンコート303\n" +
  "■物件名称： グリーンコート\n■お名前： 山田太郎",
);

const html = renderToStaticMarkup(
  createElement(PasteImportReview, { draft, rawText: "■物件所在地： 東京都A区B1-2-3" }),
);

/**
 * `data-field="X"` から次の `data-field="` の手前までを取り出す(その欄の描画ブロックだけ
 * を見るため)。「案内文がどこかに出た」ではなく「その欄の中に出た」ことを確かめたい。
 */
function extractFieldBlock(source: string, fieldKey: string): string {
  const marker = `data-field="${fieldKey}"`;
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const next = source.indexOf('data-field="', start + marker.length);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

describe("PasteImportReview（確認画面）", () => {
  it("拾えた値を表示する", () => {
    expect(html).toContain("東京都A区B1-2-3");
    expect(html).toContain("303");
  });

  it("★どの見出しから来たかを添える", () => {
    expect(html).toContain("物件所在地");
  });

  it("★元資料に無い欄は「元の資料に記載がありません」と出す", () => {
    expect(html).toContain("元の資料に記載がありません");
  });

  it("★地番が無いので謄本が取れない旨の警告を出す", () => {
    expect(html).toContain("地番がありません");
    expect(html).toContain("謄本");
  });

  it("貼った原文を並べて表示する", () => {
    expect(html).toContain("東京都A区B1-2-3");
  });

  it("送り元の名前を出す", () => {
    expect(html).toContain("HOME4U 査定依頼");
  });

  it("★推測で埋めた形跡がない（空欄の欄に値が入っていない）", () => {
    // 土地面積は元資料に無い → 数字が入っていないこと
    expect(html).not.toContain('data-field="landArea" data-value="');
  });
});

// ============================================================
// ここから下は Task 9 実装者が追加した検証。
// 「その部品が実際に制御していない文字列を assert しても、実装が壊れても
//  緑のまま」という repo の既知の罠(空洞テスト)を避けるため、
//  props を変えたときに出力が変わることまで確かめる形にしている。
// ============================================================

describe("PasteImportReview（3状態の描き分け・空洞テスト対策）", () => {
  it("要確認: 物件種別が判別できないときは警告文そのものが欄に添う（フィールド未定義なら失敗する)", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3\n■物件種別： 謎の種別X\n■お名前： 山田太郎",
    );
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, { draft: d, rawText: "" }),
    );
    // build-draft.ts が組み立てる警告文そのもの（実装が変われば文言も追随する）
    const warning = d.warnings.find((w) => w.code === "property_type_unknown");
    expect(warning).toBeTruthy();
    expect(out).toContain(warning!.message);
  });

  it("編集後の値（propertyValues）を渡すと、下書きの値ではなく渡した値が表示される", () => {
    const edited = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        propertyValues: {
          address: "東京都B区手直し後住所",
          lotNumber: "",
          buildingName: "",
          roomNo: "",
          propertyType: "",
          exclusiveArea: "",
          landArea: "",
          layoutType: "",
          occupancyStatus: "",
          builtYear: "",
        },
      }),
    );
    expect(edited).toContain("東京都B区手直し後住所");
    // 下書きが持っていた元の値(この fixture では必ず非nullの「東京都A区B1-2-3」)は、
    // propertyValues で上書きされて出ないことを確認する。
    // ⚠以前は `draft.property.address.value ?? "..."` という ?? フォールバックを使っていたが、
    //   左辺(address.value)はこの fixture では必ず非nullのため右辺(フォールバック)は
    //   絶対に通らない死コードだった。「前提が崩れても静かに空洞化する」書き方を避け、
    //   前提を明示的に assert してから使う。
    const originalAddress = draft.property.address.value;
    expect(originalAddress).not.toBeNull();
    expect(edited).not.toContain(originalAddress as string);
  });

  it("duplicates.blocked のとき、登録済みの断り文言と物件idへのリンクを出し、登録は無効になる", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        duplicates: { blocked: true, blockedByPropertyId: "prop-existing-1", similarPropertyIds: [] },
      }),
    );
    expect(out).toContain("この案件は登録済みです");
    expect(out).toContain("/properties/prop-existing-1");
    // disabled 属性が実際に出ている(register ボタンが無効化されている)ことまで見る
    expect(out).toMatch(/disabled(=""|="disabled")?[^>]*>[\s\S]*?登録/);
  });

  it("similar が非空のとき、類似物件の一覧（住所つき）をブロックせずに出す", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        similar: [{ id: "prop-similar-1", address: "東京都C区similar住所", lotNumber: null }],
        duplicates: { blocked: false, blockedByPropertyId: null, similarPropertyIds: ["prop-similar-1"] },
      }),
    );
    expect(out).toContain("東京都C区similar住所");
    expect(out).toContain("/properties/prop-similar-1");
    // ブロックはされない = 「この案件は登録済みです」は出ない
    expect(out).not.toContain("この案件は登録済みです");
  });

  it("ownerCandidates の3種類のラベルを、日本語で見分けられる文言にする", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        ownerCandidates: [
          { id: "o1", name: "山田太郎", matchKind: "current_address" },
          { id: "o2", name: "山田太郎", matchKind: "registry_address" },
          { id: "o3", name: "山田太郎", matchKind: "name_only" },
        ],
      }),
    );
    expect(out).toContain("連絡先の住所も一致");
    expect(out).toContain("登記上の住所と一致");
    expect(out).toContain("氏名だけ一致（同姓同名の別人かもしれません）");
  });

  it("所有者なしで登録する選択肢が常に存在する", () => {
    expect(html).toContain("所有者なしで登録する");
  });
});

// ============================================================
// レビュー指摘(Critical/Important)対応: 土地面積・築年は Property に対応する
// DB 列が無い(commit API の契約にも無い)。値を無言で捨てず備考へ回す。
// 「builtYear は Property の列として実在する」というレビュー時点の指摘は誤りだった
// (schema.prisma の builtYear は Building モデルの列。Property モデルには存在しない。
//  `awk '/^model Property \{/,/^\}/' prisma/schema.prisma | grep -i built` はヒット無し)。
// このため builtYear も landArea と同じ扱い(備考へ行を足す)にした。
// ============================================================

describe("foldNoColumnFieldsIntoNote(土地面積・築年を備考へ畳み込む純関数)", () => {
  it("両方空なら備考をそのまま返す(空行を作らない)", () => {
    expect(foldNoColumnFieldsIntoNote("既存の備考", { landArea: "", builtYear: "" })).toBe(
      "既存の備考",
    );
  });

  it("土地面積だけあれば行を1つ足す(既存の備考は消えない)", () => {
    expect(foldNoColumnFieldsIntoNote("既存の備考", { landArea: "120.5", builtYear: "" })).toBe(
      "既存の備考\n土地面積: 120.5",
    );
  });

  it("築年だけあれば行を1つ足す", () => {
    expect(foldNoColumnFieldsIntoNote("既存の備考", { landArea: "", builtYear: "1998" })).toBe(
      "既存の備考\n築年: 1998",
    );
  });

  it("両方あれば2行とも足す(備考が空でも先頭に空行を作らない)", () => {
    expect(foldNoColumnFieldsIntoNote("", { landArea: "120.5", builtYear: "1998" })).toBe(
      "土地面積: 120.5\n築年: 1998",
    );
  });
});

describe("画面: 専用の欄が無い旨の案内(空洞テスト対策=その欄のブロック内に限定して確認)", () => {
  it("土地面積の欄のブロック内に案内が出る", () => {
    const block = extractFieldBlock(html, "landArea");
    expect(block).not.toBe("");
    expect(block).toContain("専用の欄が無いため、備考に記録されます");
  });

  it("築年の欄のブロック内に案内が出る", () => {
    const block = extractFieldBlock(html, "builtYear");
    expect(block).not.toBe("");
    expect(block).toContain("専用の欄が無いため、備考に記録されます");
  });

  it("住所など、対応する列がある欄には案内が出ない(過剰表示になっていない)", () => {
    const block = extractFieldBlock(html, "address");
    expect(block).not.toBe("");
    expect(block).not.toContain("専用の欄が無いため");
  });
});
