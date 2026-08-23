/**
 * 共通ページ送り (UI一貫性 第2弾 ⑨・発注者承認 2026-08-23)。
 *
 * 背景: 「前へ/次へ」が7画面で個別実装され、件数表示が「N件中 X〜Y」
 * 「全N件中X〜Y件」等に揺れていた(実測)。表示は取込画面の形
 * 「全 N 件中 X〜Y 件を表示」(0件時は「全 0 件」)に統一する。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Pagination } from "../pagination";

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("Pagination", () => {
  it("件数表示は「全 N 件中 X〜Y 件を表示」に統一", () => {
    const html = render(
      <Pagination
        page={2}
        totalPages={5}
        total={98}
        pageSize={20}
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    expect(html).toContain("全 <strong>98</strong> 件中");
    expect(html).toContain("<strong>21</strong>〜<strong>40</strong> 件を表示");
  });

  it("0件のときは「全 0 件」だけを出す(X〜Yを出さない)", () => {
    const html = render(
      <Pagination
        page={1}
        totalPages={1}
        total={0}
        pageSize={20}
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    expect(html).toContain("全 0 件");
    expect(html).not.toContain("〜");
  });

  it("total を渡さなければ件数表示なし(ページ位置だけ)", () => {
    const html = render(
      <Pagination page={3} totalPages={7} onPrev={() => {}} onNext={() => {}} />,
    );
    expect(html).not.toContain("件中");
    expect(html).toContain("3 / 7");
  });

  it("端では前へ/次へが disabled(1ページ目=前へ不可・最終=次へ不可)", () => {
    const first = render(
      <Pagination page={1} totalPages={3} onPrev={() => {}} onNext={() => {}} />,
    );
    // 前へボタンだけ disabled
    const btns = first.match(/<button[^>]*>/g) ?? [];
    expect(btns).toHaveLength(2);
    expect(btns[0]).toContain('disabled=""');
    expect(btns[1]).not.toContain('disabled=""');

    const last = render(
      <Pagination page={3} totalPages={3} onPrev={() => {}} onNext={() => {}} />,
    );
    const btns2 = last.match(/<button[^>]*>/g) ?? [];
    expect(btns2[0]).not.toContain('disabled=""');
    expect(btns2[1]).toContain('disabled=""');
  });

  it("busy(読み込み中)は両方 disabled", () => {
    const html = render(
      <Pagination
        page={2}
        totalPages={3}
        busy
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    const btns = html.match(/<button[^>]*>/g) ?? [];
    expect(btns[0]).toContain('disabled=""');
    expect(btns[1]).toContain('disabled=""');
  });

  it("totalPages=0 でも 1 として表示する(0除算・「/ 0」を出さない)", () => {
    const html = render(
      <Pagination page={1} totalPages={0} onPrev={() => {}} onNext={() => {}} />,
    );
    expect(html).toContain("1 / 1");
  });

  it("ボタンは共通 Button(secondary/sm)=rounded-md の枠線ボタン", () => {
    const html = render(
      <Pagination page={2} totalPages={3} onPrev={() => {}} onNext={() => {}} />,
    );
    expect(html).toContain("rounded-md");
    expect(html).toContain("border-gray-300");
    expect(html).toContain("前へ");
    expect(html).toContain("次へ");
  });

  it("スマホのタップ寸法44pxを確保(デスクトップは通常寸)", () => {
    const html = render(
      <Pagination page={2} totalPages={3} onPrev={() => {}} onNext={() => {}} />,
    );
    const btns = html.match(/<button[^>]*>/g) ?? [];
    expect(btns[0]).toContain("min-h-[44px]");
    expect(btns[0]).toContain("sm:min-h-0");
    expect(btns[1]).toContain("min-h-[44px]");
  });

  it("children(表示件数切替等の補助操作)は前へ/次への左に並ぶ", () => {
    const html = render(
      <Pagination page={1} totalPages={2} onPrev={() => {}} onNext={() => {}}>
        <select aria-label="1ページあたりの表示件数" />
      </Pagination>,
    );
    expect(html.indexOf("<select")).toBeGreaterThan(-1);
    expect(html.indexOf("<select")).toBeLessThan(html.indexOf("前へ"));
  });

  it("dark でも可読(件数文とボタンに dark クラス=旧ページ側darkピンの移行先)", () => {
    const html = render(
      <Pagination page={2} totalPages={3} total={50} pageSize={20} onPrev={() => {}} onNext={() => {}} />,
    );
    expect(html).toContain("dark:text-gray-300");   // 件数文・ボタン文字
    expect(html).toContain("dark:border-gray-700"); // ボタン枠線
    expect(html).toContain("dark:hover:bg-gray-800"); // ボタンhover
    expect(html).toContain("dark:bg-gray-900");     // ボタン地
    // ライトモードの基本色も同時に担保
    expect(html).toContain("border-gray-300");
    expect(html).toContain("hover:bg-gray-50");
  });

  it("数字は tabular-nums で桁が揃う", () => {
    const html = render(
      <Pagination page={2} totalPages={3} onPrev={() => {}} onNext={() => {}} />,
    );
    expect(html).toContain("tabular-nums");
  });
});
