import { describe, expect, it } from "vitest";
import { dropRowName, inboxErrorMessage, inboxSizeError } from "../rows";

describe("dropRowName", () => {
  it("⚠PDF は名前を出さず何件目かだけ(謄本は所有者名を含み得る)", () => {
    expect(dropRowName({ name: "山田太郎_謄本.pdf", type: "application/pdf" }, 2)).toBe("3件目のPDF");
  });

  it("ほかはファイル名のまま", () => {
    expect(dropRowName({ name: "受付帳_10月.csv", type: "text/csv" }, 0)).toBe("受付帳_10月.csv");
  });
});

describe("inboxSizeError", () => {
  it("PDF は 50MB・ほかは 20MB まで", () => {
    expect(inboxSizeError({ name: "a.pdf", type: "", size: 30 * 1024 * 1024 })).toBeNull();
    expect(inboxSizeError({ name: "a.pdf", type: "", size: 51 * 1024 * 1024 })).toBe("大きすぎます(50MBまで)");
    expect(inboxSizeError({ name: "a.docx", type: "", size: 21 * 1024 * 1024 })).toBe("大きすぎます(20MBまで)");
    expect(inboxSizeError({ name: "a.docx", type: "", size: 0 })).toBe("空のファイルは入れられません");
  });
});

describe("inboxErrorMessage", () => {
  it("使えない人(403)には決まった案内", () => {
    expect(inboxErrorMessage(Object.assign(new Error("権限がありません"), { status: 403 }))).toBe(
      "この書類は受け取り箱に入れられません(所有者情報をすべて見られる方だけが使えます)",
    );
  });

  it("ほかは理由をそのまま", () => {
    expect(inboxErrorMessage(Object.assign(new Error("大きすぎます"), { status: 422 }))).toBe("大きすぎます");
  });
});
