/**
 * preflight のキーの作り分け（@codex #373 P1 の回帰テスト）。
 *
 * ⚠**送るIDの並び**と**取り直しの合図を含むキー**を1つにまとめると、
 * `0|<uuid>` のような値がそのまま `fetchRegistryPreflight` へ渡り、
 * サーバーが 400（物件IDの形式が不正）で弾く。すると:
 *
 *   取得失敗 → 分類が読めない（fail closed）→ **実行ボタンが永久に無効**
 *
 * となり、**謄本の取得が全部できなくなる**。
 * 単発の取得も、既存の事前警告（取得済み・所有者あり）が出なくなる。
 *
 * ⚠この壊れ方はソース走査のテストでは捕まらない（jsdom が無いのでフックを
 * 実行できない）。だからキーの作り分けだけを純関数に切り出して固定する。
 */
import { describe, it, expect } from "vitest";
import { buildPreflightKeys } from "@/components/properties/registry-preflight-warnings";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("⚠APIへ送るIDに合図を混ぜない", () => {
  it.each([0, 1, 7])(
    "取り直しの合図が %s でも、送るIDはUUIDのまま",
    (token) => {
      const { idsKey } = buildPreflightKeys([A, B], token);
      for (const id of idsKey.split(",")) {
        expect(id).toMatch(UUID_RE);
      }
    },
  );

  it("送るIDに区切り記号 | が入らない", () => {
    expect(buildPreflightKeys([A], 3).idsKey).not.toContain("|");
  });

  it("1件のときも同じ", () => {
    expect(buildPreflightKeys([A], 5).idsKey).toBe(A);
  });
});

describe("取り直しの合図はキャッシュキーにだけ入れる", () => {
  it("合図が変わればキャッシュキーも変わる（＝取り直しが走る）", () => {
    const k0 = buildPreflightKeys([A], 0);
    const k1 = buildPreflightKeys([A], 1);
    expect(k0.cacheKey).not.toBe(k1.cacheKey);
    // ⚠送るIDは変わらない。
    expect(k0.idsKey).toBe(k1.idsKey);
  });

  it("合図が同じならキャッシュキーも同じ（無駄な取り直しをしない）", () => {
    expect(buildPreflightKeys([A, B], 2).cacheKey).toBe(
      buildPreflightKeys([A, B], 2).cacheKey,
    );
  });
});

describe("選択の順番に依存しない（無駄な取り直しをしない）", () => {
  it("並び順が違っても同じキーになる", () => {
    expect(buildPreflightKeys([A, B], 0)).toEqual(
      buildPreflightKeys([B, A], 0),
    );
  });
});

describe("空のとき", () => {
  it("送るIDは空文字（呼び出し側が length で止める）", () => {
    expect(buildPreflightKeys([], 0).idsKey).toBe("");
  });
});
