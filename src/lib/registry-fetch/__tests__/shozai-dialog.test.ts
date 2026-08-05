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
  normalizeForMatch,
  parseSelectedPath,
  pickDialogItem,
  splitLocationSegments,
  SHOZAI_DIALOG_BUTTON_SCOPE,
} from "@/lib/registry-fetch/shozai-dialog";

describe("splitLocationSegments — ダイアログで1段ずつ選ぶための断片", () => {
  it("政令市は 市 → 区 → 町 に分かれる", () => {
    // 断片は比較用に正規化された形で返る（ケ/ヶ は「ヶ」に寄る）。
    // 実際の照合も同じ正規化を通すので、表記が揃っていれば一致する。
    expect(splitLocationSegments("横浜市南区井土ケ谷中町")).toEqual([
      "横浜市",
      "南区",
      "井土ヶ谷中町",
    ]);
  });

  it("特別区は 区 → 丁目まで", () => {
    expect(splitLocationSegments("千代田区丸の内一丁目")).toEqual([
      "千代田区",
      "丸の内一丁目",
    ]);
  });

  it("郡部は 郡 → 町 に分かれる", () => {
    expect(splitLocationSegments("三浦郡葉山町")).toEqual(["三浦郡", "葉山町"]);
  });

  it("⚠丁目は切らない（サイト側が1項目として持つ）", () => {
    // 「丸の内」「一丁目」に割ると、どちらの段にも一致しなくなる。
    expect(splitLocationSegments("丸の内一丁目")).toEqual(["丸の内一丁目"]);
  });

  it("空文字は空配列", () => {
    expect(splitLocationSegments("")).toEqual([]);
    expect(splitLocationSegments("   ")).toEqual([]);
  });
});

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

