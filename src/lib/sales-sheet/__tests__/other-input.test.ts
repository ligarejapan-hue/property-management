import { describe, it, expect } from "vitest";
import {
  OTHER_OPTION, hasOtherOption, selectOtherState, multiOtherState, setMultiFreeText,
} from "../other-input";

const OPTS = ["宅地", "田", "その他"] as const;

describe("other-input", () => {
  it("hasOtherOption", () => {
    expect(hasOtherOption(OPTS)).toBe(true);
    expect(hasOtherOption(["宅地"])).toBe(false);
  });
  describe("select", () => {
    it("options内=通常", () => { expect(selectOtherState("宅地", OPTS)).toEqual({ isOther: false, freeText: "" }); });
    it("その他リテラル=モード・テキスト空", () => { expect(selectOtherState("その他", OPTS)).toEqual({ isOther: true, freeText: "" }); });
    it("options外の非空=その他・テキスト有", () => { expect(selectOtherState("原野", OPTS)).toEqual({ isOther: true, freeText: "原野" }); });
    it("空=通常", () => { expect(selectOtherState("", OPTS)).toEqual({ isOther: false, freeText: "" }); });
  });
  describe("multiselect", () => {
    it("options外要素=自由入力値・その他モード", () => {
      expect(multiOtherState(["宅地", "原野"], OPTS)).toEqual({ isOther: true, freeText: "原野", optionSelections: ["宅地"] });
    });
    it("その他リテラル=モード・テキスト空", () => {
      expect(multiOtherState(["宅地", "その他"], OPTS)).toEqual({ isOther: true, freeText: "", optionSelections: ["宅地"] });
    });
    it("その他なし=通常", () => {
      expect(multiOtherState(["宅地", "田"], OPTS)).toEqual({ isOther: false, freeText: "", optionSelections: ["宅地", "田"] });
    });
    it("setMultiFreeText: テキスト有→options選択＋テキスト", () => {
      expect(setMultiFreeText(["宅地", "その他"], OPTS, "原野")).toEqual(["宅地", "原野"]);
    });
    it("setMultiFreeText: 空→その他リテラルへ戻す", () => {
      expect(setMultiFreeText(["宅地", "原野"], OPTS, "")).toEqual(["宅地", "その他"]);
    });
  });
});
