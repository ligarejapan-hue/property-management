import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MLIT_GAIJI_MAP, replaceMlitGaiji } from "@/lib/agent-registry/mlit-gaiji-map";
import { cleanText, parseDetail, parseListPage } from "@/lib/agent-registry/parse";
import { REGISTRY_GAIJI_MAP } from "@/lib/registry-gaiji-map";

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "src/lib/agent-registry/__tests__/fixtures", name), "utf8");

describe("国交省の業者一覧の外字の置き換え表", () => {
  it("辻・塚(2種)・家・𠮷 を置き換える(2026-11-14 発注者「辻や塚が外字で出やすい」)", () => {
    expect(replaceMlitGaiji("\uE532見本工務店")).toBe("辻見本工務店");
    expect(replaceMlitGaiji("大\uE45F見本")).toBe("大塚見本");
    expect(replaceMlitGaiji("飯\uE484見本")).toBe("飯塚見本");
    expect(replaceMlitGaiji("見本の\uE462")).toBe("見本の家");
    expect(replaceMlitGaiji("住\uE001見本")).toBe("住\u{20BB7}見本");
  });

  it("表に無い外字はそのまま残す(推し量らない=読めない字として DM の守りが効く)", () => {
    expect(replaceMlitGaiji("東\uE005見本")).toBe("東\uE005見本");
    expect(MLIT_GAIJI_MAP.has("\uE005")).toBe(false);
  });

  it("外字の無い文字は同じ値を返す", () => {
    expect(replaceMlitGaiji("株式会社 見本不動産")).toBe("株式会社 見本不動産");
    expect(replaceMlitGaiji("")).toBe("");
  });

  it("★表の形: 左は私用領域の1字・右は私用領域でない1字(1つの符号位置)で NFKC で変わらない", () => {
    expect(MLIT_GAIJI_MAP.size).toBeGreaterThan(70);
    for (const [from, to] of MLIT_GAIJI_MAP) {
      expect(from).toMatch(/^[\uE000-\uF8FF]$/u);
      expect([...to]).toHaveLength(1);
      expect(to).not.toMatch(/[\uE000-\uF8FF]/u);
      expect(to.normalize("NFKC")).toBe(to);
    }
  });

  it("★謄本の表とは別物(同じ番号が別の字=取り違えて使っていない)", () => {
    // 謄本では U+E009=五・U+E044=余白の枠、国交省では U+E009=藤・U+E044=角
    expect(REGISTRY_GAIJI_MAP.get("\uE009")).toBe("五");
    expect(MLIT_GAIJI_MAP.get("\uE009")).toBe("藤");
    expect(MLIT_GAIJI_MAP.get("\uE044")).toBe("角");
  });
});

describe("国交省の画面を読むときに外字を置き換える", () => {
  it("cleanText が外字を置き換える(生の字・文字参照のどちらでも)", () => {
    expect(cleanText("<td>大\uE45F見本</td>")).toBe("大塚見本");
    expect(cleanText("<td>&#xE532;見本</td>")).toBe("辻見本");
    expect(cleanText("<td>&#58674;見本</td>")).toBe("辻見本");
  });

  it("★一覧の商号と所在地が普通の字になる(毎月の取り直しで外字に戻らない)", () => {
    const html = fixture("list.html").replace("株式会社　見本不動産", "株式会社　\uE532見本不動産").replace(
      "東京都世田谷区見本町４－１１－２４",
      "東京都世田谷区見本\uE45F４－１１－２４",
    );
    const r = parseListPage(html).rows.find((x) => x.licenseKey === "13000001")!;
    expect(r.companyName).toBe("株式会社 辻見本不動産");
    expect(r.address).toBe("東京都世田谷区見本塚４－１１－２４");
  });

  it("★詳細の所在地も普通の字になる", () => {
    const base = parseDetail(fixture("detail.html"), "13000001");
    expect(base.address).toBeTruthy();
    const html = fixture("detail.html").replace(base.address!, `${base.address}\uE484`);
    expect(parseDetail(html, "13000001").address).toBe(`${base.address}塚`);
  });
});
