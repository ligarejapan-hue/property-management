import { describe, expect, it } from "vitest";
import { fileMatchesAccept, pickAcceptedFiles, pickNotice } from "../file-accept";

const f = (name: string, type = "") => ({ name, type });

describe("fileMatchesAccept", () => {
  it("拡張子の指定は大文字小文字を問わず一致する", () => {
    expect(fileMatchesAccept(f("受付帳.XLSX"), ".csv,.tsv,.txt,.xlsx")).toBe(true);
    expect(fileMatchesAccept(f("a.csv", "text/csv"), ".csv,.xlsx")).toBe(true);
    expect(fileMatchesAccept(f("a.pdf", "application/pdf"), ".csv,.xlsx")).toBe(false);
  });

  it("拡張子の無いファイルは拡張子指定に一致しない", () => {
    expect(fileMatchesAccept(f("README"), ".txt")).toBe(false);
  });

  it("image/* は画像の MIME に一致し、PDF には一致しない", () => {
    expect(fileMatchesAccept(f("a.jpg", "image/jpeg"), "image/*")).toBe(true);
    expect(fileMatchesAccept(f("a.pdf", "application/pdf"), "image/*")).toBe(false);
  });

  it("MIME が空で届く HEIC(Windows)は拡張子から画像とみなす", () => {
    expect(fileMatchesAccept(f("IMG_0001.HEIC", ""), "image/*")).toBe(true);
    expect(
      fileMatchesAccept(f("IMG_0001.heic", ""), "image/jpeg,image/png,image/webp,image/heic,image/heif"),
    ).toBe(true);
  });

  it("MIME が空の avif・jfif も拡張子から画像とみなす", () => {
    expect(fileMatchesAccept(f("a.avif", ""), "image/*")).toBe(true);
    expect(fileMatchesAccept(f("a.JFIF", ""), "image/*")).toBe(true);
    expect(fileMatchesAccept(f("a.unknown", ""), "image/*")).toBe(false);
  });

  it("MIME の完全一致と拡張子の混在指定", () => {
    expect(fileMatchesAccept(f("x.pdf", "application/pdf"), "application/pdf")).toBe(true);
    expect(fileMatchesAccept(f("x.pdf", ""), "application/pdf,.pdf")).toBe(true);
    expect(fileMatchesAccept(f("x.png", "image/png"), "application/pdf,.pdf")).toBe(false);
  });

  it("accept が空なら何でも受け付ける", () => {
    expect(fileMatchesAccept(f("x.zip", "application/zip"), "")).toBe(true);
    expect(fileMatchesAccept(f("x.zip"), undefined)).toBe(true);
  });
});

describe("pickAcceptedFiles", () => {
  const files = [f("a.pdf", "application/pdf"), f("b.png", "image/png"), f("c.pdf", "application/pdf")];

  it("複数可の枠は形式の合うものを全部渡す", () => {
    const r = pickAcceptedFiles(files, ".pdf", true);
    expect(r.accepted.map((x) => x.name)).toEqual(["a.pdf", "c.pdf"]);
    expect(r.rejected.map((x) => x.name)).toEqual(["b.png"]);
    expect(r.ignoredExtra).toBe(0);
  });

  it("単一の枠は形式の合う最初の1件だけを渡し、残りの件数を数える", () => {
    const r = pickAcceptedFiles(files, ".pdf", false);
    expect(r.accepted.map((x) => x.name)).toEqual(["a.pdf"]);
    expect(r.ignoredExtra).toBe(1);
  });

  it("形式の合うものが無ければ何も渡さない", () => {
    const r = pickAcceptedFiles([f("b.png", "image/png")], ".pdf", false);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });
});

describe("pickNotice", () => {
  it("除いたものが無ければ null", () => {
    expect(pickNotice(pickAcceptedFiles([f("a.pdf")], ".pdf", true))).toBeNull();
  });

  it("除いたファイル名は3件まで並べ、残りは件数で出す", () => {
    const many = ["1.png", "2.png", "3.png", "4.png", "5.png"].map((n) => f(n, "image/png"));
    const msg = pickNotice(pickAcceptedFiles(many, ".pdf", true));
    expect(msg).toContain("5件を除きました");
    expect(msg).toContain("1.png、2.png、3.png ほか2件");
  });

  it("hideFileNames ならファイル名を一切出さず件数だけ", () => {
    const rejected = pickNotice(
      pickAcceptedFiles([f("山田太郎_謄本.png", "image/png")], ".pdf", true),
      { hideFileNames: true },
    );
    expect(rejected).toContain("1件を除きました");
    expect(rejected).not.toContain("山田太郎");
    const extra = pickNotice(pickAcceptedFiles([f("山田.pdf"), f("佐藤.pdf")], ".pdf", false), {
      hideFileNames: true,
    });
    expect(extra).toContain("最初の1件だけ");
    expect(extra).not.toContain("山田");
  });

  it("単一の枠に複数置かれたら最初の1件だけ使うと伝える", () => {
    const msg = pickNotice(pickAcceptedFiles([f("a.pdf"), f("b.pdf")], ".pdf", false));
    expect(msg).toContain("最初の「a.pdf」だけを使います");
  });
});
