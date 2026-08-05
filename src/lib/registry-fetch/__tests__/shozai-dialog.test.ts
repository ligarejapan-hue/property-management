/**
 * 所在（地番区域）を「所在選択ダイアログ」で指定する仕組みの検証。
 *
 * 発注者判断 (2026-08-04): サイト推奨のダイアログ方式（B案）で直す。
 *
 * ⚠この機能の肝は**当てずっぽうで選ばない**こと。所在の取り違えは、後段の
 * 有料取得で**利用者が意図しない土地の謄本を買う**ことに直結する。
 * 決められないときは中止するのが正しい。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  matchDialogItemByPrefix,
  normalizeForMatch,
  parseSelectedPath,
  SHOZAI_DIALOG_BUTTON_SCOPE,
} from "@/lib/registry-fetch/shozai-dialog";

describe("normalizeForMatch — 表記ゆれを吸収する", () => {
  it("全角・空白を寄せる", () => {
    expect(normalizeForMatch("　南　区 ")).toBe("南区");
    expect(normalizeForMatch("１丁目")).toBe("1丁目");
  });

  it("⚠ケ/ヶ の揺れを吸収する（実在の地名で頻出）", () => {
    expect(normalizeForMatch("井土ケ谷中町")).toBe(
      normalizeForMatch("井土ヶ谷中町"),
    );
    expect(normalizeForMatch("青ヶ島村")).toBe(normalizeForMatch("青ケ島村"));
  });
});

describe("matchDialogItemByPrefix — サイトの一覧を正解として1段ずつ進む", () => {
  it("政令市 → 区 → 町 を順に消化する", () => {
    let rest = "横浜市南区井土ケ谷中町";
    const m1 = matchDialogItemByPrefix(
      [
        { id: "a", text: "横浜市" },
        { id: "b", text: "川崎市" },
      ],
      rest,
    );
    expect(m1?.item.id).toBe("a");
    rest = m1!.rest;

    const m2 = matchDialogItemByPrefix(
      [
        { id: "c", text: "南区" },
        { id: "d", text: "港南区" },
      ],
      rest,
    );
    expect(m2?.item.id).toBe("c");
    rest = m2!.rest;

    const m3 = matchDialogItemByPrefix(
      [{ id: "e", text: "井土ヶ谷中町" }],
      rest,
    );
    expect(m3?.item.id).toBe("e");
    expect(m3?.rest).toBe("");
  });

  it("⚠自治体名の途中に「市区町村郡」が入っていても壊れない (@codex #358 P2)", () => {
    // 自前で「市区町村郡」の字で切ると『東村山市』が『東村』『山市』に割れ、
    // どの段にも一致せず**その住所が永久に検索できなくなる**。
    // サイトの一覧に前方一致させる方式なら綴りを知らなくても正しく進む。
    for (const [addr, name] of [
      ["東村山市本町", "東村山市"],
      ["四日市市諏訪町", "四日市市"],
      ["大町市大町", "大町市"],
      ["郡山市朝日", "郡山市"],
      ["市川市市川", "市川市"],
    ] as const) {
      const m = matchDialogItemByPrefix([{ id: "x", text: name }], addr);
      expect(m, `${addr} が ${name} に一致しない`).not.toBeNull();
      expect(m!.rest).toBe(normalizeForMatch(addr).slice(name.length));
    }
  });

  it("⚠最長一致を採る（「大田」より「大田区」）", () => {
    const m = matchDialogItemByPrefix(
      [
        { id: "short", text: "大田" },
        { id: "long", text: "大田区" },
      ],
      "大田区田園調布",
    );
    expect(m?.item.id).toBe("long");
    expect(m?.rest).toBe("田園調布");
  });

  it("表記ゆれ（ケ/ヶ）でも一致する", () => {
    const m = matchDialogItemByPrefix(
      [{ id: "z", text: "井土ヶ谷中町" }],
      "井土ケ谷中町",
    );
    expect(m?.item.id).toBe("z");
  });

  it("⚠決められないときは選ばない（null）", () => {
    // 同じ名前が2つ＝どちらか分からない。勝手に選ぶと別の土地を買う。
    expect(
      matchDialogItemByPrefix(
        [
          { id: "A", text: "中央区" },
          { id: "B", text: "中央区" },
        ],
        "中央区銀座",
      ),
    ).toBeNull();
    // 一覧に無い
    expect(
      matchDialogItemByPrefix([{ id: "A", text: "南区" }], "北区赤羽"),
    ).toBeNull();
    // 空
    expect(matchDialogItemByPrefix([{ id: "A", text: "南区" }], "")).toBeNull();
    expect(matchDialogItemByPrefix([], "南区")).toBeNull();
  });

  it("⚠住所より長い選択肢は一致させない（先の段を飛ばさない）", () => {
    // 残りが「丸の内」なのに「丸の内一丁目」を選ぶと、実際とは違う丁目になる。
    expect(
      matchDialogItemByPrefix([{ id: "A", text: "丸の内一丁目" }], "丸の内"),
    ).toBeNull();
  });
});

describe("parseSelectedPath — 選択済みの階層", () => {
  it("「東京都>渋谷区>」を段に分ける", () => {
    expect(parseSelectedPath("東京都>渋谷区>")).toEqual(["東京都", "渋谷区"]);
  });

  it("空は空配列", () => {
    expect(parseSelectedPath("")).toEqual([]);
    expect(parseSelectedPath(">")).toEqual([]);
  });
});

describe("配線（実サイト probe 2026-08-05 の結果を固定）", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");
  const SRC = () => read("src/lib/registry-fetch/auto-fetch.ts");
  const DIALOG_FN = () =>
    SRC().match(/async function selectShozaiViaDialog[\s\S]*?\n\}/)?.[0] ?? "";

  it("採取したセレクタが入っている", () => {
    const s = SRC();
    expect(s).toMatch(/locationSelectButton: "#fuShozaiSentaku"/);
    expect(s).toMatch(/locationDialogArea: "#kuikiDialogArea"/);
    expect(s).toMatch(/locationDialogLoading: "\.GKuikiDialogWaitMsg"/);
    expect(s).toMatch(/locationDialogItem: '#kuikiDialogArea td\[id\^="GKuiki"\]'/);
    expect(s).toMatch(/locationSearchAddressCode: "#fuChibanKuikiCode"/);
  });

  it("⚠直接入力モードは使わない", () => {
    // 所在欄に住所を打ち込む方式は実機で「請求できない所在です」で止まる。
    const s = SRC();
    expect(s).not.toMatch(
      /page\.check\(REGISTRY_SELECTORS\.locationDirectInputCheck\)/,
    );
    expect(s).toMatch(/await selectShozaiViaDialog\(/);
  });

  it("⚠候補検索と有料取得の**両方**を組み替える", () => {
    // 片方だけ直すと、検索は通るのに取得で同じ理由で止まる。
    expect((SRC().match(/await selectShozaiViaDialog\(/g) ?? []).length).toBe(2);
  });

  it("⚠住所を自前の規則で切らない (@codex #358 P2)", () => {
    // 「市区町村郡」で切る方式は東村山市などで壊れる。サイトの一覧に当てる。
    const s = SRC();
    expect(s).toMatch(/matchDialogItemByPrefix\(items, remaining\)/);
    expect(s).not.toMatch(/splitLocationSegments/);
  });

  it("⚠都道府県は表示名ではなくコードで選ぶ", () => {
    // probe 実測: 選択肢の値は都道府県コード（東京都 = "13"）。表示名をそのまま
    // 渡すと選べず、所在選択ボタンが有効にならないまま「候補0件」に見える。
    const s = SRC();
    expect(s).toMatch(/async function selectPrefectureByLabel/);
    expect(s).toMatch(/await selectPrefectureByLabel\(page, prefecture\)/);
    expect(s).not.toMatch(
      /selectOption\(\s*REGISTRY_SELECTORS\.locationPrefectureSelect,\s*prefecture,/,
    );
    const fn =
      s.match(/async function selectPrefectureByLabel[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/RegistryFetchError\("location_rejected"\)/);
    // 都道府県名はログに出さない（所在の一部＝PII）
    expect(fn).toMatch(
      /console\.warn\("\[registry-search\] prefecture option not found"\)/,
    );
  });

  it("⚠所在は「都道府県を選んでから」でないと押せない", () => {
    // 初期状態のボタンは disabled。待たずに押すと無反応のまま先へ進む。
    expect(SRC()).toMatch(/b\.disabled !== true/);
  });

  it("⚠読み込み中の画面を掴まない", () => {
    // 中身は後から届く。器が出た時点で読むと「読み込み中・・・・」を掴む。
    expect(SRC()).toMatch(/locationDialogLoading/);
  });

  it("⚠段の切り替わりは「押す直前の表示」と比べる (@codex #358 P1)", () => {
    // ブラウザ側へ渡していない変数と比べると**常に真**になり、待たずに次の段へ
    // 進んで古い選択肢を読む＝多段の住所がすべて弾かれる。
    const fn = DIALOG_FN();
    expect(fn).toMatch(/before: was/);
    expect(fn).toMatch(/now !== was/);
    expect(fn).toMatch(/JSON\.stringify\(\{/);
    // 渡していない window 変数を参照しない
    expect(fn).not.toMatch(/__pmBefore/);
  });

  it("⚠ページ本体の「確定」と取り違えない", () => {
    // ページの確定(fuBtnForward)はカートに未請求の行を作る。ダイアログ内の
    // 確定は所在欄を埋めるだけ。文言が同じなので探す範囲で区別する。
    expect(SHOZAI_DIALOG_BUTTON_SCOPE).toBe(".ui-dialog-buttonpane button");
    expect(SRC()).toMatch(/SHOZAI_DIALOG_BUTTON_SCOPE/);
    const fn = DIALOG_FN();
    expect(fn).not.toMatch(/fuBtnForward/);
    expect(fn).not.toMatch(/requestConfirmButton/);
    expect(fn).not.toMatch(/myPageSeikyu/);
  });

  it("⚠決められない/確定できないときは取消で閉じてから止める", () => {
    // 開いたまま放置すると、次の操作がダイアログに食われる。
    const fn = DIALOG_FN();
    expect(fn).toMatch(/取消/);
    expect((fn.match(/await cancel\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(fn).toMatch(/RegistryFetchError\("location_rejected"\)/);
  });

  it("⚠所在欄が埋まったことを確かめてから次へ進む", () => {
    const fn = DIALOG_FN();
    expect(fn).toMatch(/locationSearchAddress/);
    expect(fn).toMatch(/value\.trim\(\)\.length > 0/);
  });

  it("⚠地名をログに出さない（PII 方針）", () => {
    const fn = DIALOG_FN();
    const warns = fn.match(/console\.warn\([\s\S]*?\);/g) ?? [];
    expect(warns.length).toBeGreaterThan(0);
    for (const w of warns) {
      expect(w).not.toMatch(/remaining|hit\.item\.text|items\[/);
    }
  });
});
