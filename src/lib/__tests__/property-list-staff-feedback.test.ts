import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { buildPropertyListWhere } from "../property-list-query";
import { propertyListQuerySchema } from "../validators";

// 従業員の指摘(2026-10-24): 物件名で覚えている/登録日順で管理したい。
const adminSession = { id: "u1", role: "admin" } as never;
const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

describe("キーワード検索で物件名(マンション名)も探す", () => {
  it("keyword の OR に buildingName が入る", async () => {
    const query = propertyListQuerySchema.parse({ keyword: "サニーハイツ" });
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.OR).toContainEqual({ buildingName: { contains: "サニーハイツ", mode: "insensitive" } });
    // 既存の住所検索は残る
    expect(where.OR).toContainEqual({ address: { contains: "サニーハイツ", mode: "insensitive" } });
  });
});

describe("一覧API は登録日と物件名を返す", () => {
  const route = read("src/app/api/properties/route.ts");
  it("select に createdAt と buildingName がある", () => {
    expect(route).toMatch(/\n\s+createdAt: true,/);
    expect(route).toMatch(/\n\s+buildingName: true,/);
  });
});

describe("物件詳細の所有者カードに所有者の備考を出す(Excel取込のコメント列の行き先)", () => {
  const detail = read("src/app/(dashboard)/properties/[id]/page.tsx");
  it("表示ビューに「所有者の備考」があり、改行を保って出す", () => {
    expect(detail).toContain('<OwnerNoteField note={po.owner.note} />');
    expect(detail).toMatch(/function OwnerNoteField[\s\S]*?所有者の備考[\s\S]*?whitespace-pre-wrap/);
  });
  it("表示レベルで隠された(キーが無い)・空のときは出さない", () => {
    expect(detail).toMatch(/function OwnerNoteField[\s\S]*?if \(note == null \|\| note\.trim\(\) === ""\) return null;/);
  });
});

describe("物件一覧の画面", () => {
  const page = read("src/app/(dashboard)/properties/page.tsx");

  it("既定の並びは登録日の新しい順", () => {
    expect(page).toContain('const DEFAULT_SORT = "createdAt:desc"');
    // 既定値の直書きが残っていない(残るとリセット・URL・件数バッジがずれる)
    expect(page).not.toMatch(/(\?\?|!==|setSort\() ?"updatedAt:desc"/);
  });

  it("並べ替えに登録日の新しい順/古い順があり、更新日の並びも残す", () => {
    expect(page).toContain('<option value="createdAt:desc">登録日 新しい順</option>');
    expect(page).toContain('<option value="createdAt:asc">登録日 古い順</option>');
    expect(page).toContain('<option value="updatedAt:desc">更新日 新しい順</option>');
  });

  it("表の見出しに登録日がある", () => {
    expect(page).toMatch(/>\s*登録日\s*</);
  });

  it("物件名を PC の表とスマホのカードの両方に出す", () => {
    const matches = page.match(/property\.buildingName/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
