/**
 * 売却DM の**書き込み系 route は全部** property:write を要求する（設計 §2.5）。
 *
 * これまでの実質的な門は `sale_dm:generate` だった（生成できなければ何も作れない）。
 * 外部AI方式では**生成なしで一式が作れる**ので、その門が外れる。閲覧権限だけの
 * 利用者が記録の作成・失効・確定までできてしまう前に、書き込み系を揃える。
 *
 * ⚠route 名を手で並べない。sale-dm 配下の route.ts を走査し、POST/PATCH/DELETE/PUT を
 * 公開しているものを機械的に対象にするので、**将来 route を足したときの付け忘れも落ちる**。
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

/** 書き込み門を要求しない route（理由を必ず書く）。mustContain を書けば、代わりにその
 *  文字列を含むことを固定できる(「例外だから何も確かめない」にしない)。 */
const WRITE_GATE_EXCEPTIONS: Record<string, { reason: string; mustContain?: string }> = {
  // AI直結の再生成は廃止(設計§2.1)。設定も権限も見ずに 410 を返すだけの入口なので、
  // 書き込み門は不要(そもそも何も読まない・書かない)。
  "src/app/api/properties/sale-dm/drafts/[id]/regenerate/route.ts": {
    reason: "410 を返すだけ(データに触れない)",
  },
  "src/app/api/properties/sale-dm/lp-assets/[assetId]/route.ts": {
    reason: "管理者(user_management:write)限定の削除。requireSaleDmWriteAccess より強い門を inline で通す",
    mustContain: 'hasPermission(perms, "user_management", "write")',
  },
};

const FILES = routeFiles(ROOT);

describe("sale-dm: 書き込み系 route は property:write を要求する", () => {
  it("走査できている（0件なら検査が空振り）", () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  const writeRoutes = FILES.filter((f) =>
    /export async function (POST|PATCH|DELETE|PUT)\b/.test(
      readFileSync(f, "utf-8"),
    ),
  );

  it("書き込み route が実際に見つかっている", () => {
    expect(writeRoutes.length).toBeGreaterThan(4);
  });

  for (const file of writeRoutes) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
    const exception = WRITE_GATE_EXCEPTIONS[rel];
    it(`${rel}${exception ? `（除外: ${exception.reason}）` : ""}`, () => {
      const s = readFileSync(file, "utf-8");
      if (exception) {
        // 「例外だから見ない」にせず、mustContain があればその門(より強い権限チェック等)が
        // 実際にソースへ残っていることを固定する。
        if (exception.mustContain) expect(s).toContain(exception.mustContain);
        return;
      }
      const guarded =
        s.includes("requireSaleDmWriteAccess") ||
        /hasPermission\([^)]*"property"[^)]*"write"/.test(s);
      expect(guarded, `${rel} が書き込み門を通っていない`).toBe(true);
    });
  }
});
