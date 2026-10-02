/**
 * 通知 段階2の画面側の結線(設計書 §5.2)。クリックや時間経過の単体テストができない(node 環境)ため、
 * 守りの形をソースで固定する。判断そのものは `lib/notifications/__tests__/summary-state.test.ts`。
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearNoticeStorage, SUMMARY_STATE_PREFIX } from "@/lib/notifications/notice-store";
import { summaryStateKey } from "../summary-poller";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const poller = read("src/components/notifications/summary-poller.tsx");

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("件数の取りに行き方", () => {
  it("ログイン後の画面だけ(NoticeProvider の中)に置く", () => {
    const layout = read("src/app/(dashboard)/layout.tsx");
    const a = layout.indexOf("<NoticeProvider>");
    const b = layout.indexOf("<SummaryPoller />");
    const c = layout.indexOf("</NoticeProvider>");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
  it("見えているタブは60秒・見えないタブは5分・見える状態に戻ったらすぐ", () => {
    expect(poller).toContain("SUMMARY_VISIBLE_INTERVAL_MS = 60_000");
    expect(poller).toContain("SUMMARY_HIDDEN_INTERVAL_MS = 5 * 60_000");
    expect(poller).toMatch(/visibilityState === "visible"\) \{\s*if \(timer\) clearTimeout\(timer\);\s*void tick\(\);/);
  });
  it("取りに行くことでセッションを延ばさない(update・/api/auth/session を呼ばない)", () => {
    expect(poller).not.toMatch(/\bupdate\(/);
    expect(poller).not.toContain("/api/auth/session");
  });
  it("判断と保存はベルと同じ Web Locks の中で、後片付けの合図を読み直してから", () => {
    expect(poller).toMatch(/withNoticeLock\(\(\) => \{\s*\/\/[^\n]*\n\s*if \(stopped \|\| switched\(\)\) return;\s*const \{ state, notices \} = decideSummaryNotices/);
  });
  it("400(カーソルが読めない)は、読めなかった区分のカーソルだけを捨てる(エラーコードを渡す)", () => {
    expect(poller).toMatch(/res\.status === 400[\s\S]{0,500}resetCursors\(loadState\(userId\), code\)/);
  });
  it("知らせはベル・見えないときは OS の通知・見えているときは右下のポップアップ", () => {
    expect(poller).toContain("osWhenHidden: true");
    expect(poller).toMatch(/document\.visibilityState === "visible"\) \{\s*toast\(/);
  });
});

describe("共用 PC: 後片付けで段階2の保存値も消す", () => {
  it("保存先は利用者 ID ごと・頭は共通", () => {
    expect(summaryStateKey("u1")).toBe(`${SUMMARY_STATE_PREFIX}v1:u1`);
  });
  it("clearNoticeStorage がどの利用者の分も消す(ほかの値は消さない)", () => {
    const stored = new Map<string, string>([
      [summaryStateKey("u1"), "{}"],
      [summaryStateKey("u2"), "{}"],
      ["other-app-key", "keep"],
    ]);
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        get length() {
          return stored.size;
        },
        key: (i: number) => [...stored.keys()][i] ?? null,
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => void stored.set(k, v),
        removeItem: (k: string) => void stored.delete(k),
      },
      dispatchEvent: () => true,
    };
    clearNoticeStorage();
    expect([...stored.keys()].filter((k) => k.startsWith(SUMMARY_STATE_PREFIX))).toEqual([]);
    expect(stored.get("other-app-key")).toBe("keep");
  });
});

describe("保存できない環境(private mode・容量超過)", () => {
  it("この画面の間は控えから読み直す(見た印・カーソルが消えて毎分出直さない)・後片付けで控えも消す", async () => {
    const { readSummaryRaw, writeSummaryRaw } = await import("@/lib/notifications/notice-store");
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        length: 0,
        key: () => null,
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceeded");
        },
        removeItem: () => {},
      },
      dispatchEvent: () => true,
    };
    const k = summaryStateKey("u1");
    writeSummaryRaw(k, '{"v":1}');
    expect(readSummaryRaw(k)).toBe('{"v":1}');
    clearNoticeStorage();
    expect(readSummaryRaw(k)).toBeNull();
  });
});
