import { describe, it, expect } from "vitest";
import {
  parseRegistryPdfBulkFilename,
  inferRegistryCertificateType,
} from "../filename";

describe("inferRegistryCertificateType(謄本の種別をファイル名から判定)", () => {
  it("所有者事項 → owner", () => {
    expect(
      inferRegistryCertificateType(
        "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
      ),
    ).toBe("owner");
    expect(inferRegistryCertificateType("○○（土地所有者事項）1234567890.pdf")).toBe(
      "owner",
    );
  });

  it("全部事項 → all", () => {
    expect(
      inferRegistryCertificateType("世田谷区上馬２丁目全部事項証明書.pdf"),
    ).toBe("all");
  });

  it("判定できない/空/null → null(=その他扱い)", () => {
    expect(inferRegistryCertificateType("registry.pdf")).toBeNull();
    expect(inferRegistryCertificateType("")).toBeNull();
    expect(inferRegistryCertificateType(null)).toBeNull();
    expect(inferRegistryCertificateType(undefined)).toBeNull();
  });

  it("NFD分解でも NFC 正規化して判定する", () => {
    const nfd = "建物所有者事項".normalize("NFD");
    expect(inferRegistryCertificateType(`x（${nfd}）1234567890.pdf`)).toBe("owner");
  });
});

describe("parseRegistryPdfBulkFilename", () => {
  it("建物所有者事項のファイル名を分解できる", () => {
    const r = parseRegistryPdfBulkFilename(
      "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
    );
    expect(r).toEqual({
      location: "世田谷区上馬２丁目７５２－３",
      kind: "建物",
      requestNumber: "2024121200118150",
    });
  });

  it("土地所有者事項のファイル名を分解できる", () => {
    const r = parseRegistryPdfBulkFilename(
      "世田谷区弦巻１丁目３２－３１不動産登記（土地所有者事項）2024121100710215.pdf",
    );
    expect(r?.kind).toBe("土地");
    expect(r?.location).toBe("世田谷区弦巻１丁目３２－３１");
    expect(r?.requestNumber).toBe("2024121100710215");
  });

  it("区分建物(部屋番号付き所在)も location として取れる", () => {
    const r = parseRegistryPdfBulkFilename(
      "世田谷区千歳台６丁目１－７－Ｂ－１３０７不動産登記（建物所有者事項）2024121200071363.PDF",
    );
    expect(r?.location).toBe("世田谷区千歳台６丁目１－７－Ｂ－１３０７");
  });

  it("コピーで付く ' (1)' サフィックスを許容する", () => {
    const r = parseRegistryPdfBulkFilename(
      "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150 (1).pdf",
    );
    expect(r?.requestNumber).toBe("2024121200118150");
  });

  it("パターン外・null・空は null を返す", () => {
    expect(parseRegistryPdfBulkFilename("registry.pdf")).toBeNull();
    expect(parseRegistryPdfBulkFilename("所有者一覧.xlsx")).toBeNull();
    expect(parseRegistryPdfBulkFilename(null)).toBeNull();
    expect(parseRegistryPdfBulkFilename("")).toBeNull();
    // location が空になるものは null
    expect(
      parseRegistryPdfBulkFilename(
        "不動産登記（建物所有者事項）2024121200118150.pdf",
      ),
    ).toBeNull();
  });
});
