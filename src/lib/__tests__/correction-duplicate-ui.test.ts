/**
 * /admin/owners/correction page.tsx の duplicate グループ表示が
 * duplicateGroupId ベースになっていることの source assertion。
 *
 * テスト環境に React DOM が無いため、source 文字列パターンで担保する。
 *
 * 禁止パターン:
 *   - `c.name ?? "(unknown)"` のような raw 表示値をキー生成に使う
 *   - `c.address ?? "(unknown)"` のような表示値ベースの grouping
 *
 * 要求パターン:
 *   - duplicateGroupId を group key に使う
 *   - duplicateGroupSize（または groups Map の size）を 2 以上で filter
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const file = path.resolve(
  process.cwd(),
  "src/app/(dashboard)/admin/owners/correction/page.tsx",
);
const src = fs.readFileSync(file, "utf8");

describe("correction page: duplicate グループ化キー", () => {
  it("duplicateGroupId を group key に使っている", () => {
    expect(src).toMatch(/duplicateGroupId/);
  });

  it("raw display value (c.name / c.address) ベースの grouping は行わない", () => {
    // `${c.name ?? "(unknown)"}|||${c.address ?? "(unknown)"}` のような
    // 旧パターンが残っていないこと
    expect(src).not.toMatch(/\$\{c\.name\s*\?\?[^}]*\}\|\|\|/);
    expect(src).not.toMatch(/"\(unknown\)"\|\|\|/);
  });

  it("duplicateGroupId !== null の candidate のみグループ化対象", () => {
    expect(src).toMatch(/duplicateGroupId\s*!==?\s*null/);
  });

  it("groupSize >= 2 のグループのみ表示する", () => {
    expect(src).toMatch(/\.length\s*>=\s*2/);
  });
});

// Phase 2-A: duplicate サブフィルタ
describe("correction page: Phase 2-A duplicate サブフィルタ", () => {
  it("DuplicateSubFilterBar コンポーネントが存在する", () => {
    expect(src).toMatch(/function DuplicateSubFilterBar/);
  });

  it("サブフィルタ enum (all / name_address / corporate_number / external_link_key) が定義されている", () => {
    expect(src).toMatch(/type DuplicateSubFilter/);
    expect(src).toMatch(/"name_address"/);
    expect(src).toMatch(/"corporate_number"/);
    expect(src).toMatch(/"external_link_key"/);
  });

  it("4 つのサブフィルタラベル（すべて / 氏名住所一致 / 法人番号一致 / リンクキー一致）が存在する", () => {
    expect(src).toMatch(/すべて/);
    expect(src).toMatch(/氏名住所一致/);
    expect(src).toMatch(/法人番号一致/);
    expect(src).toMatch(/リンクキー一致/);
  });

  it("duplicateMatchedBy で client-side フィルタしている", () => {
    expect(src).toMatch(/duplicateMatchedBy\s*===\s*duplicateSubFilter/);
  });

  it("サブフィルタ state とハンドラが定義されている", () => {
    expect(src).toMatch(/duplicateSubFilter/);
    expect(src).toMatch(/setDuplicateSubFilter/);
  });
});

// Codex P2: URL ↔ duplicateSubFilter state の同期
//
// 振る舞いそのものは jsdom + RTL がない環境では直接検証できないので、
// setFilterType の実装の以下 3 点を source assertion で担保する:
//
//   1. duplicate 以外へ移動するとき、URL から ?dup= を削除する既存処理は維持
//   2. 同じタイミングで in-memory state も "all" にリセットする
//   3. duplicate へ戻るとき、URL の現在の ?dup= を parse して state に反映する
//      （不正値 / 無は parseDuplicateSubFilterFromQuery 経由で "all" フォールバック）
describe("correction page: Codex P2 URL↔state 同期", () => {
  it("duplicate 以外へ遷移時に ?dup= を URL から削除する処理が残っている", () => {
    // 既存挙動の保護（Codex P2 修正で誤って消さないこと）。
    expect(src).toMatch(/if\s*\(\s*next\s*!==?\s*"duplicate"\s*\)\s*\{[\s\S]*?sp\.delete\("dup"\)/);
  });

  it("duplicate 以外へ遷移時に duplicateSubFilter state を 'all' にリセットする", () => {
    // setFilterType の `next !== "duplicate"` 分岐内で
    // setDuplicateSubFilterState("all") を呼んでいることを担保する。
    expect(src).toMatch(
      /if\s*\(\s*next\s*!==?\s*"duplicate"\s*\)\s*\{[\s\S]*?setDuplicateSubFilterState\(\s*"all"\s*\)/,
    );
  });

  it("duplicate タブへ戻る時、URL の ?dup= を parse して state に反映する", () => {
    // `next === "duplicate"` 側で parseDuplicateSubFilterFromQuery を呼んでいる
    // ことを確認する。これにより別タブから戻った時 URL=都度尊重される。
    // multi-line + trailing comma の整形にも耐えるよう [\s,]* を許容。
    expect(src).toMatch(
      /setDuplicateSubFilterState\(\s*parseDuplicateSubFilterFromQuery\(\s*sp\.get\("dup"\)\s*\)[\s,]*\)/,
    );
  });

  it("parseDuplicateSubFilterFromQuery は不正値を 'all' にフォールバックする", () => {
    // switch default 経由で "all" を返している実装を担保する。
    expect(src).toMatch(
      /function parseDuplicateSubFilterFromQuery[\s\S]*?default:[\s\S]*?return\s*"all"/,
    );
  });

  it("dup query は enum 値のみで PII / 法人番号生値 / externalLinkKey 生値を URL に載せない", () => {
    // setDuplicateSubFilter は受け取った enum 値そのものを sp.set("dup", next) で
    // セットするのみ。corporateNumber / externalLinkKey / name / address を
    // 直接 sp.set する箇所が無いことを確認する。
    expect(src).not.toMatch(/sp\.set\(\s*"dup"\s*,\s*[^)]*corporateNumber/);
    expect(src).not.toMatch(/sp\.set\(\s*"dup"\s*,\s*[^)]*externalLinkKey/);
    expect(src).not.toMatch(/sp\.set\(\s*"dup"\s*,\s*[^)]*c\.name/);
    expect(src).not.toMatch(/sp\.set\(\s*"dup"\s*,\s*[^)]*c\.address/);
    // 唯一の sp.set("dup", ...) は enum string の `next` であること。
    expect(src).toMatch(/sp\.set\(\s*"dup"\s*,\s*next\s*\)/);
  });
});

// Codex P2 (round 2): merge UI scoping
//
// DuplicateGroupCard は matchedBy === "name_address" のときのみ merge 関連 UI
// (master/source 列 + OwnerMergePreviewButton) を表示する。corporate_number /
// external_link_key 経路ではメッセージのみで merge ボタンを出さない。
describe("correction page: Codex P2 (round 2) merge UI scoping", () => {
  it("supportsMerge は matchedBy === 'name_address' と紐づけている", () => {
    expect(src).toMatch(
      /const\s+supportsMerge\s*=\s*matchedBy\s*===\s*"name_address"/,
    );
  });

  it("OwnerMergePreviewButton は supportsMerge=true の分岐内でのみ render される", () => {
    // supportsMerge ? (...OwnerMergePreviewButton...) : (...) という構造を
    // 担保する（OwnerMergePreviewButton の前に supportsMerge ? が出ること）。
    expect(src).toMatch(
      /supportsMerge\s*\?\s*\([\s\S]*?OwnerMergePreviewButton[\s\S]*?\)\s*:\s*\(/,
    );
  });

  it("master/source ヘッダー列は supportsMerge 条件付きで render される", () => {
    expect(src).toMatch(
      /\{supportsMerge\s*&&\s*<th[^>]*>\s*master\s*<\/th>\}/,
    );
    expect(src).toMatch(
      /\{supportsMerge\s*&&\s*<th[^>]*>\s*source\s*<\/th>\}/,
    );
  });

  it("merge 非対応 group 用の注記要素が存在する（data-testid 付き）", () => {
    expect(src).toMatch(/data-testid="duplicate-group-merge-unsupported-notice"/);
  });

  it("merge 非対応 group の注記文言に「要確認」を含む", () => {
    expect(src).toMatch(/法人番号一致のため要確認/);
    expect(src).toMatch(/リンクキー一致のため要確認/);
  });

  it("DuplicateGroupSummary の説明文が氏名住所一致限定の merge 制限を明示している", () => {
    expect(src).toMatch(/氏名住所一致[\s\S]{0,80}master\s*\/\s*source[\s\S]{0,80}統合プレビュー/);
  });
});

// Codex P1 (round 2): corporate_number 重複検出の権限不足メッセージ
//
// page.tsx は API レスポンスの `summary.corporateNumberDuplicateAvailable`
// が false のとき、duplicate タブ + corporate_number サブフィルタで
// 「権限がありません」メッセージを表示する。raw 法人番号は含めず enum/flag のみ。
describe("correction page: Codex P1 (round 2) corporate_number 権限不足メッセージ", () => {
  it("corporateNumberDuplicateAvailable === false の分岐で notice を表示する", () => {
    expect(src).toMatch(
      /data\.summary\.corporateNumberDuplicateAvailable\s*===\s*false/,
    );
  });

  it("duplicate タブ + corporate_number サブフィルタ条件で表示する", () => {
    // 同じ JSX ブロック内で filterType === "duplicate" / duplicateSubFilter === "corporate_number" /
    // corporateNumberDuplicateAvailable === false の 3 条件を AND している。
    expect(src).toMatch(
      /filterType\s*===\s*"duplicate"[\s\S]{0,400}duplicateSubFilter\s*===\s*"corporate_number"[\s\S]{0,400}corporateNumberDuplicateAvailable\s*===\s*false/,
    );
  });

  it("notice 要素に data-testid が付いている", () => {
    expect(src).toMatch(
      /data-testid="corporate-number-duplicate-permission-denied"/,
    );
  });

  it("notice 文言に「権限がありません」と必要権限を含む", () => {
    expect(src).toMatch(/権限がありません/);
    expect(src).toMatch(/owner_corporate_number=full/);
  });

  it("notice 文言に PII / 法人番号生値を埋め込んでいない", () => {
    // 注記文中に owner.corporateNumber や c.name 等を直接埋め込む箇所がない。
    const denialBlockMatch = src.match(
      /data-testid="corporate-number-duplicate-permission-denied"[\s\S]{0,400}<\/p>/,
    );
    expect(denialBlockMatch).not.toBeNull();
    const denialBlock = denialBlockMatch?.[0] ?? "";
    expect(denialBlock).not.toMatch(/\{[^}]*corporateNumber[^}]*\}/);
    expect(denialBlock).not.toMatch(/\{[^}]*c\.name[^}]*\}/);
    expect(denialBlock).not.toMatch(/\{[^}]*c\.address[^}]*\}/);
    expect(denialBlock).not.toMatch(/\{[^}]*externalLinkKey[^}]*\}/);
  });
});

// Codex P1 (round 3): non-name duplicate の archive ガード + reason ラベル
//
// route 側で recommendedAction を review に落としている前提だが、UI でも
// 多重防御として「matchedBy が corporate_number / external_link_key の場合
// orphan タブで archive button を出さない」を担保する。また新規 blockReason
// （非 PII enum）のラベルが BLOCK_REASON_LABELS に登録されていることも担保。
describe("correction page: Codex P1 (round 3) non-name duplicate ガード + ラベル", () => {
  it("orphan archive button の表示条件に duplicateMatchedBy ガードがある（corporate_number 除外）", () => {
    expect(src).toMatch(
      /c\.duplicateMatchedBy\s*!==?\s*"corporate_number"/,
    );
  });

  it("orphan archive button の表示条件に duplicateMatchedBy ガードがある（external_link_key 除外）", () => {
    expect(src).toMatch(
      /c\.duplicateMatchedBy\s*!==?\s*"external_link_key"/,
    );
  });

  it("orphan archive button の前段で recommendedAction === 'delete_candidate' チェックも維持されている", () => {
    // recommendedAction チェック → matchedBy ガード の順で AND 連結している
    // ことを確認する。Defense in Depth のコメントが間に挟まるので幅を広めに取る。
    expect(src).toMatch(
      /recommendedAction\s*===\s*"delete_candidate"[\s\S]{0,800}duplicateMatchedBy\s*!==?\s*"corporate_number"[\s\S]{0,400}duplicateMatchedBy\s*!==?\s*"external_link_key"[\s\S]{0,400}<OwnerArchiveButton/,
    );
  });

  it("BLOCK_REASON_LABELS に corporate_number_duplicate_requires_review のラベルがある", () => {
    expect(src).toMatch(
      /corporate_number_duplicate_requires_review\s*:\s*"法人番号重複（要確認）"/,
    );
  });

  it("BLOCK_REASON_LABELS に external_link_key_duplicate_requires_review のラベルがある", () => {
    expect(src).toMatch(
      /external_link_key_duplicate_requires_review\s*:\s*"外部キー重複（要確認）"/,
    );
  });
});
