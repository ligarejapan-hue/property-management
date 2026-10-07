import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 棟の画面は、名前を直して保存する前に「部屋N件の物件名も直します」と確認する(段3・Task 14)。
 * 画面そのものは描画テストの形に合わないため、ソースの並びで固定する(リポジトリの慣習)。
 */
const PAGE = readFileSync(
  join(process.cwd(), "src/app/(dashboard)/buildings/[id]/page.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("棟の画面の保存(名前の反映の確認)", () => {
  const start = PAGE.indexOf("const handleSave = async");
  const body = PAGE.slice(start, PAGE.indexOf("\n  };", start));

  it("確認の文を作ってから、保存中の表示(setSaving(true))に入る", () => {
    expect(start).toBeGreaterThan(-1);
    const iMsg = body.indexOf("renamePropagateConfirmMessage(");
    const iSaving = body.indexOf("setSaving(true)");
    expect(iMsg).toBeGreaterThan(-1);
    expect(iSaving).toBeGreaterThan(iMsg);
  });

  it("やめる(confirm が false)なら何も送らず戻る", () => {
    expect(body).toMatch(/if \(msg && !window\.confirm\(msg\)\) return;/);
    expect(body.indexOf("window.confirm(msg)")).toBeLessThan(body.indexOf("await updateBuilding("));
  });

  it("確認の部品は prisma を持ち込まない読み込み元から取る", () => {
    expect(PAGE).toMatch(/from "@\/lib\/building-link\/rename";/);
    const rename = readFileSync(join(process.cwd(), "src/lib/building-link/rename.ts"), "utf8");
    // 値としての import は edit-lock/rules(定数だけ)のみ。prisma は型 import だけ。
    expect(rename).toMatch(/import type \{ Prisma \} from "@\/generated\/prisma";/);
    expect(rename).not.toMatch(/from "@\/lib\/prisma"/);
  });
});
