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
