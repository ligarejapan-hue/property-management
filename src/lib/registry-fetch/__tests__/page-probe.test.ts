import { describe, expect, it } from "vitest";

import {
  KNOWN_PROBE_SELECTORS,
  formatRegistryPageProbe,
  hasUnbalancedQuotes,
  isSafeOnclickArg,
  maskProbeOnclick,
  safeLabel,
  type RegistryPageProbe,
} from "../page-probe";

/**
 * 目的 = **実サイトの画面構造を1回だけ持ち帰る**ための診断整形。
 *
 * ⚠この診断は本番の登記情報提供サービス上で動く。表の**中身**（所在・地番・所有者）は
 * 個人情報および物件特定情報なので、**絶対にログへ出さない**。持ち帰るのは
 * 「どの表・ボタン・タブが在るか」という**構造だけ**。
 */
describe("safeLabel（見えている文字は許可リストだけ通す）", () => {
  it("⚠許可リストに無い文字はそのまま出さない（数字を含まないPIIも塞ぐ）", () => {
    // @codex #383 P1: 数字マスクだけでは所有者名・番地の無い町名が素通りしていた。
    expect(safeLabel("田中")).toBe("(他:2字)");
    expect(safeLabel("東京都千代田区丸の内")).toBe("(他:10字)");
    expect(safeLabel("井土ケ谷中町69-2")).not.toContain("井土ケ谷");
    expect(safeLabel("yamada@example.com")).toBe("(他:18字)");
  });

  it("サイトの固定文言はそのまま残る（構造の手がかりを潰さない）", () => {
    expect(safeLabel("請求")).toBe("請求");
    expect(safeLabel("請求種別")).toBe("請求種別");
    expect(safeLabel("マイページ")).toBe("マイページ");
    expect(safeLabel("未請求")).toBe("未請求");
  });

  it("空白を潰してから照合する", () => {
    expect(safeLabel("  請求 \n ")).toBe("請求");
  });

  it("空文字は空のまま", () => {
    expect(safeLabel("   ")).toBe("");
  });

  it("長さの上限を持つ（極端な値でもログを壊さない）", () => {
    expect(safeLabel("あ".repeat(5000))).toBe("(他:999字)");
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

  it("⚠英字だけの引数も通さない（氏名のローマ字が素通りしていた）", () => {
    // @codex #383 P1(2度目): 「短い英字なら安全」という推測が誤りだった。
    expect(maskProbeOnclick("showOwner('Yamada')")).toBe("showOwner('…6字')");
    expect(maskProbeOnclick("showOwner('Tanaka_Taro')")).toBe("showOwner('…11字')");
    expect(maskProbeOnclick("go('yamada@example.com')")).not.toContain("yamada");
  });

  it("通すのはタブの識別子だけ（診断に要るのはこれだけ）", () => {
    expect(isSafeOnclickArg("tabMy")).toBe(true);
    expect(isSafeOnclickArg("tabFudosan")).toBe(true);
    expect(isSafeOnclickArg("Yamada")).toBe(false);
    expect(isSafeOnclickArg("tab")).toBe(false);
    expect(isSafeOnclickArg("")).toBe(false);
  });

  it("未知のタブ名は文字数で分かる（必要になったら明示的に足せる）", () => {
    expect(maskProbeOnclick("selectTab('Mypage')")).toBe("selectTab('…6字')");
  });

  it("⚠引用符が閉じていない（途中で切れた）ものは失敗側に倒す", () => {
    // @codex #383 P1(3度目): 採取側が長い onclick を切り詰めると閉じ引用符が落ち、
    // 「引用符で囲まれた引数」の判定が一致せず中身が素通りしていた。
    const cut = "showOwner('Yamada_Taro_Very_Long_Name_That_Got_Truncated";
    const out = maskProbeOnclick(cut);
    expect(out).not.toContain("Yamada");
    expect(out).not.toContain("Taro");
    expect(out).toContain("showOwner");
    expect(hasUnbalancedQuotes(cut)).toBe(true);
    expect(hasUnbalancedQuotes("showOwner('Yamada')")).toBe(false);
  });

  it("引用符が1つも無いものは通常どおり扱う", () => {
    expect(hasUnbalancedQuotes("fuBtnForward()")).toBe(false);
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

  it("⚠表の中身が見出しに紛れても漏れない（許可リストに無いので文字数だけ）", () => {
    const out = formatRegistryPageProbe({
      ...base,
      tables: [{ id: "t1", headers: ["井土ケ谷中町69-2", "田中"], rowCount: 1 }],
    });
    expect(out).not.toContain("69-2");
    expect(out).not.toContain("井土ケ谷");
    expect(out).not.toContain("田中");
    expect(out).toContain("(他:");
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
