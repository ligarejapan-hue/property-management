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

  it("ページ最後の1件を取り消したら前のページへ戻る(#364 R4)", () => {
    expect(VIEW).toMatch(/logs\.length === 1 && page > 1/);
    expect(VIEW).toMatch(/setPage\(\(p\) => Math\.max\(1, p - 1\)\)/);
  });

  it("取消は confirm を挟み、取消不可の行(売却DM/一括確定由来)にはボタンを出さない", () => {
    expect(VIEW).toContain("この送付記録を取り消しますか？");
    expect(VIEW).toMatch(/\{log\.deletable && \(/);
    // 取消可否の判定はサーバ側(GET が deletable を返す)
    expect(ROUTE).toMatch(/deletable: log\.method !== "sale_dm" && log\.batchId == null/);
  });

  it("投函日は今日既定・max=今日(未来はUIでも選べない)", () => {
    expect(VIEW).toMatch(/useState\(todayJst\(\)\)/);
    expect(VIEW).toMatch(/max=\{todayJst\(\)\}/);
  });
});

describe("dm-logs-view: 反響の表示と入力(PR-B・設計§3)", () => {
  it("GET が反響4項目を返し view の型に載っている", () => {
    expect(ROUTE).toMatch(/reactionStatus: log\.reactionStatus/);
    expect(ROUTE).toMatch(/reactionSource: log\.reactionSource/);
    // reactionNote は note と同じ表示レベルでマスク
    expect(ROUTE).toMatch(
      /reactionNote: maskValue\(log\.reactionNote, ownerDisplayConfig\.note\)/,
    );
    expect(VIEW).toMatch(/reactionStatus: string/);
  });

  it("「反響」列があり REACTION_LABELS の日本語ラベルで表示(生値の英字を出さない)", () => {
    expect(VIEW).toContain("反響");
    expect(VIEW).toMatch(/REACTION_LABELS/);
  });

  it("編集は api-client(updatePropertyDmLogReaction)経由+canWrite ゲート", () => {
    expect(VIEW).toMatch(/updatePropertyDmLogReaction\(propertyId,/);
  });

  it("売却DM由来(ブリッジ行)も編集可・同期由来は(自動)表示", () => {
    // 反響編集ボタンは log.deletable でなく canWrite で出す(サーバが優先規則で解決)
    expect(VIEW).toMatch(/sale_dm_sync/);
    expect(VIEW).toContain("(自動)");
  });

  it("宛先不明の影響を平易な日本語で説明している", () => {
    expect(VIEW).toContain("宛先不明");
    expect(VIEW).toMatch(/対象から外/);
  });
});

describe("dm-logs-view: メモのマスク往復防止(#366 R2/R3)", () => {
  it("メモは空で開始+「メモを消す」明示チェック(note: null 送信)", () => {
    // マスク表示値をフォームに流し込まない(実メモをマスク値で潰さない)
    expect(VIEW).not.toMatch(/useState\(log\.reactionNote/);
    expect(VIEW).toContain("メモを消す");
    expect(VIEW).toMatch(/\{ note: null \}/);
  });
});
