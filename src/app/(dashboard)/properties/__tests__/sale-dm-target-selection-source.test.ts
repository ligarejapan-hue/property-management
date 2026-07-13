import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// jsdom 無し(env=node)のため、page.tsx のソース文字列でUI配線の回帰を守る。
const src = readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/properties/page.tsx"),
  "utf-8",
);

describe("properties page: 売却DM対象選択の配線", () => {
  it("作成は選択(selectedIds)を『今読み込んでいる物件』に intersect して propertyIds で送る(Codex R11)", () => {
    expect(src).toContain("properties.filter((p) => selectedIds.has(p.id))");
    expect(src).toContain("propertyIds: ids");
  });

  it("作成ボタンは選択0件/読み込み中は無効(競合クリック防止・Codex R11)", () => {
    expect(src).toContain("disabled={creatingDm || loading || selectedIds.size === 0}");
  });

  it("表示条件変更(setPage)で選択を同期的にクリアする(競合の芽を断つ・Codex R12)", () => {
    // setPage を包み、ページ/フィルタ/検索/並べ替えの変更時に selectedIds をその場でクリアする
    expect(src).toContain("setPageState(updater)");
  });

  it("確認ダイアログに(表示中の)選択件数を出す", () => {
    expect(src).toContain("選択した ${ids.length} 件");
  });

  it("送信回数の並べ替え(少ない順/多い順)がある", () => {
    expect(src).toContain('value="dmSendCount:asc"');
    expect(src).toContain('value="dmSendCount:desc"');
  });

  it("送信回数 N回以下 の抽出フィルタがある", () => {
    expect(src).toContain("sendCountMaxFilter");
    expect(src).toContain("params.dmSentMax");
    expect(src).toContain('<option value="0">未送信');
  });

  it("一覧行に送信回数(dmSentCount)を表示する", () => {
    expect(src).toContain("dmSentCount");
  });

  it("読み込んだ物件で選択(selectedIds)を絞り込み、見えない stale 選択を送らない(Codex R7)", () => {
    expect(src).toContain("loadedIds.has(id)");
  });
});
