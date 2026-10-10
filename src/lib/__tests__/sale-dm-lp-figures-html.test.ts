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

  it("管理画面の見本(SVG)も、公開LPと同じ円形の図を使う(@codex #488 R7 P2)", () => {
    const thumb = renderFigureSvg("partner_network");
    const pub = renderFigureHtml("partner_network");
    const inner = /<svg class="net-svg"[^>]*>([\s\S]*?)<\/svg>/.exec(pub)![1];
    expect(thumb).toContain(inner);
    expect(thumb).not.toContain("当社の相談窓口");
  });

  it("提携先は「廃棄物処理業者」(2026-10-10 発注者指定・「片付け業者」は使わない)", () => {
    expect(LP_BRAND.partners).toContain("廃棄物処理業者");
    expect(LP_BRAND.partners).not.toContain("片付け業者");
    expect(renderFigureHtml("partner_network")).toContain("廃棄物処理業者");
    expect(renderFigureHtml("partner_network")).not.toContain("片付け");
  });

  it("円形の図は左右対称(同じ文字数の札が真ん中の円をはさんで鏡の位置)", () => {
    const ns = partnerNetworkNodes();
    for (const n of ns) {
      if (n.x === NETWORK_HUB.x) continue;
      const mirror = ns.find((m) => m !== n && m.y === n.y && m.x === 2 * NETWORK_HUB.x - n.x);
      expect(mirror, n.label).toBeDefined();
      expect(mirror!.label.length, n.label).toBe(n.label.length);
    }
    expect(NETWORK_VIEW.w).toBe(2 * NETWORK_HUB.x);
  });

  it("配置表は提携先の名前と一致する(名前を変えたら配置も作り直す)", () => {
    expect(partnerNetworkNodes().map((n) => n.label).sort()).toEqual([...LP_BRAND.partners].sort());
  });

  it("隣り合う札どうしのすき間がそろい、札は図の外へはみ出さない", () => {
    const ns = partnerNetworkNodes();
    const H = NETWORK_PILL_H;
    // 札は両端が半円の形(rx = 高さの半分)。中心線(長さ w-H の線分)から H/2 以内が札の中。
    const inPill = (n: (typeof ns)[number], px: number, py: number) => {
      const hx = (n.w - H) / 2;
      const cx = Math.max(n.x - hx, Math.min(n.x + hx, px));
      return Math.hypot(px - cx, py - n.y) <= H / 2;
    };
    // 2つの札のいちばん近いところのすき間(中心線どうしの距離 − H)
    const gap = (a: (typeof ns)[number], b: (typeof ns)[number]) => {
      let m = Infinity;
      for (let i = 0; i <= 40; i++) {
        const ax = a.x - (a.w - H) / 2 + ((a.w - H) * i) / 40;
        for (let j = 0; j <= 40; j++) m = Math.min(m, Math.hypot(ax - (b.x - (b.w - H) / 2 + ((b.w - H) * j) / 40), a.y - b.y));
      }
      return m - H;
    };
    const gaps = ns.map((n, i) => gap(n, ns[(i + 1) % ns.length]));
    expect(Math.min(...gaps)).toBeGreaterThan(30);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(6);
    // 外側の余白は上下左右でほぼ同じ
    const left = Math.min(...ns.map((n) => n.x - n.w / 2));
    const right = NETWORK_VIEW.w - Math.max(...ns.map((n) => n.x + n.w / 2));
    const top = Math.min(...ns.map((n) => n.y - H / 2));
    const bottom = NETWORK_VIEW.h - Math.max(...ns.map((n) => n.y + H / 2));
    for (const m of [left, right, top, bottom]) { expect(m).toBeGreaterThanOrEqual(8); expect(m).toBeLessThanOrEqual(16); }
    // 線の見える長さ=線に沿って、真ん中の円の縁から札の丸い縁に当たるまで(@codex #488 R8: 軸方向で測らない)
    const visible = ns.map((n) => {
      const len = Math.hypot(n.x - NETWORK_HUB.x, n.y - NETWORK_HUB.y);
      const ux = (n.x - NETWORK_HUB.x) / len;
      const uy = (n.y - NETWORK_HUB.y) / len;
      let lo = 0;
      let hi = len;
      for (let k = 0; k < 40; k++) {
        const m = (lo + hi) / 2;
        if (inPill(n, NETWORK_HUB.x + ux * m, NETWORK_HUB.y + uy * m)) hi = m; else lo = m;
      }
      return hi - NETWORK_HUB.r;
    });
    expect(Math.max(...visible) - Math.min(...visible), visible.map((v) => v.toFixed(1)).join(",")).toBeLessThan(2);
    expect(Math.min(...visible)).toBeGreaterThan(30);
    // 線の長さと札どうしのすき間も、ほぼ同じ(図全体の余白がそろう)
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const meanLine = visible.reduce((a, b) => a + b, 0) / visible.length;
    expect(Math.abs(meanGap - meanLine)).toBeLessThan(6);
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

describe("4枚目の札「住み続けて売る(リースバック)」(2026-10-08 発注者決定)", () => {
  it("札は4枚で、4枚目はリースバックの説明と絵", () => {
    const h = renderFigureHtml("sell_rent_keep");
    expect((h.match(/class="opt-card"/g) ?? []).length).toBe(4);
    expect(h).toContain("<h3>住み続けて売る</h3>");
    expect(h).toContain("リースバック");
    expect(h).toContain('src="/lp-assets/brand/opt-leaseback.jpg"');
  });
  it("管理画面の見本(SVG)も4枚で、札の文字が札の幅に収まる", () => {
    const svg = renderFigureSvg("sell_rent_keep");
    expect((svg.match(/<rect x="\d+" y="84"/g) ?? []).length).toBe(4);
    expect(svg).toContain(">住み続けて売る</text>");
  });
});

// 発注者決定(2026-10-10): 空き家の LP には「住み続けて売る(リースバック)」は合わない=3枚の札も選べるようにする。
describe("3枚の札(売る・貸す・しばらく持つ・リースバックなし)", () => {
  it("図の種類に3枚版があり、日本語の名前を持つ", () => {
    expect(FIGURE_KINDS).toContain("sell_rent_keep_3");
  });
  it("公開LP: 3枚で、リースバックの札は出さない。3枚用の並び(.three)", () => {
    const h = renderFigureHtml("sell_rent_keep_3");
    expect((h.match(/class="opt-card"/g) ?? []).length).toBe(3);
    expect(h).toContain('<div class="options three">');
    for (const t of ["売る", "貸す", "しばらく持つ"]) expect(h).toContain(`<h3>${t}</h3>`);
    expect(h).not.toContain("住み続けて売る");
    expect(h).not.toContain("リースバック");
  });
  it("4枚版はこれまでどおり4枚(相続のLPは変わらない)", () => {
    expect((renderFigureHtml("sell_rent_keep").match(/class="opt-card"/g) ?? []).length).toBe(4);
  });
  it("管理画面の見本も3枚", () => {
    const svg = renderFigureSvg("sell_rent_keep_3");
    expect((svg.match(/<rect x="\d+" y="84"/g) ?? []).length).toBe(3);
    expect(svg).not.toContain("住み続けて売る");
  });
});
