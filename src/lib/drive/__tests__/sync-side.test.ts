/**
 * 物件フォルダの中の「仕入/販売」「購入/売却」(2026-11-21 発注者決定「物件フォルダごとつなぐ」)。
 */
import { describe, it, expect } from "vitest";
import { pickSideFolder, placementForRelPath, sideOfDriveFolderName, type SideContext } from "../sync-plan";

const f = (id: string, name: string) => ({ id, name });
const ctx = (c: Partial<SideContext> = {}) => async (): Promise<SideContext> => ({ resaleOpen: false, brokerageBuyer: false, ...c });

describe("sideOfDriveFolderName(名前がその語だけのときだけ側のフォルダ)", () => {
  it.each([
    ["仕入", "purchase"],
    ["仕入れ", "purchase"],
    ["販売", "sale"],
    ["購入", "buy"],
    ["売却", "sell"],
    [" 売 却 ", "sell"],
    ["売却契約", null],
    ["販売資料", null],
    ["仕入契約書類", null],
    ["〇案件　売却", null],
    ["写真", null],
  ])("%s → %s", (name, want) => {
    expect(sideOfDriveFolderName(name)).toBe(want);
  });
});

describe("placementForRelPath(側のフォルダの中は物件フォルダの直下と同じ)", () => {
  it("側のフォルダの直下=受け取り箱・その中の段階=添付・写真=写真タブ", () => {
    expect(placementForRelPath(["販売"], "application/pdf")).toEqual({ kind: "inbox" });
    expect(placementForRelPath(["仕入", "仕入契約"], "application/pdf")).toEqual({ kind: "attach", stageHint: "contract" });
    expect(placementForRelPath(["販売", "売却決済"], "application/pdf")).toEqual({ kind: "attach", stageHint: "settlement" });
    expect(placementForRelPath(["売却", "写真"], "image/jpeg")).toEqual({ kind: "photo" });
    expect(placementForRelPath(["購入", "契約", "本人確認"], "application/pdf")).toEqual({ kind: "attach", stageHint: "identity" });
  });
  it("側の語を含むだけの段階のフォルダは今までどおり", () => {
    expect(placementForRelPath(["売却契約"], "application/pdf")).toEqual({ kind: "attach", stageHint: "contract" });
    expect(placementForRelPath(["販売資料"], "application/pdf")).toEqual({ kind: "attach", stageHint: null });
  });
});

describe("pickSideFolder(写しを入れる側)", () => {
  it("側のフォルダが無ければ null(取引は見ない)", async () => {
    let asked = false;
    const got = await pickSideFolder([f("a", "契約資料")], async () => {
      asked = true;
      return { resaleOpen: false, brokerageBuyer: false };
    });
    expect(got).toBeNull();
    expect(asked).toBe(false);
  });
  it("片方だけならそれ", async () => {
    expect((await pickSideFolder([f("a", "契約"), f("b", "販売")], ctx()))?.id).toBe("b");
  });
  it("仕入と販売: 仕入の途中なら仕入・そうでなければ販売", async () => {
    const dirs = [f("p", "仕入"), f("s", "販売")];
    expect((await pickSideFolder(dirs, ctx({ resaleOpen: true })))?.id).toBe("p");
    expect((await pickSideFolder(dirs, ctx({ resaleOpen: false })))?.id).toBe("s");
  });
  it("購入と売却: 仲介の買主側なら購入・そうでなければ売却", async () => {
    const dirs = [f("b", "購入"), f("s", "売却")];
    expect((await pickSideFolder(dirs, ctx({ brokerageBuyer: true })))?.id).toBe("b");
    expect((await pickSideFolder(dirs, ctx()))?.id).toBe("s");
  });
  it("組み合わせが違う(仕入と売却)ときは売る側", async () => {
    expect((await pickSideFolder([f("p", "仕入"), f("s", "売却")], ctx({ resaleOpen: true })))?.id).toBe("s");
  });
});
