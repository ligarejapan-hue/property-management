/**
 * 実況パネルの配線検証。
 *
 * 1. provider (OfficialRegistryProvider.searchCandidates): 起動/ログインの
 *    ステップを固定文言 + 画像なしで通知し (ログイン画面は撮影省略)、live を
 *    adapter の searchByLocation へ引き渡す。
 * 2. adapter (auto-fetch.ts searchByLocation): ソース静的検証 — ステップ毎に
 *    reportLive を呼び、page.screenshot は optional chain + timeout 付き +
 *    失敗握り潰し (実況が検索本体を壊さない)。
 * 3. search.ts: args.live を provider request へ引き渡す。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { OfficialRegistryProvider } from "../official-provider";
import type {
  RegistryBrowserPage,
  RegistryLoginInput,
} from "../official-provider";
import type { RegistryCandidate, RegistryLiveReporter } from "../types";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

function makeReporter(): RegistryLiveReporter & {
  events: Array<{ label: string; hasShot: boolean }>;
} {
  const events: Array<{ label: string; hasShot: boolean }> = [];
  return {
    events,
    step(label) {
      events.push({ label, hasShot: false });
      return events.length - 1;
    },
    attachShot(seq) {
      if (events[seq]) events[seq].hasShot = true;
    },
  };
}

describe("provider — 実況ステップの通知と live の引き渡し", () => {
  it("起動/ログインを文言のみで通知し、searchByLocation に live を渡す", async () => {
    const reporter = makeReporter();
    let receivedLive: RegistryLiveReporter | undefined;
    const page: RegistryBrowserPage = {
      async login(_input: RegistryLoginInput) {},
      async searchByRealEstateNumber() {
        return { found: true };
      },
      async downloadRegistryPdf() {
        return Buffer.from("%PDF-1.4");
      },
      async close() {},
      async searchByLocation(input) {
        receivedLive = input.live;
        // adapter 相当のステップ通知 + fire-and-forget 撮影の後付けを模擬
        const seq = input.live?.step("所在と地番・家屋番号を入力しました");
        if (typeof seq === "number" && seq >= 0) {
          input.live?.attachShot(seq, new Uint8Array(4));
        }
        return [{ candidateRef: "c1" }] as RegistryCandidate[];
      },
    };
    const provider = new OfficialRegistryProvider({
      loginId: "id",
      password: "pw",
      browserFactory: async () => page,
      supportsLocationSearch: true,
    });
    const result = await provider.searchCandidates({
      address: "東京都テスト区1",
      live: reporter,
    });
    expect(result).toEqual([{ candidateRef: "c1" }]);
    expect(receivedLive).toBe(reporter);
    // 起動 → ログイン (撮影省略の明示文言・画像なし) → adapter ステップ
    expect(reporter.events.map((e) => e.label)).toEqual([
      "自動操作ブラウザを起動しています…",
      "登記情報提供サービスへログインしています…(この画面の表示は省略されます)",
      "所在と地番・家屋番号を入力しました",
    ]);
    expect(reporter.events[0].hasShot).toBe(false);
    expect(reporter.events[1].hasShot).toBe(false);
    expect(reporter.events[2].hasShot).toBe(true);
  });

  it("live 未指定でも従来どおり動く (実況は完全に任意)", async () => {
    const page: RegistryBrowserPage = {
      async login() {},
      async searchByRealEstateNumber() {
        return { found: true };
      },
      async downloadRegistryPdf() {
        return Buffer.from("%PDF-1.4");
      },
      async close() {},
      async searchByLocation() {
        return [{ candidateRef: "c1" }] as RegistryCandidate[];
      },
    };
    const provider = new OfficialRegistryProvider({
      loginId: "id",
      password: "pw",
      browserFactory: async () => page,
      supportsLocationSearch: true,
    });
    await expect(
      provider.searchCandidates({ address: "東京都テスト区1" }),
    ).resolves.toEqual([{ candidateRef: "c1" }]);
  });
});

describe("adapter — searchByLocation の実況 (ソース静的検証)", () => {
  const SRC = readSrc("src/lib/registry-fetch/auto-fetch.ts");
  const searchByLocationBlock =
    SRC.match(/async searchByLocation\(input\) \{[\s\S]*?\n    \},/)?.[0] ?? "";

  it("reportLive は step を即時通知し、撮影は fire-and-forget で後付けする (@codex R6)", () => {
    // 撮影の await を検索本体のチェーンに乗せない (本体の timeout 予算を
    // 消費しない)。step は同期通知・撮影は void (async)() で分離。
    expect(searchByLocationBlock).toMatch(/const reportLive = \(label: string\): void =>/);
    expect(searchByLocationBlock).toMatch(/void \(async \(\) => \{/);
    expect(searchByLocationBlock).not.toMatch(/await reportLive\(/);
    // 1 枚あたり timeout は累計予算との min + 同時 1 枚 + 累計予算で有界
    expect(searchByLocationBlock).toMatch(
      /timeout: Math\.min\(LIVE_SCREENSHOT_TIMEOUT_MS, liveShotBudgetMs\)/,
    );
    expect(searchByLocationBlock).toMatch(
      /let liveShotBudgetMs = LIVE_SCREENSHOT_TOTAL_BUDGET_MS/,
    );
    expect(searchByLocationBlock).toMatch(/liveShotInFlight/);
    expect(searchByLocationBlock).toMatch(
      /liveShotBudgetMs -= Date\.now\(\) - startedAt/,
    );
    // step 通知は try/catch + 後付けは attachShot (実況が検索を壊さない)
    expect(searchByLocationBlock).toMatch(/seq = live\.step\(label\)/);
    expect(searchByLocationBlock).toMatch(/live\.attachShot\(/);
  });

  it("主要ステップで reportLive を呼ぶ (メニュー移動/入力/検索実行/ページ読取/完了)", () => {
    for (const label of [
      "不動産請求メニューへ移動します",
      "所在と地番・家屋番号を入力しました",
      "地番検索を実行しています…",
      "候補一覧を読み取っています",
      "候補の読み取りが完了しました",
    ]) {
      expect(searchByLocationBlock).toContain(label);
    }
  });

  it("label に秘匿情報 (input の値) を埋め込まない (固定文言 + 件数/ページ数のみ)", () => {
    // reportLive 呼び出しのテンプレートに input.address / searchKey 等を入れない
    const calls = searchByLocationBlock.match(/reportLive\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) {
      expect(c).not.toMatch(/input\./);
      expect(c).not.toMatch(/searchKey/);
      expect(c).not.toMatch(/address/);
    }
  });

  it("login メソッド内では撮影しない (ログイン画面の省略は provider 側の文言のみ)", () => {
    const loginBlock = SRC.match(/async login\(input\) \{[\s\S]*?\n    \},/)?.[0] ?? "";
    expect(loginBlock).not.toBe("");
    expect(loginBlock).not.toMatch(/screenshot/);
    expect(loginBlock).not.toMatch(/reportLive/);
  });
});

describe("search.ts — live の引き渡し (ソース静的検証)", () => {
  it("args.live を provider request に接続する (認可・確認通過後)", () => {
    const SRC = readSrc("src/lib/registry-fetch/search.ts");
    expect(SRC).toMatch(
      /args\.live \? \{ \.\.\.built\.request, live: args\.live \} : built\.request/,
    );
  });
});
