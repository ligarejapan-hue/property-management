import { describe, it, expect } from "vitest";
import { parseRegistryText } from "@/lib/pdf-registry-parser";

/**
 * 家屋番号の読み取り。区分建物の全部事項は、一棟の建物の「専有部分の家屋番号」（全部屋の範囲）が
 * 先に来るので、それを家屋番号にしない。表の並びは実物（2026-10 区分建物の全部事項）に合わせた架空のもの。
 */
const KUBUN = [
  "┏━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
  "┃専有部分の家屋番号│１－１－１ ～ １－１－４３ ┃",
  "┃ 表 題 部 （一棟の建物の表示） │調製│平成７年１１月２２日 │所在図番号│ ┃",
  "┃所 在│世田谷区架空一丁目 １番地１ │ ┃",
  "┃ 表 題 部 （専有部分の建物の表示） │不動産番号│０１００００００００００１┃",
  "┃家屋番号 │架空一丁目 １番１の３８ │ ┃",
  "┃建物の名称│３０５ │ ┃",
].join("\n");

describe("parseRegistryText: 家屋番号", () => {
  it("区分建物: 専有部分の家屋番号（範囲）ではなく、その部屋の家屋番号を読む", () => {
    expect(parseRegistryText(KUBUN).buildingNumber).toBe("架空一丁目 １番１の３８");
  });

  it("戸建て: 家屋番号が1つなら従来どおり読む", () => {
    const text = ["┃所 在│世田谷区架空二丁目 ２番地２ │ ┃", "┃家屋番号 │２番２ │ ┃", "┃① 種 類│ ② 構 造 │"].join("\n");
    expect(parseRegistryText(text).buildingNumber).toBe("２番２");
  });

  it("家屋番号が範囲しか無ければ空にする（範囲を家屋番号にしない）", () => {
    const text = "┃専有部分の家屋番号│１－１－１ ～ １－１－４３ ┃";
    expect(parseRegistryText(text).buildingNumber).toBeNull();
  });
});

describe("parseRegistryText: 家屋番号の外字", () => {
  it("欄の空白として出る外字（私用領域の文字）を家屋番号に含めない", () => {
    const text = "┃家屋番号 │２番２  │ ┃";
    expect(parseRegistryText(text).buildingNumber).toBe("２番２");
  });
});
