/**
 * 型の凍結印を立てる経路の**走査型ガード**（設計 §2.4 @codex R24→R31→R35）。
 *
 * 凍結の証拠（confirmed/sent の draft）は、割当や個別編集で**型から離れたり
 * 確定が解除されたり**して消える。消える前に列（template_frozen_at）へ固定して
 * おかないと、送付済み文面の出所が失われる。
 *
 * ⚠route 名を手で並べない。「確定を作る／動かす／戻す」＝ソースに `confirmedAt` を
 * 書いている sale-dm の書き込み route を機械的に対象にするので、**将来 route を
 * 足したときの付け忘れも落ちる**（PR-D1 の走査が7本目を検出した形）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "src/app/api/properties/sale-dm");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

/** 凍結印を立てなくてよい route（理由を必ず書く）。 */
const EXCEPTIONS: Record<string, string> = {
  // 型の設定変更・削除は「凍結済みなら断る」側。断るので確定を戻す処理に到達しない。
  "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts":
    "凍結済みなら 409 で断るため、確定を戻す処理に到達しない",
  // 貼り付け保存は「確定を作る/動かす/戻す」ではない。凍結済みなら差し替えを拒否する側。
  "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/template/route.ts":
    "確定に触れない（凍結済みは差し替えを拒否する側）",
};

const FILES = routeFiles(ROOT);

describe("sale-dm: 確定を作る/動かす/戻す経路は凍結印を立てる", () => {
  it("走査できている（0件なら検査が空振り）", () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  const touchesConfirmation = FILES.filter((f) => {
    const s = readFileSync(f, "utf-8");
    return (
      /export async function (POST|PATCH|PUT|DELETE)\b/.test(s) &&
      s.includes("confirmedAt")
    );
  });

  it("確定に触れる書き込み route が見つかっている", () => {
    expect(touchesConfirmation.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of touchesConfirmation) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
    const reason = EXCEPTIONS[rel];
    it(`${rel}${reason ? `（除外: ${reason}）` : ""}`, () => {
      if (reason) return;
      const s = readFileSync(file, "utf-8");
      expect(
        s.includes("markVariantsFrozen"),
        `${rel} が凍結印を立てていない`,
      ).toBe(true);
    });
  }
});

describe("型の設定変更・削除は凍結済みなら断る", () => {
  const s = readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts",
    ),
    "utf-8",
  );

  it("凍結の二重判定を使う（列だけ・派生だけにしない）", () => {
    expect(s).toContain("isVariantFrozen");
  });

  it("削除も同じ判定をロックの下で行う", () => {
    const del = s.slice(s.indexOf("export async function DELETE"));
    expect(del).toContain("isVariantFrozen");
    expect(del).toMatch(/FROM dm_variants[\s\S]{0,200}FOR UPDATE/);
  });
});
