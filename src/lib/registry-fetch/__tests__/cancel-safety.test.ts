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

  it("⚠実況が期限切れでも中止の印が残る (@codex #357 P2)", () => {
    // 検索は有料取得の待ち行列に入ると長く待たされる。実況エントリの寿命は3分
    // なので、待っている間に実況が消えて中止の印まで一緒に失われると
    // **「中止しました」と言ったのに動き出す**。印は実況とは別に持つ。
    const store = read("src/lib/registry-fetch/live-view-store.ts");
    expect(store).toMatch(/cancelMarks\.add\(k\)/);
    expect(store).toMatch(
      /store\.get\(k\)\?\.cancelRequested === true \|\| cancelMarks\.has\(k\)/,
    );
  });

  it("⚠ログインの前に中止を見る (@codex #357 P2)", () => {
    // 検索はアカウント同時1セッション制約のため順番待ちになることがある。
    // 待っている間の中止に気づかないと、(1)中止したのに外部サービスへ
    // ログインしてしまう (2)起動/ログインが失敗すると「中止」ではなく
    // 「外部サービスの障害」として残る。ブラウザ起動前とログイン前で見る。
    const src = read("src/lib/registry-fetch/official-provider.ts");
    expect(src).toMatch(/const abortIfCancelled = \(\): void =>/);
    // 順番待ちを抜けた直後（ブラウザ起動より前）
    expect(src).toMatch(
      /abortIfCancelled\(\);[\s\S]{0,400}?自動操作ブラウザを起動しています/,
    );
    // ログイン実行より前
    expect(src).toMatch(
      /abortIfCancelled\(\);[\s\S]{0,400}?登記情報提供サービスへログインしています/,
    );
    // 中止は「障害」に化けない（RegistryFetchError はそのまま通る）
    expect(src).toMatch(
      /if \(err instanceof RegistryFetchError\) return err;/,
    );
  });

  it("⚠待っている最中の中止を「障害」に化けさせない (@codex #357 P2)", () => {
    // ブラウザ起動やログインの待ちの最中に中止が押され、その待ちが失敗
    // (timeout 等)で終わると、そのまま分類すると**利用者が自分で止めたのに
    // 「外部サービスの障害」として実況にも監査にも残る**。
    const src = read("src/lib/registry-fetch/official-provider.ts");
    expect(src).toMatch(/const classifyOrCancelled = \(err: unknown\)/);
    expect(src).toMatch(/isCancelRequested\?\.\(\) === true[\s\S]{0,300}?"cancelled"/);
    // 起動の catch とログイン/検索の catch の両方で使う（片方だけだと漏れる）
    expect(src.match(/throw classifyOrCancelled\(err\)/g) ?? []).toHaveLength(2);
  });

  it("⚠待たされている検索にも中止を受け付ける (@codex #357 P2)", () => {
    // 有料取得の待ち行列に入った検索は、順番が来るまで更新が起きない。実況
    // エントリは3分で消えるので、「実況があるか」で受け付けを判断すると
    // **待たされている検索ほど中止できない**（押しても accepted:false）。
    // 実行の生死は実況と切り離して持つ。
    const store = read("src/lib/registry-fetch/live-view-store.ts");
    expect(store).toMatch(/const activeOps = new Set<string>\(\)/);
    expect(store).toMatch(/if \(!activeOps\.has\(k\)\) return false/);
    // 開始で登録し、終了で必ず外す（外し忘れると永久に実行中に見える）
    expect(store).toMatch(/activeOps\.add\(k\)/);
    expect(store).toMatch(/activeOps\.delete\(k\)/);
  });

  it("⚠受け付けた中止を件数上限で捨てない (@codex #357 P2)", () => {
    // 上限で古い印を追い出すと、その検索がまだ待ち行列に居た場合に
    // **「中止しました」と言ったのに動き出す**。印が付くのは実行中の検索
    // だけなので、同時実行数以上には増えず上限は要らない。
    const store = read("src/lib/registry-fetch/live-view-store.ts");
    expect(store).not.toMatch(/CANCEL_MARKS_MAX/);
    expect(store).not.toMatch(/cancelMarks\.keys\(\)/);
  });

  it("⚠印の寿命を時間で見積もらない (@codex #357 P2)", () => {
    // 待ち行列は本数に上限が無く、2本詰まれば20分。**何分にしても足りない
    // 場合がある**ので、期限はどれだけ長くても「実行中なのに消える」窓になる。
    // 片付けは「その検索が終わったとき」= route の finally。
    const store = read("src/lib/registry-fetch/live-view-store.ts");
    expect(store).toMatch(/export function clearLiveViewCancel/);
    expect(store).not.toMatch(/CANCEL_MARK_TTL_MS/);
    expect(
      read("src/app/api/properties/[id]/registry/search/route.ts"),
    ).toMatch(/clearLiveViewCancel\(session\.id, id, liveRef\)/);
  });

  it("⚠印に秘匿情報を持たせない", () => {
    // 保持するのは**鍵だけ**。所在・スクショ・時刻すら持たない。
    expect(read("src/lib/registry-fetch/live-view-store.ts")).toMatch(
      /const cancelMarks = new Set<string>\(\)/,
    );
  });

  it("⚠自分で押した中止を赤いエラーとして出さない (@codex #357 P2)", () => {
    // 中止は 409 で返るが、通信の失敗と同じ経路を通ると赤いエラー表示になり
    // 「止めたのに何か問題が起きた」と誤解させる（課金が無いことも伝わらない）。
    // server は中止専用の分類を返し、client はそれを見て通常の案内として出す。
    expect(read("src/lib/registry-fetch/search.ts")).toMatch(
      /err\.code === "cancelled"\s*\n?\s*\? "REGISTRY_SEARCH_CANCELLED"/,
    );
    // ⚠分類コードが画面まで届かないと区別しようがない（文言一致は脆い）
    const client = read("src/lib/api-client.ts");
    expect(client).toMatch(/export function apiErrorCode/);
    expect(client).toMatch(/code: typeof body\?\.error\?\.code === "string"/);
    // 非2xx を Error にする箇所が分散すると片方だけ直る → 1か所に集約する
    expect(client).not.toMatch(
      /throw new Error\(body\?\.error\?\.message \?\? `Error: \$\{res\.status\}`\)/,
    );
    const ui = read("src/components/properties/registry-location-search-button.tsx");
    expect(ui).toMatch(/apiErrorCode\(e\) === "REGISTRY_SEARCH_CANCELLED"/);
    expect(ui).toMatch(/setState\("cancelled"\)/);
    // 中止の表示は alert ではなく status（赤字の警告にしない）
    expect(ui).toMatch(/state === "cancelled" &&[\s\S]{0,400}?role="status"/);
  });

  it("中止は「失敗」ではない分類で返す", () => {
    expect(read("src/lib/registry-fetch/errors.ts")).toMatch(
      /cancelled: "取得を中止しました。課金は発生していません。"/,
    );
    // 5xx（サーバー障害）にしない
    expect(read("src/lib/registry-fetch/search.ts")).toMatch(/cancelled: 409/);
  });
});
