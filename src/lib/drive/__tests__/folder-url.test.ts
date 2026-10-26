import { describe, expect, it } from "vitest";
import { folderIdFromUrl } from "../folder-url";

const ID = "1AbC_dEf-GhIjKlMnOpQrStUvWxYz0123";

describe("folderIdFromUrl(ドライブのフォルダの URL から番号を取り出す)", () => {
  it.each([
    [`https://drive.google.com/drive/folders/${ID}`],
    [`https://drive.google.com/drive/folders/${ID}?usp=sharing`],
    [`https://drive.google.com/drive/u/0/folders/${ID}`],
    [`https://drive.google.com/drive/u/1/folders/${ID}?resourcekey=0-abc`],
    [`https://drive.google.com/open?id=${ID}`],
    [`drive.google.com/drive/folders/${ID}`],
    [`  https://drive.google.com/drive/folders/${ID}  `],
  ])("%s", (url) => {
    expect(folderIdFromUrl(url)).toBe(ID);
  });

  it("共有ドライブの入口(0A で始まる短い番号)も取り出す", () => {
    expect(folderIdFromUrl("https://drive.google.com/drive/folders/0AbCdEfGhIjKlUk9PVA")).toBe("0AbCdEfGhIjKlUk9PVA");
  });

  it("番号だけを貼ってもよい", () => {
    expect(folderIdFromUrl(ID)).toBe(ID);
  });

  it("ファイルの URL・ドキュメントの URL はフォルダではないので null", () => {
    expect(folderIdFromUrl(`https://drive.google.com/file/d/${ID}/view`)).toBeNull();
    expect(folderIdFromUrl(`https://docs.google.com/document/d/${ID}/edit`)).toBeNull();
  });

  it("ドライブ以外のサイト・形の違うものは null", () => {
    expect(folderIdFromUrl(`https://example.com/drive/folders/${ID}`)).toBeNull();
    expect(folderIdFromUrl("https://drive.google.com/drive/my-drive")).toBeNull();
    expect(folderIdFromUrl("")).toBeNull();
    expect(folderIdFromUrl("物件フォルダ")).toBeNull();
    expect(folderIdFromUrl("abc")).toBeNull();
  });
});
