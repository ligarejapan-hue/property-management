import { describe, it, expect } from "vitest";
import { tableCellStyle } from "../table-cell-style";

describe("tableCellStyle", () => {
  it("未指定は従来どおり(罫線 #cccccc・余白 0.5mm 1mm・背景なし)", () => {
    expect(tableCellStyle({}, 0)).toEqual({ border: "0.2mm solid #cccccc", padding: "0.5mm 1mm", background: null });
  });
  it("borderColor を罫線に使う", () => {
    expect(tableCellStyle({ borderColor: "#999999" }, 0).border).toBe("0.2mm solid #999999");
  });
  it("borderless は罫線を出さない", () => {
    expect(tableCellStyle({ borderless: true }, 0).border).toBeNull();
  });
  it("stripeColor は偶数行(2,4,…行目=index 1,3,…)だけ", () => {
    expect(tableCellStyle({ stripeColor: "#eef2f7" }, 0).background).toBeNull();
    expect(tableCellStyle({ stripeColor: "#eef2f7" }, 1).background).toBe("#eef2f7");
    expect(tableCellStyle({ stripeColor: "#eef2f7" }, 2).background).toBeNull();
  });
  it("cellPaddingMm は上下=値・左右=値×1.2", () => {
    expect(tableCellStyle({ cellPaddingMm: 1.2 }, 0).padding).toBe("1.2mm 1.44mm");
    expect(tableCellStyle({ cellPaddingMm: 0 }, 0).padding).toBe("0mm 0mm");
  });
});
