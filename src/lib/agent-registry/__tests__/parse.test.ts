import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LayoutChanged, licenseKeyFromText, parseDetail, parseListPage } from "@/lib/agent-registry/parse";

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
    expect(page.rows.map((r) => r.licenseKey).slice(0, 3)).toEqual(["13000001", "13000044", "13104567"]);
    expect(page.rows).toHaveLength(49); // 50行のうち1社が2行=49社
  });

  it("★表示している範囲(N件目～M件目)が、選んだページと件数に合わなければ LayoutChanged(別のページを読まない・@codex #477)", () => {
    // 2ページ目が選ばれているのに「1件目～50件目」
    const wrongPage = listHtml.replace('<option value="1" selected="selected">1/539</option><option value="2">2/539</option>', '<option value="1">1/539</option><option value="2" selected="selected">2/539</option>');
    expect(wrongPage).not.toBe(listHtml);
    expect(() => parseListPage(wrongPage)).toThrow(LayoutChanged);
    // 1ページ目なのに「101件目～150件目」
    expect(() => parseListPage(listHtml.replace("1件目～50件目までを表示", "101件目～150件目までを表示"))).toThrow(LayoutChanged);
    // 最後のページは件数で終わる(26906件・539ページ目=26901件目～26906件目・6行)
    const last = listHtml
      .replace('<option value="1" selected="selected">1/539</option>', '<option value="1">1/539</option>')
      .replace('<option value="539">539/539</option>', '<option value="539" selected="selected">539/539</option>')
      .replace("1件目～50件目までを表示", "26901件目～26906件目までを表示")
      .replace(/(<tr>\s*<td style="text-align:right;">6<\/td>[\s\S]*?<\/tr>\s*)(?:<tr>[\s\S]*?<\/tr>\s*)*(<\/table>)/, "$1$2");
    const lastPage = parseListPage(last);
    expect(lastPage.page).toBe(539);
    expect(lastPage.rows.length).toBe(5); // 6行のうち1社が2行
    // 最後のページの範囲が件数を超えている
    expect(() => parseListPage(last.replace("26901件目～26906件目", "26901件目～26907件目"))).toThrow(LayoutChanged);
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
      .replaceAll("js_ShowDetail('13", "js_ShowDetail('00")
      .replaceAll(">東京都<", ">国土交通大臣<");
    expect(parseListPage(html).rows[0].licenseLabel).toBe("国土交通大臣(17)第000001号");
  });

  it("★大臣免許の行も、見えている欄が「国土交通大臣」そのものでなければ LayoutChanged(「建設大臣」などを通さない・@codex #477)", () => {
    const html = listHtml
      .replaceAll("js_ShowDetail('13", "js_ShowDetail('00")
      .replaceAll(">東京都<", ">建設大臣<");
    expect(html).not.toBe(listHtml);
    expect(() => parseListPage(html)).toThrow(LayoutChanged);
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

  it("★「1件目～N件目」の表示と読めた行の数が違う(行が欠けた)一覧 → LayoutChanged(@codex #477)", () => {
    // 見本は50行=「1件目～50件目」。1行欠けた画面
    const missing = listHtml.replace(/<tr>(\s*<td style="text-align:right;">4<\/td>[\s\S]*?<\/tr>)/, "");
    expect(missing).not.toBe(listHtml);
    expect(() => parseListPage(missing)).toThrow(LayoutChanged);
    // 範囲の表示そのものが無い
    expect(() => parseListPage(listHtml.replace("1件目～50件目までを表示", ""))).toThrow(LayoutChanged);
  });

  it("★ページ数が件数と合わない(26906件なのに「1/1」)一覧 → LayoutChanged(1ページで終わりにしない・@codex #477)", () => {
    const onePage = listHtml.replace(
      '<option value="1" selected="selected">1/539</option><option value="2">2/539</option><option value="3">3/539</option><option value="539">539/539</option>',
      '<option value="1" selected="selected">1/1</option>',
    );
    expect(onePage).not.toBe(listHtml);
    expect(() => parseListPage(onePage)).toThrow(LayoutChanged);
    // 1ページ多い・少ないも合わない
    expect(() => parseListPage(listHtml.replaceAll("/539<", "/540<"))).toThrow(LayoutChanged);
    expect(() => parseListPage(listHtml.replaceAll("/539<", "/538<"))).toThrow(LayoutChanged);
  });

  it("★件数は0でないのに行が1つも無い一覧 → LayoutChanged(空のページとして進めない・@codex #477)", () => {
    const empty = listHtml.replace(/<tr>\s*<td[\s\S]*<\/tr>\s*<\/table>/, "</table>");
    expect(() => parseListPage(empty)).toThrow(LayoutChanged);
  });

  it("★見えている「免許行政庁」の欄が、免許の鍵の行政庁と食い違う行は LayoutChanged(@codex #477)", () => {
    const html = listHtml.replace(
      /(<td style="text-align:left; white-space : nowrap;">)東京都(<\/td>\s*<td[^>]*title="licenseNo">\(17\)第000001号)/,
      "$1神奈川県$2",
    );
    expect(html).not.toBe(listHtml);
    expect(() => parseListPage(html)).toThrow(LayoutChanged);
  });

  it("免許番号の文字から免許の鍵を作る(手入力の名簿の免許番号と照らす)", () => {
    expect(licenseKeyFromText("東京都知事(17)第000001号")).toBe("13000001");
    expect(licenseKeyFromText("東京都知事（３）第１２３４５号")).toBe("13012345");
    expect(licenseKeyFromText("神奈川県知事(2) 第 4567 号")).toBe("14004567");
    expect(licenseKeyFromText("国土交通大臣(9)第001234号")).toBe("00001234");
    expect(licenseKeyFromText("大阪府知事(3)第1号")).toBeNull();
    expect(licenseKeyFromText("12345")).toBeNull();
    expect(licenseKeyFromText("")).toBeNull();
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

  it("★電話番号・所在地・商号の見出しそのものが無い詳細は、空欄と区別して LayoutChanged(@codex #477)", () => {
    expect(() => parseDetail(detailHtml.replace('<th style="width : 100px;">電話番号</th>', "<th>連絡先</th>"), "13000001")).toThrow(LayoutChanged);
    expect(() => parseDetail(detailHtml.replace("<th>主たる事務所の<br />所在地</th>", "<th>所在</th>"), "13000001")).toThrow(LayoutChanged);
    expect(() => parseDetail(detailHtml.replace("<th>商号又は名称</th>", "<th>名称</th>"), "13000001")).toThrow(LayoutChanged);
  });

  it("免許証番号の欄が無い(別の画面に戻された)→ LayoutChanged", () => {
    expect(() => parseDetail(detailHtml.replace("<th>免許証番号</th>", ""), "13000001")).toThrow(LayoutChanged);
  });

  it("開いた会社と違う免許番号の詳細 → LayoutChanged(取り違えない)", () => {
    expect(() => parseDetail(detailHtml, "13000044")).toThrow(LayoutChanged);
  });

  it("★番号が同じでも、違う都県の知事免許の詳細は取り違えとして止める(@codex #477)", () => {
    expect(() => parseDetail(detailHtml, "14000001")).toThrow(LayoutChanged); // 神奈川を頼んで東京が返った
    expect(() => parseDetail(detailHtml, "11000001")).toThrow(LayoutChanged);
    expect(() => parseDetail(detailHtml, "00000001")).toThrow(LayoutChanged);
    const kanagawa = detailHtml.replace("東京都知事免許", "神奈川県知事免許");
    expect(parseDetail(kanagawa, "14000001").phone).toBe("03-0000-1212");
    const minister = detailHtml.replace("東京都知事免許", "国土交通大臣免許");
    expect(parseDetail(minister, "00000001").phone).toBe("03-0000-1212");
  });
});
