/**
 * Phase D 統合 source-assertion テスト。
 *
 * 3 import 経路（owner_csv / reception-owner / registry-pdf）に法人番号検出ヘルパーが
 * 正しく組み込まれていることを、ソースコードのパターンで検証する。
 * 完全な prisma mock を組まずに「呼び出しが繋がっている」「PII を漏らさない」「サマリが残る」を
 * 担保するための軽量テスト。
 *
 * - 共通ヘルパー decideCorporateImport / corporateImportMessage が各 route から import されている
 * - 新規 Owner 作成 data に corporateNumber を乗せる導線がある（save action のみ）
 * - reception-owner / registry-pdf の reuse パスに updateMany(where: corporateNumber: null) がある
 * - AuditLog detail に corporateNumber: corporateSummary が乗っている
 * - errorMessage への追記が rowCorporateMessage 経由になっている
 * - 生値（13桁数字）や会社名・住所を AuditLog detail に直接乗せていない
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ownerCsvSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/api/import/owner-csv/route.ts"),
  "utf8",
);
const receptionOwnerSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/api/import/reception-owner/route.ts"),
  "utf8",
);
// PR1: 取込コアは @/lib/registry-pdf/process へ移動したため、route.ts 単独ではなく
// route.ts + process.ts の連結に対して source-assertion を行う（実装の所在に依存しない）。
const registryPdfSrc =
  fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/import/registry-pdf/route.ts"),
    "utf8",
  ) +
  "\n" +
  fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/registry-pdf/process.ts"),
    "utf8",
  );

function expectCommonImport(src: string) {
  expect(src).toMatch(/from\s+"@\/lib\/owner-corporate-import"/);
  expect(src).toMatch(/decideCorporateImport/);
  expect(src).toMatch(/emptyCorporateImportSummary/);
  expect(src).toMatch(/tallyCorporateDecision/);
  expect(src).toMatch(/corporateImportMessage/);
  expect(src).toMatch(/appendImportMessage/);
}

describe("owner-csv route Phase D 統合", () => {
  it("法人番号ヘルパーを import している", () => {
    expectCommonImport(ownerCsvSrc);
  });

  it("decideCorporateImport を呼び出して新規 Owner 作成 data に乗せる", () => {
    expect(ownerCsvSrc).toMatch(/decideCorporateImport\(/);
    // save action のみ data.corporateNumber に乗せる
    expect(ownerCsvSrc).toMatch(
      /cnDecision\.action\s*===\s*"save"[\s\S]{0,150}createData\.corporateNumber\s*=\s*cnDecision\.corporateNumber/,
    );
  });

  it("AuditLog detail に corporateNumber サマリが乗っている", () => {
    expect(ownerCsvSrc).toMatch(/corporateNumber:\s*corporateSummary/);
  });

  it("AuditLog detail に法人番号の生値・会社名・住所・候補リストを直書きしていない", () => {
    // owner_csv_import action のスコープに対して、detail に corporateNumber 関連の
    // 生値 key（rawValue / candidates / record / company / address）が無いこと
    expect(ownerCsvSrc).not.toMatch(/corporateNumberRawValue|corporateCandidates/);
    expect(ownerCsvSrc).not.toMatch(/corporateRecord:/);
  });

  it("行レコードに corporateMessage 保持フィールドがある（finalization で消えない）", () => {
    // jobRows 要素型に corporateMessage が定義されている
    expect(ownerCsvSrc).toMatch(/corporateMessage:\s*string\s*\|\s*null/);
    // 成功 push 時に cnMessage を corporateMessage に格納している
    expect(ownerCsvSrc).toMatch(/corporateMessage:\s*cnMessage/);
    // row.corporateMessage が finalization で参照される
    expect(ownerCsvSrc).toMatch(/row\.corporateMessage/);
  });

  it("finalization は link メッセージに corporateMessage を append する（Codex P2 修正）", () => {
    // row.errorMessage への最終代入が appendImportMessage(linkMessage, row.corporateMessage) であること
    expect(ownerCsvSrc).toMatch(
      /row\.errorMessage\s*=\s*appendImportMessage\(\s*linkMessage\s*,\s*row\.corporateMessage\s*\)/,
    );
    // 旧バージョンの直接代入「row.errorMessage = "紐づけ完了..."」が残っていないこと
    expect(ownerCsvSrc).not.toMatch(
      /row\.errorMessage\s*=\s*"紐づけ完了\[/,
    );
    expect(ownerCsvSrc).not.toMatch(
      /row\.errorMessage\s*=\s*\n?\s*"紐づけ不可:/,
    );
  });

  it("成功行初期 push で errorMessage は null（finalization で組み立てる）", () => {
    // 旧実装 (errorMessage: appendImportMessage(null, cnMessage)) が残っていないこと
    expect(ownerCsvSrc).not.toMatch(
      /errorMessage:\s*appendImportMessage\(null,\s*cnMessage\)/,
    );
  });
});

describe("reception-owner route Phase D 統合", () => {
  it("法人番号ヘルパーを import している", () => {
    expectCommonImport(receptionOwnerSrc);
  });

  it("upsertOwnerAndLink に onCorporateDecision コールバック引数がある", () => {
    expect(receptionOwnerSrc).toMatch(/onCorporateDecision\?:/);
  });

  it("reuse パスで updateMany(where corporateNumber:null) による空欄埋め", () => {
    expect(receptionOwnerSrc).toMatch(
      /updateMany\(\{[\s\S]{0,200}corporateNumber:\s*null[\s\S]{0,150}data:\s*\{\s*corporateNumber:\s*cnDecision\.corporateNumber/,
    );
  });

  it("create パスで data.corporateNumber を save action のみ乗せる", () => {
    expect(receptionOwnerSrc).toMatch(
      /cnDecisionForCreate\.action\s*===\s*"save"[\s\S]{0,80}corporateNumber:\s*cnDecisionForCreate\.corporateNumber/,
    );
  });

  it("AuditLog detail に corporateNumber サマリが乗っている", () => {
    expect(receptionOwnerSrc).toMatch(/corporateNumber:\s*corporateSummary/);
  });

  it("行 errorMessage は appendImportMessage 経由で集約", () => {
    expect(receptionOwnerSrc).toMatch(/appendImportMessage\(null,\s*rowCorporateMessage\)/);
  });

  it("既存 Owner select で corporateNumber を取得", () => {
    expect(receptionOwnerSrc).toMatch(
      /select:\s*\{[\s\S]{0,200}corporateNumber:\s*true/,
    );
  });

  // Task 9: この空欄埋めは version を進めていなかった。corporateNumber は
  // 所有者の編集画面(properties/[id]/page.tsx の所有者カード)で変えられる項目
  // なので、進めないと編集画面を開いていた人の保存が黙って上書きする
  // (Task 7 が謄本取込の法人番号で直したのと同じ穴)。
  it("(Task 9) reuse パスの空欄埋めは version: { increment: 1 } を必ず書く", () => {
    expect(
      receptionOwnerSrc,
      "reception-owner の corporateNumber:null 空欄埋めから version:{increment:1} が消えている(Task 9のバグ修正が後退した可能性)",
    ).toMatch(
      /where:\s*\{\s*id:\s*candidateOwnerId!,\s*corporateNumber:\s*null\s*\}[\s\S]{0,100}data:\s*\{\s*corporateNumber:\s*cnDecision\.corporateNumber,\s*version:\s*\{\s*increment:\s*1\s*\}\s*\}/,
    );
  });
});

describe("registry-pdf route Phase D 統合", () => {
  it("法人番号ヘルパーを import している", () => {
    expectCommonImport(registryPdfSrc);
  });

  it("parsed.owners[] ループで decideCorporateImport を呼ぶ", () => {
    expect(registryPdfSrc).toMatch(/decideCorporateImport\(/);
  });

  // ⚠レビュー round1 #5 → round2 M2: 元は「ヘルパーの定義から書き込みまで」を
  // 1つの正規表現の距離({0,1500})でまとめて見ていたため、ヘルパー本体に
  // コメントが増えるだけで(中身は何も変えていなくても)この距離を超えて
  // テストが「原因不明のまま」落ちる恐れがあった(本リポジトリで前例あり)。
  // 距離に依存しない2つの独立した事実に分割する:
  //   (a) ヘルパー自身が corporateNumber の空欄埋めで version increment を
  //       必ず一緒に書いている(D10 の実バグ修正・落ちたら「両者は近接して
  //       いるはずが離れた/消えた」と分かる)。
  //   (b) 両方の reuse パス(住所なし/住所あり)が、直接 updateMany を書かず
  //       このヘルパーを経由している(呼び出し1本を個別に増減させる回帰は
  //       振る舞いテスト(edit-lock-skip.test.ts)側で検出する。ここは
  //       「ヘルパー経由の窓口が2つとも生きているか」の低コストな見張り)。
  it("(a) ヘルパー自身が corporateNumber の空欄埋めで version increment を必ず書く", () => {
    expect(
      registryPdfSrc,
      "fillOwnerCorporateNumberIfUnlocked の updateMany から corporateNumber または version:{increment:1} が消えている(D10のバグ修正が後退した可能性)",
    ).toMatch(
      /where:\s*\{\s*id:\s*ownerId,\s*corporateNumber:\s*null\s*\}[\s\S]{0,100}data:\s*\{\s*corporateNumber,\s*version:\s*\{\s*increment:\s*1\s*\}\s*\}/,
    );
  });

  it("(b) 住所なし/住所ありの両方の reuse パスが fillOwnerCorporateNumberIfUnlocked を経由する", () => {
    // ⚠Task 7レビュー Minor 10(持ち越し): 素の関数名(`fillOwnerCorporateNumberIfUnlocked(`)
    // だけを数えると、関数定義自体にもコメントの文中にも一致してしまい、実際の呼び出しが
    // 1本減ってその分「言及」が1つ増えただけでもカウントが変わらず検出できない。
    // 実際の呼び出しは必ず `await` を伴う(この関数は Promise を返す)ので、
    // `await fillOwnerCorporateNumberIfUnlocked(` を数える(定義行は対象外)。
    // 住所なし経路・住所あり経路の2箇所のはず。
    const occurrences = (
      registryPdfSrc.match(/await fillOwnerCorporateNumberIfUnlocked\(/g) ?? []
    ).length;
    expect(
      occurrences,
      `await fillOwnerCorporateNumberIfUnlocked( の出現回数が期待(呼び出し2箇所)と異なる(${occurrences}件)。` +
        "どちらかの reuse パスが直接 updateMany を書いてヘルパーを経由しなくなった可能性がある。",
    ).toBe(2);
  });

  it("create パスで data.corporateNumber を save action のみ乗せる", () => {
    // Codex P1/P2 修正後: 新規作成は cnDecisionForCreate を使う
    expect(registryPdfSrc).toMatch(
      /cnDecisionForCreate\.action\s*===\s*"save"[\s\S]{0,80}corporateNumber:\s*cnDecisionForCreate\.corporateNumber/,
    );
  });

  it("AuditLog detail (pdf_import action) に corporateNumber サマリが乗っている", () => {
    expect(registryPdfSrc).toMatch(/corporateNumber:\s*corporateSummary/);
  });

  it("既存 Owner candidates select で corporateNumber を取得", () => {
    expect(registryPdfSrc).toMatch(
      /select:\s*\{[\s\S]{0,200}corporateNumber:\s*true/,
    );
  });

  it("ImportJobRow.errorMessage に rowCorporateMessage を追記", () => {
    expect(registryPdfSrc).toMatch(/appendImportMessage\(null,\s*rowCorporateMessage\)/);
  });

  it("pdf_import の AuditLog action 名を変更していない", () => {
    expect(registryPdfSrc).toMatch(/action:\s*"pdf_import"/);
  });

  // ---- Codex P1/P2 回帰 ----
  it("Codex P1/P2: reuse 判定は reusedExistingOwner (両方 non-null) で行う", () => {
    expect(registryPdfSrc).toMatch(
      /const\s+reusedExistingOwner\s*=\s*resolvedOwnerId\s*!==\s*null\s*&&\s*candidateOwnerId\s*!==\s*null\s*&&\s*resolvedOwnerId\s*===\s*candidateOwnerId/,
    );
  });

  it("Codex P1: reuse 用の法人番号補完は reusedExistingOwner 条件下でのみ実行（id:null 防止）", () => {
    // D10: 実際の updateMany は fillOwnerCorporateNumberIfUnlocked の中に移ったため、
    // ガードの内側にあるのは(直接の updateMany ではなく)そのヘルパー呼び出しになった。
    // reusedExistingOwner && cnDecision.action === "save" ガードの内側にある
    expect(registryPdfSrc).toMatch(
      /if\s*\(\s*\n?\s*reusedExistingOwner\s*&&[\s\S]{0,150}cnDecision\.action\s*===\s*"save"[\s\S]{0,200}fillOwnerCorporateNumberIfUnlocked/,
    );
  });

  it("Codex P2: reuse 側 recordCorporateDecision は reusedExistingOwner ガード内のみ", () => {
    // 「else if (resolvedOwnerId === candidateOwnerId)」型の旧コードが残っていない
    expect(registryPdfSrc).not.toMatch(
      /else\s+if\s*\(\s*resolvedOwnerId\s*===\s*candidateOwnerId\s*\)/,
    );
    expect(registryPdfSrc).toMatch(
      /else\s+if\s*\(\s*reusedExistingOwner\s*\)/,
    );
  });

  it("Codex P2: 未一致 owner の create path では新規 decision で一度だけ集計", () => {
    // candidateOwnerId === null のときは cnDecisionForCreate = cnDecision
    // ⚠ループ内の判定は `decide`(= ownersOnly なら noop、それ以外は decideCorporateImport)経由
    // race fallback (candidateOwnerId !== null かつ reuse 失敗) のときは existing=null で再計算
    expect(registryPdfSrc).toMatch(
      /cnDecisionForCreate\s*=\s*\n?\s*candidateOwnerId\s*===\s*null\s*\?\s*cnDecision\s*:\s*decide\(\s*\{\s*name:\s*ownerInfo\.name,\s*address:\s*ownerInfo\.address\s*\?\?\s*null\s*\},\s*null/,
    );
    // create path で recordCorporateDecision は cnDecisionForCreate を使う（cnDecision ではない）
    // ⚠新規作成は**親の物件行をロックした tx の中**へ移したため、変数名が created → resolved に
    //   なり、「新規に作れたときだけ集計する」分岐が挟まる（同時反映で相手が先に作っていた
    //   場合は再利用＝新規の集計をしない）。見るべき意図は変わっていない。
    expect(registryPdfSrc).toMatch(
      /resolvedOwnerId\s*=\s*resolved\.id;[\s\S]{0,200}recordCorporateDecision\(cnDecisionForCreate\)/,
    );
  });

  it("Codex P1/P2: cnDecision の existing 引数も reusedExistingOwner で分岐（旧 ===比較なし）", () => {
    // 旧コード: resolvedOwnerId === candidateOwnerId ? candidateCorporateNumber : null
    // 新コード: reusedExistingOwner ? candidateCorporateNumber : null
    expect(registryPdfSrc).toMatch(
      /reusedExistingOwner\s*\?\s*candidateCorporateNumber\s*:\s*null/,
    );
    expect(registryPdfSrc).not.toMatch(
      /resolvedOwnerId\s*===\s*candidateOwnerId\s*\?\s*candidateCorporateNumber/,
    );
  });
});

describe("共通: PII 漏洩防止", () => {
  it("3 route いずれも detail に raw XML / rawText / rawData 全文を流していない", () => {
    for (const src of [ownerCsvSrc, receptionOwnerSrc, registryPdfSrc]) {
      // AuditLog の detail オブジェクト周辺で「rawText: rawText」や「rawXml」が無いこと
      expect(src).not.toMatch(/detail:\s*\{[\s\S]{0,400}rawText:/);
      expect(src).not.toMatch(/detail:\s*\{[\s\S]{0,400}rawXml/);
    }
  });

  it("errorMessage 追記文言は固定文字列のみで法人番号を含まない", () => {
    for (const src of [ownerCsvSrc, receptionOwnerSrc, registryPdfSrc]) {
      // owner-corporate-import.ts の corporateImportMessage が返す固定文言以外は使っていない
      // → 法人番号生値を template literal で errorMessage に差し込んでいないこと
      expect(src).not.toMatch(
        /errorMessage:\s*`[^`]*\$\{[^}]*corporateNumber[^}]*\}/,
      );
    }
  });
});
