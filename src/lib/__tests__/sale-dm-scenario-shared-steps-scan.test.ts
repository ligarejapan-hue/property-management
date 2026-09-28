/**
 * 「DMの種類」の共通手順(設計 2026-09-27 §3.3.0)を、宛先に種類を付ける全経路が必ず呼ぶことの走査。
 * 片方の経路だけ守り(準備の検査・写す・付けて差し込む・組の検査)が漏れる事故を防ぐ。
 * 「種類を変える」の route(Task 5)ができたら ROUTES に足す。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const ROUTES = [
  "src/app/api/properties/sale-dm/campaigns/route.ts", // 発送の作成(§3.3)
];

const REQUIRED_CALLS = [
  "checkScenarioReady(",
  "copyScenarioIntoCampaign(",
  "attachScenario(",
  "isValidScenarioPair(",
];

describe("種類を宛先に付ける経路は共通手順を必ず呼ぶ", () => {
  for (const route of ROUTES) {
    it(route, () => {
      const src = read(route);
      for (const call of REQUIRED_CALLS) {
        expect(src.includes(call), `${route} が ${call} を呼んでいない`).toBe(true);
      }
      // 差し込みを経路の中で直に書かない(共通の attachScenario を通す)。
      expect(src.includes("expandDraftBody("), `${route} が expandDraftBody を直に呼んでいる`).toBe(false);
    });
  }
});
