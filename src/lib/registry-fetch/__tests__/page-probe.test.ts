import { describe, expect, it } from "vitest";

import {
  KNOWN_PROBE_SELECTORS,
  formatRegistryPageProbe,
  hasUnbalancedQuotes,
  SAFE_ONCLICK_ARGS,
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
    expect(maskProbeOnclick("go(12345, 67)")).toBe("(不明:2字)(＊)");
  });

  it("関数名は残る＝セレクタの手がかりを潰さない", () => {
    // ⚠selectTab/tabMy は旧マイページ遷移ごと撤去(2026-08-18 直接請求化)=
    // 名前も引数も許可リストから外れ、どちらも文字数だけになる(推測で残さない)。
    expect(maskProbeOnclick("selectTab('tabMy')")).toBe("(不明:9字)('…5字')");
    expect(maskProbeOnclick("fuBtnForward()")).toBe("fuBtnForward()");
    // ⚠数字入りの既知名が名前ごと潰れないこと(2026-08-17):
    // かつては数字潰しが名前より先に走り `…Type＊` になって一致しなかった。
    expect(maskProbeOnclick("cbnDlgChibanType0()")).toBe("cbnDlgChibanType0()");
    // 数字入りでも**未知**の名前は従来どおり文字数だけ(許可リスト方式は不変)。
    expect(maskProbeOnclick("owner2Show('Yamada')")).toBe(
      "(不明:10字)('…6字')",
    );
  });

  it("⚠バッククォート（テンプレート文字列）も通さない", () => {
    // @codex #383 P1(4度目): ' と " しか見ておらず ` が素通りしていた。
    expect(maskProbeOnclick("showOwner(`Yamada`)")).toBe("(不明:9字)('…6字')");
    expect(maskProbeOnclick("go(`井土ケ谷中町`)")).not.toContain("井土ケ谷");
  });

  it("⚠関数呼び出しの形でないものは出さない（未知の書き方に負けない）", () => {
    expect(maskProbeOnclick("Yamada")).toBe("(不明な形式)");
    expect(maskProbeOnclick("this.x='田中'")).toBe("(不明な形式)");
    expect(maskProbeOnclick("")).toBe("(不明な形式)");
  });

  it("⚠英字だけの引数も通さない（氏名のローマ字が素通りしていた）", () => {
    // @codex #383 P1(2度目): 「短い英字なら安全」という推測が誤りだった。
    expect(maskProbeOnclick("showOwner('Yamada')")).toBe("(不明:9字)('…6字')");
    expect(maskProbeOnclick("showOwner('Tanaka_Taro')")).toBe("(不明:9字)('…11字')");
    expect(maskProbeOnclick("go('yamada@example.com')")).not.toContain("yamada");
  });

  it("通すのは列挙した識別子だけ（前方一致にしない）", () => {
    // @codex #383 P1(6度目): `^tab...` の前方一致だと人名 tabitha が通った。
    // 'tabMy' も myPageTab 撤去(probe13)でリストから外れた=今は空。
    expect(isSafeOnclickArg("tabMy")).toBe(false);
    expect(isSafeOnclickArg("tabitha")).toBe(false);
    expect(isSafeOnclickArg("tabFudosan")).toBe(false); // 未確認の値は足さない
    expect(isSafeOnclickArg("Yamada")).toBe(false);
    expect(isSafeOnclickArg("tab")).toBe(false);
    expect(isSafeOnclickArg("")).toBe(false);
  });

  it("⚠tab で始まる人名も伏せる", () => {
    expect(maskProbeOnclick("showOwner('tabitha')")).toBe("(不明:9字)('…7字')");
    expect(maskProbeOnclick("showOwner('tabata')")).not.toContain("tabata");
  });

  it("許可リストは実際に参照しているセレクタの値だけ（推測で足さない）", () => {
    // myPageTab 撤去(probe13)以降、コードがセレクタとして参照する引数値はゼロ。
    expect([...SAFE_ONCLICK_ARGS]).toEqual([]);
  });

  it("未知のタブ名は文字数で分かる（必要になったら明示的に足せる）", () => {
    expect(maskProbeOnclick("myPageDownload('Mypage')")).toBe(
      "myPageDownload('…6字')",
    );
  });

  it("⚠引用符が閉じていない（途中で切れた）ものは失敗側に倒す", () => {
    // @codex #383 P1(3度目): 採取側が長い onclick を切り詰めると閉じ引用符が落ち、
    // 「引用符で囲まれた引数」の判定が一致せず中身が素通りしていた。
    const cut = "showOwner('Yamada_Taro_Very_Long_Name_That_Got_Truncated";
    const out = maskProbeOnclick(cut);
    expect(out).not.toContain("Yamada");
    expect(out).not.toContain("Taro");
    expect(out).not.toContain("showOwner");
    expect(out).toContain("切れた引数は伏せました");
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
      buttons: [{ id: "btn_seikyu", label: "請求", disabled: true }],
    });
    expect(out).toContain("btn_seikyu");
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
    // ⚠未知の関数名も伏せる（@codex #383 P1・7度目）。
    expect(out).not.toContain("showDetail");
    expect(out).toContain("(不明:");
  });

  it("タブは onclick を関数名まで出す（セレクタ特定の要・引数は許可リスト制）", () => {
    const out = formatRegistryPageProbe({
      ...base,
      tabs: [{ label: "マイページ", onclick: "selectTab('tabMy')" }],
    });
    // selectTab/tabMy は撤去済み=名前も引数も文字数だけになる(残っている
    // 既知名 myPageDownload 等はそのまま出る)。
    expect(out).toContain("(不明:9字)(");
    expect(out).toContain("'…5字'");
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

describe("⚠この診断は「知りたいこと」に答えられるか（作って役に立たない、を防ぐ）", () => {
  it("確定後に請求リスト画面で止まった場合、次の一手が決められる情報が出る", () => {
    // 2026-08-16 の立ち会いで実際に起きた状況を想定して整形する。
    // 表の中には所在・地番・所有者が居るが、診断はそこを読まない。
    const out = formatRegistryPageProbe({
      tables: [
        { id: "fudosanIchiranTbl", headers: ["請求種別", "所在", "地番"], rowCount: 1 },
        { id: "seikyuNaiyoTbl", headers: ["全部事項", "所有者事項"], rowCount: 0 },
      ],
      buttons: [
        { id: "fuBtnForward", onclick: "", label: "確定", disabled: false },
        { id: "seikyuJikkou", onclick: "", label: "請求", disabled: false },
      ],
      tabs: [
        { label: "マイページ", onclick: "selectTab('tabMy')" },
        { label: "不動産請求", onclick: "selectTab('tabFudosan')" },
      ],
      known: {
        "#myPageTable": false,
        "#btn_seikyu": false,
        "#fudosanIchiranTbl": true,
        "a[onclick*=\"selectTab('tabMy')\"]": true,
      },
    });

    // ①どの画面に居るか: 請求リストは在り、マイページの一覧は無い。
    expect(out).toContain("#fudosanIchiranTbl=yes");
    expect(out).toContain("#myPageTable=no");
    // ②マイページのタブ自体は在る＝セレクタは合っている（押しても一覧が出ないのが問題）。
    expect(out).toContain("selectTab('tabMy')\"]=yes");
    // ③いまの画面に「請求」ボタンが在る＝id は想定と違うが**表示名で狙える**。
    //   これが「マイページへ行かず、この画面で請求する」という修正方針の根拠になる。
    expect(out).toMatch(/\(不明:\d+字\)\[請求\]/);
    expect(out).toContain("#btn_seikyu=no");

    // ⚠それでいて、表の中身は1文字も出ていない。
    for (const leak of ["井土ケ谷", "田中", "69-2"]) expect(out).not.toContain(leak);
  });
});

describe("KNOWN_PROBE_SELECTORS", () => {
  it("マイページ遷移の失敗を切り分けるのに要る4つを含む", () => {
    for (const sel of [
      "#myPageTable",
      "#btn_seikyu",
      "#fudosanIchiranTbl",
      "#siborikomi",
    ]) {
      expect(KNOWN_PROBE_SELECTORS).toContain(sel);
    }
  });
});
