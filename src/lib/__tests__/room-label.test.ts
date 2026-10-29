import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { roomLabel } from "../room-label";

/** src の中の .ts / .tsx(テストは除く)。 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "__tests__" || n === "node_modules" ? [] : sources(p);
    return /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("部屋番号の表示(「101号室号室」にしない・2026-10-30)", () => {
  it("数字だけなら「号室」を付ける・「号室」「号」で終わっていれば付け足さない・空なら null", () => {
    expect(roomLabel("101")).toBe("101号室");
    expect(roomLabel("101号室")).toBe("101号室");
    expect(roomLabel("101号")).toBe("101号");
    expect(roomLabel(" 101 号室 ")).toBe("101 号室");
    expect(roomLabel("Ａ－１")).toBe("Ａ－１号室");
    for (const x of [null, undefined, "", "  "]) expect(roomLabel(x)).toBeNull();
  });
  it("短い形(「号」)を選べる・「号室」で終わっていればそのまま", () => {
    expect(roomLabel("305", "号")).toBe("305号");
    expect(roomLabel("305号室", "号")).toBe("305号室");
  });
  it("部屋番号に「号室」「号」を文字でつなぐ書き方が残っていない(全部 roomLabel を通す)", () => {
    const hits = sources(join(process.cwd(), "src")).flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return /roomNo(?:\s*\?\?\s*"")?\}号/.test(src) ? [f] : [];
    });
    expect(hits).toEqual([]);
  });
});
