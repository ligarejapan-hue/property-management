/**
 * 重複候補の一覧の「状態」は、ほかの画面と同じ案件ステータスの名前を使う(@codex #538 R4 P2)。
 * 独自の表(active/closed/pending)を持つと、実際の値(new_case・contracted など)が内部名のまま出る。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(process.cwd(), "src/components/properties/candidate-list.tsx"), "utf8");

describe("重複候補の一覧: 案件ステータスの名前", () => {
  it("共通の CASE_STATUS_LABELS を property-types から読む", () => {
    expect(src).toMatch(/import \{[^}]*\bCASE_STATUS_LABELS\b[^}]*\} from "@\/lib\/property-types"/);
  });

  it("独自の名前の表を持たない", () => {
    expect(src).not.toMatch(/const CASE_STATUS_LABELS/);
    expect(src).not.toContain('active: "進行中"');
  });
});
