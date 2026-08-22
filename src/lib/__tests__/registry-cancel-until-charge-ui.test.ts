/**
 * 「中止は請求(課金)の直前まで効く」の画面側 source assertion。
 *
 * 発注者指示 (2026-08-21):「確定ボタンを押すまでは中止ボタンを出してください。」
 *
 * ⚠このリポは jsdom 未導入。クリック挙動は検証できないので、
 *   **判定を純関数へ出し**(cancel-visibility.ts)、画面側は
 *   「その純関数を使っていること」「文言から推測していないこと」を走査で固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const PANEL = read("src/components/properties/registry-live-panel.tsx");
const BUTTON = read(
  "src/components/properties/registry-location-search-button.tsx",
);
const CLIENT = read("src/lib/api-client.ts");
const STORE = read("src/lib/registry-fetch/live-view-store.ts");

describe("サーバーが中止の可否を答える", () => {
  it("実況の取得結果に cancelable が含まれる", () => {
    expect(STORE).toContain("cancelable:");
    expect(CLIENT).toContain("cancelable?: boolean;");
  });

  it("⚠完了後は cancelable を true にしない", () => {
    // 終わったのに「中止できます」と答えると、押しても効かないボタンが出る。
    expect(STORE).toContain("cancelable: !entry.done && activeOps.has(k)");
  });
});

describe("パネルはサーバーの答えだけで判断する", () => {
  it("判定を純関数 shouldShowCancelButton に委ねている", () => {
    expect(PANEL).toContain("shouldShowCancelButton({");
    expect(PANEL).toContain("cancelWindowOpen: serverCancelable");
  });

  it("⚠実況の文言から課金前かを推測していない", () => {
    // 文言照合で可否を決めると、文言を1つ変えただけで**課金中に中止ボタンが出る**。
    expect(PANEL).not.toContain("まだ課金されていません");
    expect(PANEL).not.toContain("ここから請求");
  });

  it("応答に cancelable が無い(古いサーバー)ときは不明として扱う", () => {
    // ⚠`?? true` のような既定値にすると、効かないボタンが出る。
    expect(PANEL).toContain(
      'typeof res.data.cancelable === "boolean" ? res.data.cancelable : null',
    );
  });

  it("受付が閉じたら理由を出す(黙って消さない)", () => {
    expect(PANEL).toContain("cancelClosedNotice({");
    expect(PANEL).toContain("{closedNotice}");
  });
});

describe("有料取得でも中止の話をしてよい経路になっている", () => {
  it("取得中・回収中もパネルに cancelable を渡す", () => {
    // ⚠ここが searching だけに戻ると、サーバーが受け付けていても画面に出ない。
    const at = BUTTON.indexOf("cancelable={");
    expect(at).toBeGreaterThan(-1);
    const block = BUTTON.slice(at, at + 220);
    expect(block).toContain('state === "searching"');
    expect(block).toContain('state === "obtaining"');
    expect(block).toContain('state === "recovering"');
  });

  it("中止を押した瞬間に画面側でも覚える(応答待ちの間に自動で進まない)", () => {
    expect(BUTTON).toContain("onCancelRequested");
    expect(BUTTON).toContain("searchCancelledRef.current = true;");
  });
});