describe("pickDialogItem — 選択肢から1つに決める", () => {
  const items = [
    { id: "GKuiki0", text: "南区" },
    { id: "GKuiki1", text: "西区" },
    { id: "GKuiki2", text: "港南区" },
  ];

  it("完全一致で選ぶ", () => {
    expect(pickDialogItem(items, "南区")?.id).toBe("GKuiki0");
  });

  it("⚠部分一致で別の区を掴まない（「南区」が「港南区」に化けない）", () => {
    // 「港南区」は「南区」を含むが、完全一致が1件あるのでそちらを採る。
    expect(pickDialogItem(items, "南区")?.text).toBe("南区");
  });

  it("表記ゆれ（ケ/ヶ）でも一致する", () => {
    const list = [{ id: "GKuiki9", text: "井土ヶ谷中町" }];
    expect(pickDialogItem(list, "井土ケ谷中町")?.id).toBe("GKuiki9");
  });

  it("⚠決められないときは選ばない（null）", () => {
    // 同名が複数＝どちらか分からない。勝手に選ぶと別の土地を買う。
    const dup = [
      { id: "A", text: "中央区" },
      { id: "B", text: "中央区" },
    ];
    expect(pickDialogItem(dup, "中央区")).toBeNull();
    // 候補に無い
    expect(pickDialogItem(items, "北区")).toBeNull();
    // 空
    expect(pickDialogItem(items, "")).toBeNull();
    expect(pickDialogItem([], "南区")).toBeNull();
  });

  it("前方一致が1件だけなら採る", () => {
    const list = [{ id: "X", text: "丸の内一丁目" }];
    expect(pickDialogItem(list, "丸の内一丁目")?.id).toBe("X");
  });

  it("⚠前方一致が複数なら採らない", () => {
    const list = [
      { id: "X", text: "丸の内一丁目" },
      { id: "Y", text: "丸の内二丁目" },
    ];
    expect(pickDialogItem(list, "丸の内")).toBeNull();
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
    expect(s).not.toMatch(/page\.check\(REGISTRY_SELECTORS\.locationDirectInputCheck\)/);
    // 所在の指定は必ずダイアログ経由
    expect(s).toMatch(/await selectShozaiViaDialog\(/);
  });

  it("⚠候補検索と有料取得の**両方**を組み替える", () => {
    // 片方だけ直すと、検索は通るのに取得で同じ理由で止まる。
    const s = SRC();
    expect((s.match(/await selectShozaiViaDialog\(/g) ?? []).length).toBe(2);
  });

  it("⚠都道府県は表示名ではなくコードで選ぶ", () => {
    // probe 実測: 選択肢の値は都道府県コード（東京都 = "13"）。住所から切り出せる
    // のは「東京都」という表示名なので、そのまま渡しても一致せず選べない。
    // 選べないと所在選択ボタンが有効にならず、所在が空のまま「候補0件」に見える。
    const s = SRC();
    expect(s).toMatch(/async function selectPrefectureByLabel/);
    expect(s).toMatch(/await selectPrefectureByLabel\(page, prefecture\)/);
    // 生の selectOption に表示名を直接渡していない
    expect(s).not.toMatch(
      /selectOption\(\s*REGISTRY_SELECTORS\.locationPrefectureSelect,\s*prefecture,/,
    );
    // 見つからないときは黙って進まない
    const fn = s.match(/async function selectPrefectureByLabel[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/RegistryFetchError\("location_rejected"\)/);
    // 都道府県名はログに出さない（所在の一部＝PII）
    expect(fn).toMatch(/console\.warn\("\[registry-search\] prefecture option not found"\)/);
  });

  it("⚠所在は「都道府県を選んでから」でないと押せない", () => {
    // 初期状態のボタンは disabled。待たずに押すと無反応のまま先へ進む。
    expect(SRC()).toMatch(/b\.disabled !== true/);
  });

  it("⚠読み込み中の画面を掴まない", () => {
    // 中身は後から届く。器が出た時点で読むと「読み込み中・・・・」を掴む。
    expect(SRC()).toMatch(/locationDialogLoading/);
  });

  it("⚠ページ本体の「確定」と取り違えない", () => {
    // ページの確定(fuBtnForward)はカートに未請求の行を作る。ダイアログ内の
    // 確定は所在欄を埋めるだけ。文言が同じなので探す範囲で区別する。
    expect(SHOZAI_DIALOG_BUTTON_SCOPE).toBe(".ui-dialog-buttonpane button");
    const s = SRC();
    expect(s).toMatch(/SHOZAI_DIALOG_BUTTON_SCOPE/);
    // ダイアログ操作の中で fuBtnForward を押していない
    const fn = s.match(/async function selectShozaiViaDialog[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).not.toMatch(/fuBtnForward/);
    expect(fn).not.toMatch(/requestConfirmButton/);
    expect(fn).not.toMatch(/myPageSeikyu/);
  });

  it("⚠決められない/確定できないときは取消で閉じてから止める", () => {
    // 開いたまま放置すると、次の操作がダイアログに食われる。
    const fn =
      SRC().match(/async function selectShozaiViaDialog[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/取消/);
    expect((fn.match(/await cancel\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(fn).toMatch(/RegistryFetchError\("location_rejected"\)/);
  });

  it("⚠所在欄が埋まったことを確かめてから次へ進む", () => {
    const fn =
      SRC().match(/async function selectShozaiViaDialog[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/locationSearchAddress/);
    expect(fn).toMatch(/value\.trim\(\)\.length > 0/);
  });

  it("⚠地名をログに出さない（PII 方針）", () => {
    const fn =
      SRC().match(/async function selectShozaiViaDialog[\s\S]*?\n\}/)?.[0] ?? "";
    const warns = fn.match(/console\.warn\([\s\S]*?\);/g) ?? [];
    expect(warns.length).toBeGreaterThan(0);
    for (const w of warns) {
      expect(w).not.toMatch(/segment|hit\.text|items\[/);
    }
  });
});
