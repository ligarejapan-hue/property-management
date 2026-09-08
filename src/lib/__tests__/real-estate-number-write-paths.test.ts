/**
 * 不動産番号を**手入力で新しく入れられる口**が増えていないかの走査。
 *
 * ⚠経緯(@codex #420): 画面の入力欄を消す → 3つのスキーマをサーバーで塞ぐ、と
 *   2回に分けて直したのに、**4か所目**(棟の中の部屋を作る口)が独自スキーマで
 *   取り残されていた。1か所ずつ潰す直し方をやめ、**全経路を機械に数えさせる**。
 *
 * 方針:
 *   - 物件(Property)を作る/更新する route が zod で realEstateNumber を受けるなら、
 *     共通の `clearOnlyRealEstateNumber` を通っていなければならない。
 *   - 例外は**取込系だけ**(CSV / 謄本PDF)。重複判定の第1キーなので意図的に残す。
 *     許可リストには**理由を必ず書く**。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const API_ROOT = path.resolve(process.cwd(), "src/app/api");

/** 取込系だけが例外。ここに足すときは理由を書くこと。 */
const ALLOWED_FREEFORM: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "import/csv/route.ts",
    reason:
      "CSV取込。realEstateNumber は import-dedupe の重複判定**第1キー**。外部データの番号は使う。",
  },
  {
    file: "import/csv/preview/route.ts",
    reason: "CSV取込の下見。取込本体と同じ列マッピングを使う(保存はしない)。",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name === "route.ts") out.push(p);
  }
  return out;
}

const ROUTES = walk(API_ROOT).map((abs) => ({
  rel: path.relative(API_ROOT, abs).split(path.sep).join("/"),
  src: fs.readFileSync(abs, "utf8"),
}));

/** zod で realEstateNumber を「自由入力として」受けている宣言。 */
const FREEFORM_DECL = /realEstateNumber:\s*z\./;

describe("不動産番号: 手入力で新しく入れられる口を増やさない", () => {
  it("走査対象の route を実際に読めている(空振り防止)", () => {
    expect(ROUTES.length).toBeGreaterThan(50);
    expect(ROUTES.some((r) => r.rel === "properties/route.ts")).toBe(true);
    expect(
      ROUTES.some((r) => r.rel === "buildings/[id]/properties/route.ts"),
    ).toBe(true);
  });

  it("物件を作る/更新する route は共通スキーマを通す(取込系だけが例外)", () => {
    const allowed = new Set(ALLOWED_FREEFORM.map((a) => a.file));
    const offenders = ROUTES.filter((r) => {
      if (allowed.has(r.rel)) return false;
      const writesProperty =
        r.src.includes("prisma.property.create") ||
        r.src.includes("prisma.property.update");
      if (!writesProperty) return false;
      return FREEFORM_DECL.test(r.src);
    }).map((r) => r.rel);

    expect(offenders).toEqual([]);
  });

  it("共通スキーマは「消すことは許し、入れることは断る」", async () => {
    const { clearOnlyRealEstateNumber } = await import("@/lib/validators");
    // 消す = 通る
    for (const ok of [null, undefined, "", "   ", "　"]) {
      expect(() => clearOnlyRealEstateNumber.parse(ok)).not.toThrow();
    }
    // 入れる = 断る (正しい13桁でも)
    for (const ng of ["1234567890123", "１２３", "0000000000001", "abc"]) {
      expect(() => clearOnlyRealEstateNumber.parse(ng)).toThrow();
    }
  });

  it("手入力の4つの口がすべて共通スキーマを名指ししている", () => {
    const validators = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/validators.ts"),
      "utf8",
    );
    // 物件の新規作成 / ピンからの物件化 / 物件の編集
    const uses = validators.match(/realEstateNumber: clearOnlyRealEstateNumber/g) ?? [];
    expect(uses.length).toBe(3);
    // 棟の中の部屋を作る口 (独自スキーマだったので取り残された)
    const unit = ROUTES.find((r) => r.rel === "buildings/[id]/properties/route.ts");
    expect(unit).toBeDefined();
    expect(unit!.src).toMatch(/realEstateNumber: clearOnlyRealEstateNumber/);
  });

  it("⚠例外(取込系)には必ず理由が書かれている", () => {
    for (const a of ALLOWED_FREEFORM) {
      expect(a.reason.trim().length).toBeGreaterThan(15);
      // 実在するファイルだけを許可する(消えた道を許可し続けない)
      expect(ROUTES.some((r) => r.rel === a.file)).toBe(true);
    }
  });
});
