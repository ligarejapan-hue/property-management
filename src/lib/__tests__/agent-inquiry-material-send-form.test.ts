import { describe, it, expect } from "vitest";
import { materialFormState, type MaterialFormFile } from "@/lib/agent-inquiry/material-send-form";

const MB = 1024 * 1024;
const WARN = "所有者の名前・住所が載っています。送ってよい相手か確かめてください";
const files: MaterialFormFile[] = [
  { id: "a1", fileSize: 2 * MB, warning: null },
  { id: "a2", fileSize: 1 * MB, warning: WARN },
  { id: "a3", fileSize: 18 * MB + 1, warning: null },
];
const base = {
  files,
  picked: ["a1"],
  to: "sato@agent.jp",
  subject: "件名",
  body: "本文",
  mailConfigured: true,
  maxTotalBytes: 20 * MB,
  maxFiles: 20,
  busy: false,
};

describe("資料を送る小窓の状態(純関数)", () => {
  it("ふつうは送れる・合計を出す", () => {
    expect(materialFormState(base)).toMatchObject({ canSend: true, total: 2 * MB, tooLarge: false, warnings: [] });
  });
  it("1つも選ばないと送れない", () => expect(materialFormState({ ...base, picked: [] }).canSend).toBe(false));
  it("謄本を選ぶと注意が出る(同じ注意は1回)", () => {
    expect(materialFormState({ ...base, picked: ["a1", "a2"] }).warnings).toEqual([WARN]);
  });
  it("20MB を超えると送れない", () => {
    const s = materialFormState({ ...base, picked: ["a1", "a3"] });
    expect(s.tooLarge).toBe(true);
    expect(s.canSend).toBe(false);
  });
  it("上限のファイル数を超えると送れない", () => {
    const s = materialFormState({ ...base, picked: ["a1", "a2"], maxFiles: 1 });
    expect(s.tooMany).toBe(true);
    expect(s.canSend).toBe(false);
  });
  it.each([
    ["宛先が2件", { to: "a@x.jp, b@y.jp" }],
    ["宛先が空", { to: "" }],
    ["件名が空", { subject: "  " }],
    ["本文が空", { body: "\n" }],
    ["メール設定が無い", { mailConfigured: false }],
    ["送信中", { busy: true }],
  ])("%s なら送れない", (_n, o) => expect(materialFormState({ ...base, ...o }).canSend).toBe(false));
  it("宛先の前後の空白は許す", () => expect(materialFormState({ ...base, to: " sato@agent.jp " }).canSend).toBe(true));
  it("一覧に無い ID(消えた)は数えない", () => {
    expect(materialFormState({ ...base, picked: ["a1", "gone"] })).toMatchObject({ total: 2 * MB, chosenCount: 1 });
  });
});
