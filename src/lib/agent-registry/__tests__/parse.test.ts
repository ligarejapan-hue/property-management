import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LayoutChanged, parseDetail, parseListPage } from "@/lib/agent-registry/parse";

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "src/lib/agent-registry/__tests__/fixtures", name), "utf8");
const listHtml = fixture("list.html");
const detailHtml = fixture("detail.html");

describe("一覧のページを読む", () => {
  const page = parseListPage(listHtml);

  it("件数・ページ数・今のページ", () => {
    expect(page.total).toBe(26906);
    expect(page.pages).toBe(539);
    expect(page.page).toBe(1);
  });

  it("免許の鍵は詳細を開く引数(行政庁2桁+番号6桁)・表示は行政庁名つき", () => {
    expect(page.rows[0]).toEqual({
      licenseKey: "13000001",
      authority: "13",
      licenseLabel: "東京都知事(17)第000001号",
      companyName: "株式会社 見本不動産",
      address: "東京都世田谷区見本町４－１１－２４",
      isMain: true,
    });
  });

  it("★本店の行がそのページに無い会社は isMain=false(支店の所在地で本店を上書きしないため)", () => {
    const html = listHtml.replace(
      /<td style="text-align:left; ">本店<\/td>\s*<td style="text-align:left; ">東京都渋谷区試験町１－１２－１８<\/td>/,
      '<td style="text-align:left; ">渋谷支店</td>\n<td style="text-align:left; ">東京都渋谷区試験町１－１２－１８</td>',
    );
    const r = parseListPage(html).rows.find((x) => x.licenseKey === "13000044")!;
    expect(r.isMain).toBe(false);
  });

  it("★読めなかった行がある(詳細を開く引数の数と読めた行の数が違う)→ LayoutChanged(黙って落とさない)", () => {
    const html = listHtml.replace(/<tr>(\s*<td style="text-align:right;">4<\/td>)/, '<tr class="odd">$1');
    expect(html).not.toBe(listHtml);
    expect(() => parseListPage(html)).toThrow(LayoutChanged);
  });

  it("同じ会社の事務所ごとの行は1社にまとめ、本店の所在地を使う・文字参照を戻す", () => {
    const rows = page.rows.filter((r) => r.licenseKey === "13000044");
    expect(rows).toHaveLength(1);
    expect(rows[0].companyName).toBe("試験建設&興業 株式会社");
    expect(rows[0].address).toBe("東京都渋谷区試験町１－１２－１８");
    expect(page.rows.map((r) => r.licenseKey)).toEqual(["13000001", "13000044", "13104567"]);
  });

  it("所在地が空なら null", () => {
    expect(page.rows.find((r) => r.licenseKey === "13104567")?.address).toBeNull();
  });

  it("★代表者名はどの値にも入らない", () => {
    const all = JSON.stringify(page);
    for (const name of ["見本", "太郎", "花子", "次郎"]) {
      if (name === "見本") {
        // 商号・所在地には「見本」が入るので、代表者の欄そのもの(「見本 太郎」)で確かめる
        expect(all).not.toContain("見本 太郎");
        expect(all).not.toContain("見本　太郎");
        continue;
      }
      expect(all).not.toContain(name);
    }
  });

  it("大臣免許の表示", () => {
    const html = listHtml
      .replaceAll("js_ShowDetail('13000001')", "js_ShowDetail('00009876')")
      .replace(">東京都<", ">国土交通大臣<");
    expect(parseListPage(html).rows[0].licenseLabel).toBe("国土交通大臣(17)第000001号");
  });

  it("0件の画面は空(件数 0)", () => {
    const html = listHtml
      .replace("検索結果：26906件", "検索結果：0件")
      .replace(/<select id="pageListNo1"[\s\S]*?<\/select>/, "")
      .replace(/<tr>\s*<td[\s\S]*<\/tr>\s*<\/table>/, "</table>");
    expect(parseListPage(html)).toEqual({ total: 0, pages: 0, page: 0, rows: [] });
  });

  it("件数の文言が無い・見出しの列が変わった・行の列数が違う → 推測せず LayoutChanged", () => {
    expect(() => parseListPage(listHtml.replace("検索結果：26906件", ""))).toThrow(LayoutChanged);
    expect(() => parseListPage(listHtml.replace("<th>代表者名</th>", ""))).toThrow(LayoutChanged);
    expect(() => parseListPage(listHtml.replace("<th>事務所名</th>", "<th>電話</th>"))).toThrow(LayoutChanged);
    expect(() =>
      parseListPage(listHtml.replace('<td style="text-align:left; ">本店</td>', "")),
    ).toThrow(LayoutChanged);
    expect(() => parseListPage(listHtml.replace(/<select id="pageListNo1"[\s\S]*?<\/select>/, ""))).toThrow(
      LayoutChanged,
    );
  });

  it("詳細を開く引数の形が違う行は LayoutChanged", () => {
    expect(() => parseListPage(listHtml.replace("js_ShowDetail('13000001')", "js_ShowDetail('X')"))).toThrow(
      LayoutChanged,
    );
  });
});

describe("詳細のページを読む", () => {
  const d = parseDetail(detailHtml, "13000001");

  it("電話・ふりがな(全角カタカナ)・所在地・有効期間の終わり", () => {
    expect(d).toEqual({
      licenseKey: "13000001",
      companyKana: "カブシキガイシヤ ミホンフドウサン",
      address: "東京都世田谷区見本町４－１１－２４",
      phone: "03-0000-1212",
      validUntil: "R10年04月26日",
    });
  });

  it("★代表者の名前・読みはどの値にも入らない", () => {
    const all = JSON.stringify(d);
    expect(all).not.toContain("太郎");
    expect(all).not.toContain("タロウ");
    expect(all).not.toContain("ﾀﾛｳ");
  });

  it("電話が空なら null", () => {
    expect(parseDetail(detailHtml.replace("03-0000-1212", ""), "13000001").phone).toBeNull();
  });

  it("免許証番号の欄が無い(別の画面に戻された)→ LayoutChanged", () => {
    expect(() => parseDetail(detailHtml.replace("<th>免許証番号</th>", ""), "13000001")).toThrow(LayoutChanged);
  });

  it("開いた会社と違う免許番号の詳細 → LayoutChanged(取り違えない)", () => {
    expect(() => parseDetail(detailHtml, "13000044")).toThrow(LayoutChanged);
  });
});
