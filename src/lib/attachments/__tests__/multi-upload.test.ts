import { describe, it, expect } from "vitest";
import { uploadFailureMessage, uploadProgressLabel } from "../multi-upload";

describe("uploadProgressLabel", () => {
  it("複数のときは「N件中M件目」", () => {
    expect(uploadProgressLabel({ current: 2, total: 3 })).toBe("3件中2件目 ");
  });
  it("1件だけ・未送信のときは空", () => {
    expect(uploadProgressLabel({ current: 1, total: 1 })).toBe("");
    expect(uploadProgressLabel(null)).toBe("");
  });
});

describe("uploadFailureMessage", () => {
  const f = { index: 2, fileName: "佐藤様_謄本.pdf", reason: "ファイルサイズが上限 (8MB) を超えています" };

  it("失敗が無ければ null", () => {
    expect(uploadFailureMessage([], 3, { showFileNames: true })).toBeNull();
  });
  it("1件だけ送ったときは、これまでどおり理由だけ", () => {
    expect(uploadFailureMessage([{ ...f, index: 1 }], 1, { showFileNames: true })).toBe(f.reason);
  });
  it("複数のときは失敗した分だけ、ファイル名つきでまとめる", () => {
    expect(uploadFailureMessage([f], 3, { showFileNames: true })).toBe(
      "3件中1件を保存できませんでした（佐藤様_謄本.pdf: ファイルサイズが上限 (8MB) を超えています）",
    );
  });
  it("★謄本ではファイル名を出さず、何件目かだけ(所有者名を出さない)", () => {
    const msg = uploadFailureMessage([f], 3, { showFileNames: false });
    expect(msg).toBe("3件中1件を保存できませんでした（2件目: ファイルサイズが上限 (8MB) を超えています）");
    expect(msg).not.toContain("佐藤");
  });
});
