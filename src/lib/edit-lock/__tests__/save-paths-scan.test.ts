import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 保存の窓口が増えても鍵の確認を忘れないための走査テスト。
 * ⚠新しい窓口を足したらこの一覧にも足す(足さずに通ると鍵が意味を失う)。
 *
 * ⚠5つの識別子(review Minor 5): どれか1つでも実装から消えると、この検査は
 * 落ちなければならない。行ロックの呼び方は資源の種類で違う(物件=lockPropertyRow・
 * 所有者=lockOwnerRow)ので、窓口ごとに正しいロック関数を指定する。
 */
const GUARDED: Array<{ path: string; rowLock: RegExp }> = [
  { path: "src/app/api/properties/[id]/route.ts", rowLock: /lockPropertyRow\(/ },
  { path: "src/app/api/owners/[id]/route.ts", rowLock: /lockOwnerRow\(/ },
  { path: "src/app/api/owners/[id]/corporate-apply/route.ts", rowLock: /lockOwnerRow\(/ },
];

describe("保存の窓口の鍵の確認", () => {
  for (const { path: rel, rowLock } of GUARDED) {
    it(`${rel} は $transaction・行ロック・鍵の確認(assertNotEditLockedByOther・readScreenTokenHash・readLockId)をすべて呼ぶ`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      expect(src).toMatch(/\$transaction\(/);
      expect(src).toMatch(rowLock);
      expect(src).toMatch(/assertNotEditLockedByOther\(/);
      expect(src).toMatch(/readScreenTokenHash\(/);
      expect(src).toMatch(/readLockId\(/);
    });
  }
});
