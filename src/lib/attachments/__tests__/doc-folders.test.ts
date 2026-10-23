import { describe, it, expect } from "vitest";
import { displayTitle, groupAttachmentsByStage, needsKindCheck, visibleFolders } from "../doc-folders";

const a = (id: string, over: Record<string, unknown> = {}) => ({ id, fileName: `${id}.pdf`, mimeType: "application/pdf", ...over });

describe("groupAttachmentsByStage", () => {
  it("①②③④⑤ 本人確認 その他 の順に、段階なしは その他 へ", () => {
    const folders = groupAttachmentsByStage([
      a("x", { docStage: "settlement" }),
      a("y", { docStage: null }),
      a("z", { docStage: "contract" }),
      a("w", { docStage: "unknown_stage" }),
      a("r", { docStage: "rental" }),
    ]);
    expect(folders.map((f) => f.code)).toEqual(["pre_contract", "management", "contract", "settlement", "rental", "identity", "other"]);
    expect(folders.map((f) => f.items.map((i) => i.id))).toEqual([[], [], ["z"], ["x"], ["r"], [], ["y", "w"]]);
    expect(folders[0].short).toBe("①");
    expect(folders[0].label).toBe("調査資料等");
    expect(folders[5].short).toBe("");
    expect(folders[6].label).toBe("その他");
  });
  it("種類があれば種類の表の段階を使う(保存済みの段階が古くても正しいフォルダ)", () => {
    const folders = groupAttachmentsByStage([a("m", { docKind: "mgmt_report", docStage: "pre_contract" })]);
    expect(folders.find((f) => f.code === "management")?.items.map((i) => i.id)).toEqual(["m"]);
    expect(folders.find((f) => f.code === "pre_contract")?.items).toEqual([]);
  });
  it("空でも7つのフォルダを返す", () => {
    expect(groupAttachmentsByStage([]).length).toBe(7);
  });
});

describe("visibleFolders", () => {
  it("賃貸中なら ⑤賃貸関係 を空でも出す", () => {
    const v = visibleFolders(groupAttachmentsByStage([]), { occupancyStatus: "rented" });
    expect(v.map((f) => f.code)).toContain("rental");
  });
  it("賃貸中でなければ、空の ⑤賃貸関係 は出さない(ほかは出す)", () => {
    const v = visibleFolders(groupAttachmentsByStage([]), { occupancyStatus: "vacant" });
    expect(v.map((f) => f.code)).toEqual(["pre_contract", "management", "contract", "settlement", "identity", "other"]);
    expect(visibleFolders(groupAttachmentsByStage([]), { occupancyStatus: null }).map((f) => f.code)).not.toContain("rental");
  });
  it("賃貸中でなくても、賃貸関係の書類があれば出す", () => {
    const v = visibleFolders(groupAttachmentsByStage([a("r", { docStage: "rental" })]), { occupancyStatus: "occupied" });
    expect(v.map((f) => f.code)).toContain("rental");
  });
});

describe("displayTitle", () => {
  it("そろえた名前があればそれ、無ければ元の名前", () => {
    expect(displayTitle({ fileName: "a.pdf", docTitle: "売買契約書_X_20261023.pdf" })).toBe("売買契約書_X_20261023.pdf");
    expect(displayTitle({ fileName: "a.pdf", docTitle: null })).toBe("a.pdf");
    expect(displayTitle({ fileName: "a.pdf", docTitle: "" })).toBe("a.pdf");
  });
});

describe("needsKindCheck", () => {
  it("low は確認・high/manual は不要", () => {
    expect(needsKindCheck({ mimeType: "application/pdf", docKind: "x", docConfidence: "low" })).toBe(true);
    expect(needsKindCheck({ mimeType: "application/pdf", docKind: "x", docConfidence: "high" })).toBe(false);
    expect(needsKindCheck({ mimeType: "application/pdf", docKind: "x", docConfidence: "manual" })).toBe(false);
  });
  it("種類なしの文書は確認・画像は出さない", () => {
    expect(needsKindCheck({ mimeType: "application/pdf", docKind: null, docConfidence: null })).toBe(true);
    expect(needsKindCheck({ mimeType: "image/jpeg", docKind: null, docConfidence: null })).toBe(false);
  });
});
