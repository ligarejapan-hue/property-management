/**
 * DM送付履歴の表示強化(PR-A・設計書§2.6)の配線。
 *  - GET が dmType/sequence(表示時導出の何通目)を返す
 *  - view は日本語ラベル(dmMethodLabel/dmTypeLabel)を使い生値の英字を出さない
 *  - 個別記録の追加フォーム・取消ボタン(sale_dm 行は出さない)・write 権限ゲート
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const ROUTE = read("src/app/api/properties/[id]/dm-logs/route.ts");
const VIEW = read("src/components/properties/dm-logs-view.tsx");

describe("GET /dm-logs: 何通目の表示時導出(§2.2・R26)", () => {
  it("sentAt,createdAt,id の昇順全件から連番 Map を作り data に載せる", () => {
    expect(ROUTE).toMatch(
      /orderBy: \[\{ sentAt: "asc" \}, \{ createdAt: "asc" \}, \{ id: "asc" \}\]/,
    );
    expect(ROUTE).toMatch(/sequenceById = new Map\(allIdsAsc\.map\(\(row, i\) => \[row\.id, i \+ 1\]\)\)/);
    expect(ROUTE).toMatch(/sequence: sequenceById\.get\(log\.id\)/);
    expect(ROUTE).toMatch(/dmType: log\.dmType/);
  });

  it("sequence 列(採番)は使わない", () => {
    expect(ROUTE).not.toMatch(/sequence:\s*\{\s*increment/);
    expect(ROUTE).not.toMatch(/MAX\(sequence\)/i);
  });
});

describe("dm-logs-view: 表示強化と個別記録UI", () => {
  it("method/dmType は日本語ラベル関数を通す(生値の英字を出さない)", () => {
    expect(VIEW).toMatch(/dmMethodLabel\(log\.method\)/);
    expect(VIEW).toMatch(/dmTypeLabel\(log\.dmType\)/);
    expect(VIEW).not.toMatch(/\{log\.method \?\?/);
  });

  it("「何通目」「種別」列がある", () => {
    expect(VIEW).toContain("何通目");
    expect(VIEW).toContain("種別");
    expect(VIEW).toMatch(/\$\{log\.sequence\}通目/);
  });

  it("追加/取消は api-client 経由+property:write ゲート", () => {
    expect(VIEW).toMatch(/createPropertyDmLog\(propertyId,/);
    expect(VIEW).toMatch(/deletePropertyDmLog\(propertyId, logId\)/);
    expect(VIEW).toMatch(/action === "write" && p\.granted/);
    expect(VIEW).toMatch(/\{canWrite && \(/);
  });

  it("取消は confirm を挟み、sale_dm 行にはボタンを出さない", () => {
    expect(VIEW).toContain("この送付記録を取り消しますか？");
    expect(VIEW).toMatch(/log\.method !== "sale_dm" && \(/);
  });

  it("投函日は今日既定・max=今日(未来はUIでも選べない)", () => {
    expect(VIEW).toMatch(/useState\(todayJst\(\)\)/);
    expect(VIEW).toMatch(/max=\{todayJst\(\)\}/);
  });
});
