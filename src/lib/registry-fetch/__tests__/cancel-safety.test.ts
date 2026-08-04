/**
 * 謄本の自動取得を「途中で止める」ときの安全規則。
 *
 * 発注者要望 (2026-08-03):「途中で中止するボタンが欲しい。実況画面に置けるか」
 *
 * ⚠この機能の肝は**中止を無条件に許さない**こと。処理の途中でお金が動くため、
 * 課金の後に止めると「**お金は払ったのに書類が手に入らない**」状態を作る。
 * 既存コードが `charged_but_failed` という専用の失敗分類を持っているのは、
 * それが実際に起こり得て、しかも利用者に再実行させてはいけないため。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CANCEL_ACCEPTED_MESSAGE,
  CANCEL_IGNORED_CHARGED_MESSAGE,
  decideCancel,
} from "@/lib/registry-fetch/cancel-safety";

describe("decideCancel — 課金の前後で扱いを変える", () => {
  it("課金前に押されたら止める", () => {
    expect(decideCancel(true, false)).toEqual({ kind: "stop" });
  });

  it("⚠課金後は止めない（払ったのに書類が無い状態を作らない）", () => {
    expect(decideCancel(true, true)).toEqual({ kind: "ignore-charged" });
  });

  it("押されていなければ何もしない", () => {
    expect(decideCancel(false, false)).toEqual({ kind: "continue" });
    expect(decideCancel(false, true)).toEqual({ kind: "continue" });
  });
});

describe("利用者に出る文言", () => {
  it("⚠課金後は「止めました」と誤解させない（処理は続いている）", () => {
    expect(CANCEL_IGNORED_CHARGED_MESSAGE).toContain("中止できません");
    expect(CANCEL_IGNORED_CHARGED_MESSAGE).toContain("続けます");
    expect(CANCEL_IGNORED_CHARGED_MESSAGE).not.toContain("中止しました");
  });

  it("止まったときは課金が無いことまで伝える", () => {
    expect(CANCEL_ACCEPTED_MESSAGE).toContain("中止しました");
    expect(CANCEL_ACCEPTED_MESSAGE).toContain("課金は発生していません");
  });
});

describe("配線", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");

  it("⚠外から処理を殺さない（要求フラグを立てるだけ）", () => {
    // 強制終了すると外部サイトを中途半端な状態（カートに行だけ残る等）で
    // 放り出す。止まる場所は provider が安全な節目として選ぶ。
    const store = read("src/lib/registry-fetch/live-view-store.ts");
    expect(store).toMatch(/export function requestLiveViewCancel/);
    expect(store).toMatch(/entry\.cancelRequested = true/);
    // 中止 route は「要求を受ける」だけで、実行を止める処理を持たない
    const route = read(
      "src/app/api/properties/[id]/registry/search/live/[ref]/cancel/route.ts",
    );
    expect(route).toMatch(/requestLiveViewCancel/);
    expect(route).not.toMatch(/kill|abort|terminate/i);
  });

  it("⚠他人の実行は止められない（ストアの鍵に実行者が入る）", () => {
    const route = read(
      "src/app/api/properties/[id]/registry/search/live/[ref]/cancel/route.ts",
    );
    expect(route).toMatch(/requestLiveViewCancel\(session\.id, id, ref\)/);
    // 進行状況の取得と同じ認可を通す
    expect(route).toMatch(/registry", "auto_fetch"/);
    expect(route).toMatch(/canAccessPropertyRecord/);
  });

  it("provider は節目ごとに中止を見る", () => {
    const src = read("src/lib/registry-fetch/auto-fetch.ts");
    // reportLive のたびに checkCancel が走る（節目を別に数え上げると入れ忘れる）
    expect(src).toMatch(
      /const reportLive = \(label: string\): void => \{\s*\n\s*\/\/[^\n]*\n\s*checkCancel\(\);/,
    );
    expect(src).toMatch(/decideCancel\(requested, false\)/);
  });

  it("⚠中止を「外部サービスの障害」に潰さない (@codex #357 P2)", () => {
    // setup の catch が一律 provider_error に変換していると、利用者が押した
    // 中止まで 502 になり、実況にも監査にも「障害」として残る。
    const src = read("src/lib/registry-fetch/auto-fetch.ts");
    expect(src).toMatch(
      /if \(err instanceof RegistryFetchError\) throw err;[\s\S]{0,200}location search setup failed/,
    );
  });

  it("⚠まだ実況が無いときは「中止しています…」で固まらない (@codex #357 P2)", () => {
    // 検索 POST が実況を登録する前に押すと accepted:false が返る。無視すると
    // 実行は続いているのにボタンだけ死に、二度と中止できなくなる。
    const src = read("src/components/properties/registry-live-panel.tsx");
    expect(src).toMatch(/if \(!res\.data\.accepted\) setCancelling\(false\)/);
  });

  it("中止は「失敗」ではない分類で返す", () => {
    expect(read("src/lib/registry-fetch/errors.ts")).toMatch(
      /cancelled: "取得を中止しました。課金は発生していません。"/,
    );
    // 5xx（サーバー障害）にしない
    expect(read("src/lib/registry-fetch/search.ts")).toMatch(/cancelled: 409/);
  });
});
