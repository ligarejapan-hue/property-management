import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FIGURE_KINDS, renderFigureHtml, renderFigureSvg, partnerNetworkNodes, NETWORK_VIEW, NETWORK_PILL_H, NETWORK_HUB } from "../sale-dm-letter/lp-figures";
import { LP_BRAND } from "../sale-dm-letter/lp-brand";

// 2026-10 の見本(発注者承認)どおりの HTML 版の図。公開LPはこちらを使う(SVG は管理画面の見本)。
describe("renderFigureHtml", () => {
  it("全種類が文字列を返し、外部参照・script を含まない", () => {
    for (const k of FIGURE_KINDS) {
      const h = renderFigureHtml(k);
      expect(h.length).toBeGreaterThan(0);
      expect(h).not.toMatch(/<script|src="http|url\(|href="http/i);
    }
  });

  it("期限の図: 2026-10-06 の事実確認どおりの文言(1年ずれて読める『3年目の年末』は使わない)", () => {
    const h = renderFigureHtml("inheritance_deadlines");
    expect(h).toContain("期限の数え方は、手続きや制度によって異なります");
    expect(h).toContain("原則<br>10か月以内");
    expect(h).toContain("特例で税額がゼロになる場合も、申告が必要なことがあります");
    expect(h).toContain("原則2027年3月31日までに申請が必要です");
    expect(h).toContain("相続開始から3年を経過する日の属する年の12月31日まで");
    expect(h).toContain("2027年12月31日までの売却が対象です");
    expect(h).toContain("1人あたり最大2,000万円");
    expect(h).toContain("確定申告が必要です");
    expect(h).not.toContain("3年目の年末");
    expect(h).not.toContain("ここから期限を数えます");
    // 特例の行だけ目立たせる
    expect((h.match(/class="dl-item key"/g) ?? []).length).toBe(1);
  });

  it("流れの図: 家族での話し合いを含む5段と期間の目安", () => {
    const h = renderFigureHtml("sale_flow");
    expect((h.match(/<li>/g) ?? []).length).toBe(5);
    expect(h).toContain("ご家族での話し合い");
    expect(h).toContain("3〜6か月ほどが目安です");
  });

  it("売る・貸す・しばらく持つ: 絵つきの3枚。絵は元の縦横比の実寸を width/height に持つ", () => {
    const h = renderFigureHtml("sell_rent_keep");
    for (const o of LP_BRAND.options) {
      expect(h).toContain(`<h3>${o.title}</h3>`);
      expect(h).toContain(`src="${o.image.src}" width="${o.image.width}" height="${o.image.height}"`);
    }
  });

  it("窓口はひとつ: 真ん中のリガーレジャパンから提携先7つへ線(色分けなし・発注者要望 2026-10-07)", () => {
    const h = renderFigureHtml("partner_network");
    for (const p of LP_BRAND.partners) expect(h).toContain(`>${p}</text>`);
    expect(h).toContain(">リガーレ</text>");
    expect((h.match(/<line /g) ?? []).length).toBe(7);
    expect(h).not.toContain("net-legend");
    expect(h).not.toContain("#fffdf8\" stroke=\"#0e6b5c\" stroke-width=\"1.5\"/><text");
  });

  it("配置表は提携先の名前と一致する(名前を変えたら配置も作り直す)", () => {
    expect(partnerNetworkNodes().map((n) => n.label).sort()).toEqual([...LP_BRAND.partners].sort());
  });

  it("隣り合う札どうしのすき間がそろい、札は図の外へはみ出さない", () => {
    const ns = partnerNetworkNodes();
    const H = NETWORK_PILL_H;
    const gap = (a: (typeof ns)[number], b: (typeof ns)[number]) => {
      const dx = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
      const dy = Math.abs(a.y - b.y) - H;
      return dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy);
    };
    const gaps = ns.map((n, i) => gap(n, ns[(i + 1) % ns.length]));
    expect(Math.min(...gaps)).toBeGreaterThan(40);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(8);
    // 外側の余白は上下左右でほぼ同じ
    const left = Math.min(...ns.map((n) => n.x - n.w / 2));
    const right = NETWORK_VIEW.w - Math.max(...ns.map((n) => n.x + n.w / 2));
    const top = Math.min(...ns.map((n) => n.y - H / 2));
    const bottom = NETWORK_VIEW.h - Math.max(...ns.map((n) => n.y + H / 2));
    for (const m of [left, right, top, bottom]) { expect(m).toBeGreaterThanOrEqual(8); expect(m).toBeLessThanOrEqual(16); }
    // 真ん中の円から各札までのすき間(線の見える長さ)がそろっている
    const clear = ns.map((n) => {
      const dx = Math.max(0, Math.abs(n.x - NETWORK_HUB.x) - n.w / 2);
      const dy = Math.max(0, Math.abs(n.y - NETWORK_HUB.y) - H / 2);
      return Math.hypot(dx, dy) - NETWORK_HUB.r;
    });
    expect(Math.max(...clear) - Math.min(...clear)).toBeLessThan(4);
    expect(Math.min(...clear)).toBeGreaterThan(24);
  });

  it("案内役: イメージイラストと明記する", () => {
    const h = renderFigureHtml("consult_guide");
    expect(h).toContain(`src="${LP_BRAND.guide.src}"`);
    expect(h).toContain("イメージ<br />イラスト");
  });

  it("横棒などの図は従来の SVG を枠つきで載せる", () => {
    expect(renderFigureHtml("cost_breakdown")).toBe(`<div class="fig-svg">${renderFigureSvg("cost_breakdown")}</div>`);
  });

  it("会社の画像はすべて public/lp-assets/brand/ の静的ファイル(公開口 /lp-assets/ の下)", () => {
    const srcs = [LP_BRAND.logo, LP_BRAND.guide, ...LP_BRAND.options.map((o) => o.image)].map((i) => i.src);
    for (const s of srcs) {
      expect(s.startsWith("/lp-assets/brand/")).toBe(true);
      // 本番の公開ホスト(nginx)は /t/・/u/・/lp-assets/ だけを通す。ファイルが実在することも確かめる
      expect(existsSync(join(process.cwd(), "public", s)), s).toBe(true);
    }
  });
});
