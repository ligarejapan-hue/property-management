import { describe, it, expect } from "vitest";
import { displayTitle, groupAttachmentsByStage, needsKindCheck } from "../doc-folders";

const a = (id: string, over: Record<string, unknown> = {}) => ({ id, fileName: `${id}.pdf`, mimeType: "application/pdf", ...over });

describe("groupAttachmentsByStage", () => {
  it("①②③④その他 の順に、段階なしは その他 へ", () => {
    const folders = groupAttachmentsByStage([
      a("x", { docStage: "settlement" }),
      a("y", { docStage: null }),
      a("z", { docStage: "contract" }),
      a("w", { docStage: "unknown_stage" }),
    ]);
    expect(folders.map((f) => f.code)).toEqual(["pre_contract", "contract", "settlement", "identity", "other"]);
    expect(folders.map((f) => f.items.map((i) => i.id))).toEqual([[], ["z"], ["x"], [], ["y", "w"]]);
    expect(folders[0].short).toBe("①");
    expect(folders[4].label).toBe("その他");
  });
  it("空でも5つのフォルダを返す", () => {
    expect(groupAttachmentsByStage([]).length).toBe(5);
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
