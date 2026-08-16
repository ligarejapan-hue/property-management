import { describe, expect, it } from "vitest";

import {
  KNOWN_PROBE_SELECTORS,
  formatRegistryPageProbe,
  maskProbeOnclick,
  maskProbeText,
  type RegistryPageProbe,
} from "../page-probe";

/**
 * 目的 = **実サイトの画面構造を1回だけ持ち帰る**ための診断整形。
 *
 * ⚠この診断は本番の登記情報提供サービス上で動く。表の**中身**（所在・地番・所有者）は
 * 個人情報および物件特定情報なので、**絶対にログへ出さない**。持ち帰るのは
 * 「どの表・ボタン・タブが在るか」という**構造だけ**。
 */
describe("maskProbeText（見えている文字のマスク）", () => {
  it("⚠数字は1桁でも伏せる（地番・所在が混ざっても部分的にも読めない）", () => {
    expect(maskProbeText("井土ケ谷中町69-2")).toBe("井土ケ谷中町＊-＊");
    expect(maskProbeText("令和7年8月16日")).toBe("令和＊年＊月＊日");
    // 全角も同じ（サイトは全角で返すことがある）。
    expect(maskProbeText("６９－２")).toBe("＊－＊");
  });

  it("列見出しやボタン名はそのまま残る（構造の手がかりを潰さない）", () => {
    expect(maskProbeText("請求種別")).toBe("請求種別");
    expect(maskProbeText("請求")).toBe("請求");
    expect(maskProbeText("次へ")).toBe("次へ");
  });

  it("長すぎる文字は切り詰める", () => {
    expect(maskProbeText("あ".repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it("空白を潰し、前後を落とす", () => {
    expect(maskProbeText("  請求  種別 \n ")).toBe("請求 種別");
  });
});

describe("maskProbeOnclick（onclick は関数名だけ残す）", () => {
  it("⚠引数の数字を潰す（行アクションの onclick に受付番号が入り得る）", () => {
    expect(maskProbeOnclick("myPageDownload(12345)")).toBe("myPageDownload(＊)");
  });

  it("関数名は残る＝セレクタの手がかりを潰さない", () => {
    expect(maskProbeOnclick("selectTab('tabMy')")).toBe("selectTab('tabMy')");
    expect(maskProbeOnclick("fuBtnForward()")).toBe("fuBtnForward()");
  });

  it("長すぎるものは切る", () => {
    expect(maskProbeOnclick("f(".repeat(80)).length).toBeLessThanOrEqual(60);
  });
});

describe("formatRegistryPageProbe（1行の診断ログ）", () => {
  const base: RegistryPageProbe = {
    tables: [],
    buttons: [],
    tabs: [],
    known: {},
  };

  it("表はid・行数・列見出しを出す（中身は出さない）", () => {
    const out = formatRegistryPageProbe({
      ...base,
      tables: [{ id: "fudosanIchiranTbl", headers: ["請求種別", "所在"], rowCount: 3 }],
    });
    expect(out).toContain("fudosanIchiranTbl");
    expect(out).toContain("rows=3");
    expect(out).toContain("請求種別");
  });

  it("ボタンはid・名前・押せるかを出す", () => {
    const out = formatRegistryPageProbe({
      ...base,
      buttons: [{ id: "myPageSeikyu", label: "請求", disabled: true }],
    });
    expect(out).toContain("myPageSeikyu");
    expect(out).toContain("請求");
    expect(out).toContain("disabled");
  });

  it("idが無いボタンは onclick で識別するが、数字は伏せた形で出る", () => {
    const out = formatRegistryPageProbe({
      ...base,
      buttons: [
        { id: "", onclick: "myPageDownload(98765)", label: "表示・保存", disabled: false },
      ],
    });
    expect(out).toContain("myPageDownload");
    expect(out).not.toContain("98765");
  });

  it("⚠タブの onclick も数字を伏せる", () => {
    const out = formatRegistryPageProbe({
      ...base,
      tabs: [{ label: "明細", onclick: "showDetail(24680)" }],
    });
    expect(out).not.toContain("24680");
    expect(out).toContain("showDetail");
  });

  it("タブは onclick をそのまま出す（セレクタ特定の要）", () => {
    const out = formatRegistryPageProbe({
      ...base,
      tabs: [{ label: "マイページ", onclick: "selectTab('tabMy')" }],
    });
    expect(out).toContain("selectTab('tabMy')");
  });

  it("既知セレクタの在/不在を出す＝どれが外れたか一目で分かる", () => {
    const out = formatRegistryPageProbe({
      ...base,
      known: { "#myPageTable": false, "#fudosanIchiranTbl": true },
    });
    expect(out).toContain("#myPageTable=no");
    expect(out).toContain("#fudosanIchiranTbl=yes");
  });

  it("⚠数字を含む見出しは伏せられた形で出る（表の中身が紛れても漏れない）", () => {
    const out = formatRegistryPageProbe({
      ...base,
      tables: [{ id: "t1", headers: ["井土ケ谷中町69-2"], rowCount: 1 }],
    });
    expect(out).not.toContain("69-2");
    expect(out).toContain("＊");
  });

  it("要素が多くても打ち切る（ログを溢れさせない）", () => {
    const out = formatRegistryPageProbe({
      ...base,
      buttons: Array.from({ length: 200 }, (_, i) => ({
        id: `b${i}`,
        label: "x",
        disabled: false,
      })),
    });
    expect(out.length).toBeLessThan(4000);
    expect(out).toContain("…他");
  });

  it("空の画面でも落ちない", () => {
    expect(() => formatRegistryPageProbe(base)).not.toThrow();
  });
});

describe("KNOWN_PROBE_SELECTORS", () => {
  it("マイページ遷移の失敗を切り分けるのに要る4つを含む", () => {
    for (const sel of [
      "#myPageTable",
      "#myPageSeikyu",
      "#fudosanIchiranTbl",
      "#siborikomi",
    ]) {
      expect(KNOWN_PROBE_SELECTORS).toContain(sel);
    }
  });
});
