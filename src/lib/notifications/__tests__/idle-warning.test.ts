/**
 * 自動ログオフの予告(N3・通知 段階1・設計書 §4.3)。
 */
import { describe, expect, it } from "vitest";
import { IDLE_TIMEOUT_MS } from "@/lib/idle-timeout";
import { IDLE_LOGOUT_CALLBACK_URL, IDLE_LOGOUT_WARN_MS, formatRemaining, idlePhase } from "../idle-warning";

describe("idlePhase", () => {
  it("55分で予告、60分でログアウト(60分の規則は変えない)", () => {
    expect(IDLE_LOGOUT_WARN_MS).toBe(55 * 60 * 1000);
    expect(idlePhase(IDLE_LOGOUT_WARN_MS - 1)).toBe("active");
    expect(idlePhase(IDLE_LOGOUT_WARN_MS)).toBe("warn");
    expect(idlePhase(IDLE_TIMEOUT_MS - 1)).toBe("warn");
    expect(idlePhase(IDLE_TIMEOUT_MS)).toBe("logout");
  });
});

describe("formatRemaining", () => {
  it("残り時間を分と秒で出す(負は0秒)", () => {
    expect(formatRemaining(5 * 60 * 1000)).toBe("5分0秒");
    expect(formatRemaining(299_001)).toBe("5分0秒");
    expect(formatRemaining(299_000)).toBe("4分59秒");
    expect(formatRemaining(59_000)).toBe("59秒");
    expect(formatRemaining(-1)).toBe("0秒");
  });
});

it("無操作でのログアウトはログイン画面に理由を出す", () => {
  expect(IDLE_LOGOUT_CALLBACK_URL).toBe("/login?reason=idle");
});
