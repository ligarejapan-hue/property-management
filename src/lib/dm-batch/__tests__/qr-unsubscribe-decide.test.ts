import { describe, it, expect } from "vitest";
import { decideBatchUnsubscribeTarget } from "../qr-unsubscribe-target";

describe("停止でどの送付記録に拒否を付けるか(状態の総当たり)", () => {
  const cases: Array<[string | null, boolean, boolean, string]> = [
    // logId,  logExists, confirmed, 期待
    [null, false, false, "create"], // 確定前・未記録 → この1通の記録を作る
    [null, false, true, "legacy_lookup"], // 確定済みなのに結び付き無し=本機能より前の控え
    ["L", true, false, "use"], // 確定前に一度停止済み(二度目の押下)
    ["L", true, true, "use"], // 確定済み(確定で結んだ記録)
    ["L", false, false, "create"], // 結んだ記録が消えた(物件削除)・確定前 → 作り直す
    ["L", false, true, "legacy_lookup"], // 結んだ記録が消えた・確定済み → 引き当てを試す
  ];
  it.each(cases)("logId=%s logExists=%s confirmed=%s → %s", (logId, logExists, confirmed, expected) => {
    expect(decideBatchUnsubscribeTarget({ logId, logExists, confirmed })).toBe(expected);
  });
});
