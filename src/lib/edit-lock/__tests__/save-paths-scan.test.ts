import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 保存の窓口が増えても鍵の確認を忘れないための走査テスト。
 * ⚠新しい窓口を足したらこの一覧にも足す(足さずに通ると鍵が意味を失う)。
 */
const GUARDED = [
  "src/app/api/properties/[id]/route.ts",
  "src/app/api/owners/[id]/route.ts",
  "src/app/api/owners/[id]/corporate-apply/route.ts",
];

describe("保存の窓口の鍵の確認", () => {
  for (const rel of GUARDED) {
    it(`${rel} は assertNotEditLockedByOther を呼ぶ`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      expect(src).toMatch(/assertNotEditLockedByOther\(/);
      expect(src).toMatch(/readScreenTokenHash\(/);
      expect(src).toMatch(/readLockId\(/);
    });
  }
});
