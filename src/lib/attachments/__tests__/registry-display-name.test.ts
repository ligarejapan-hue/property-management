import { describe, it, expect } from "vitest";
import {
  registryDisplayName,
  isAutoFetchedRegistry,
  registryContentDisposition,
  REGISTRY_ASCII_FALLBACK_NAME,
} from "../registry-display-name";

const JST_NOON = new Date("2026-08-25T03:00:00.000Z"); // JST 12:00

describe("registryDisplayName（謄本の表示名は1本の決まりごとで作る）", () => {
  it("種別と登録日から名前を組み立てる", () => {
    expect(registryDisplayName("owner", JST_NOON)).toBe(
      "謄本(所有者事項)_2026-08-25.pdf",
    );
    expect(registryDisplayName("all", JST_NOON)).toBe(
      "謄本(全部事項)_2026-08-25.pdf",
    );
  });

  it("種別が分からない（手作業で取り込んだ）分は種別なしの謄本", () => {
    expect(registryDisplayName(null, JST_NOON)).toBe("謄本_2026-08-25.pdf");
    expect(registryDisplayName(undefined, JST_NOON)).toBe("謄本_2026-08-25.pdf");
    expect(registryDisplayName("unknown-value", JST_NOON)).toBe(
      "謄本_2026-08-25.pdf",
    );
  });

  it("日付が無い・読めないときは日付を付けない（壊れた名前にしない）", () => {
    expect(registryDisplayName("owner")).toBe("謄本(所有者事項).pdf");
    expect(registryDisplayName("owner", null)).toBe("謄本(所有者事項).pdf");
    expect(registryDisplayName("owner", "")).toBe("謄本(所有者事項).pdf");
    expect(registryDisplayName("owner", "not-a-date")).toBe(
      "謄本(所有者事項).pdf",
    );
    expect(registryDisplayName(null)).toBe("謄本.pdf");
  });

  it("日付は日本時間で数える（UTCの日付境界に引きずられない）", () => {
    // UTC では 2026-08-24、日本時間では 2026-08-25。
    const lateNightJst = new Date("2026-08-24T15:30:00.000Z");
    expect(registryDisplayName("owner", lateNightJst)).toBe(
      "謄本(所有者事項)_2026-08-25.pdf",
    );
    // UTC では 2026-08-25、日本時間でも 2026-08-25（朝）。
    const morningJst = new Date("2026-08-24T23:30:00.000Z");
    expect(registryDisplayName("owner", morningJst)).toBe(
      "謄本(所有者事項)_2026-08-25.pdf",
    );
  });

  it("文字列・数値の日時も同じ結果になる", () => {
    expect(registryDisplayName("owner", JST_NOON.toISOString())).toBe(
      "謄本(所有者事項)_2026-08-25.pdf",
    );
    expect(registryDisplayName("owner", JST_NOON.getTime())).toBe(
      "謄本(所有者事項)_2026-08-25.pdf",
    );
  });

  it("組み立てた名前にファイル名として使えない文字を混ぜない", () => {
    for (const cert of ["owner", "all", null, undefined, "x"]) {
      const name = registryDisplayName(cert, JST_NOON);
      expect(name).not.toMatch(/[\/:*?"<>|]/);
      expect(name.endsWith(".pdf")).toBe(true);
    }
  });
});

describe("isAutoFetchedRegistry（自動取得で入った分だけを見分ける）", () => {
  it("種別が記録されているものだけが自動取得（有料取得の成果物）", () => {
    expect(isAutoFetchedRegistry("owner")).toBe(true);
    expect(isAutoFetchedRegistry("all")).toBe(true);
  });

  it("手作業の取り込みは種別が記録されないので false", () => {
    expect(isAutoFetchedRegistry(null)).toBe(false);
    expect(isAutoFetchedRegistry(undefined)).toBe(false);
    expect(isAutoFetchedRegistry("")).toBe(false);
    expect(isAutoFetchedRegistry("owner ")).toBe(false);
    expect(isAutoFetchedRegistry("ALL")).toBe(false);
  });
});

describe("registryContentDisposition（保存名はサーバーのヘッダが決める）", () => {
  it("ダウンロードのときは日本語名を付け、ASCII のフォールバックも残す", () => {
    const v = registryContentDisposition({
      downloadIntent: true,
      certType: "owner",
      createdAt: JST_NOON,
    });
    expect(v.startsWith("attachment; ")).toBe(true);
    expect(v).toContain(`filename="${REGISTRY_ASCII_FALLBACK_NAME}"`);
    const ext = v.split("filename*=UTF-8''")[1];
    expect(ext).toBeDefined();
    expect(decodeURIComponent(ext)).toBe("謄本(所有者事項)_2026-08-25.pdf");
  });

  it("プレビューのときは従来どおり inline のみ（保存名を付けない）", () => {
    expect(
      registryContentDisposition({
        downloadIntent: false,
        certType: "owner",
        createdAt: JST_NOON,
      }),
    ).toBe("inline");
  });

  it("ヘッダ値に改行や生の日本語を混ぜない（ヘッダ分割・非ASCIIの事故を防ぐ）", () => {
    for (const cert of ["owner", "all", null, undefined]) {
      const v = registryContentDisposition({
        downloadIntent: true,
        certType: cert,
        createdAt: JST_NOON,
      });
      expect(v).not.toMatch(/[\r\n]/);
      expect(v).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("RFC 5987 が許さない文字は残さない（丸括弧をそのままヘッダに出さない）", () => {
    const v = registryContentDisposition({
      downloadIntent: true,
      certType: "owner",
      createdAt: JST_NOON,
    });
    const ext = v.split("filename*=UTF-8''")[1];
    // encodeURIComponent は "(" ")" を残してしまうので、それでは足りない。
    expect(ext).not.toContain("(");
    expect(ext).not.toContain(")");
    expect(ext).toContain("%28");
    expect(ext).toContain("%29");
    // 通ってよいのは attr-char か %XX だけ。
    expect(ext.replace(/%[0-9A-F]{2}/g, "")).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~]*$/);
  });

  it("ASCII のフォールバックは従来と同じ registry.pdf のまま", () => {
    expect(REGISTRY_ASCII_FALLBACK_NAME).toBe("registry.pdf");
  });
});

describe("REGISTRY_STORED_FILE_NAME（保存名は全経路で同じ）", () => {
  it("取得経路ごとに違う名前を作らない", async () => {
    const { REGISTRY_STORED_FILE_NAME } = await import(
      "../registry-display-name"
    );
    expect(REGISTRY_STORED_FILE_NAME).toBe("謄本.pdf");
    // 受付番号など、行ごとに変わる値を名前に混ぜない。
    expect(REGISTRY_STORED_FILE_NAME).not.toMatch(/registry-(auto|recovered)-/);
  });
});
