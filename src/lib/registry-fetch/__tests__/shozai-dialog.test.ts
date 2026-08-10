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
  dedupeShozaiDialogItems,
  expandLeadingChome,
  isChomeOnlyLevel,
  looksLikeLotTail,
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

describe("⚠タブ重複 — 区域のtdは全部タブ+五十音タブでDOMに2回ずつ現れる(2026-08-07 本番実障害)", () => {
  // 実障害: 神奈川県の1段目でtdが126件列挙され、「横浜市」が全部タブと
  // 五十音タブの2箇所にあるため「同名2件=決められない」で**すべての住所が
  // 中止**になった。区域コード(onclick第1引数)が同じなら同じ区域のコピー
  // なので、1件に畳んでから決める。
  it("同名でもコードが同じなら1件に畳んで決める", () => {
    const m = matchDialogItemByPrefix(
      [
        { id: "GKuiki0", text: "横浜市", code: "201", visible: true },
        { id: "GKuiki1", text: "川崎市", code: "202", visible: true },
        { id: "GKuiki63", text: "横浜市", code: "201", visible: false },
        { id: "GKuiki64", text: "川崎市", code: "202", visible: false },
      ],
      "横浜市南区井土ケ谷中町69-2",
    );
    expect(m?.item.id).toBe("GKuiki0");
    expect(m?.rest).toBe(normalizeForMatch("南区井土ケ谷中町69-2"));
  });

  it("見えているコピーを選ぶ（クリックできるのは見えている方）", () => {
    const m = matchDialogItemByPrefix(
      [
        { id: "hidden", text: "横浜市", code: "201", visible: false },
        { id: "shown", text: "横浜市", code: "201", visible: true },
      ],
      "横浜市南区",
    );
    expect(m?.item.id).toBe("shown");
  });

  it("⚠同名でもコードが違えば畳まない（取り違えは中止に倒す）", () => {
    expect(
      matchDialogItemByPrefix(
        [
          { id: "A", text: "中央区", code: "101" },
          { id: "B", text: "中央区", code: "102" },
        ],
        "中央区銀座",
      ),
    ).toBeNull();
  });

  it("⚠コードが読めない同名重複も畳まない（既存の安全動作を維持）", () => {
    expect(
      matchDialogItemByPrefix(
        [
          { id: "A", text: "中央区" },
          { id: "B", text: "中央区", code: "101" },
        ],
        "中央区銀座",
      ),
    ).toBeNull();
  });

  it("dedupeShozaiDialogItems — 畳んだ後も並び順は最初の出現位置を保つ", () => {
    const out = dedupeShozaiDialogItems([
      { id: "a", text: "横浜市", code: "201", visible: false },
      { id: "b", text: "川崎市", code: "202", visible: true },
      { id: "c", text: "横浜市", code: "201", visible: true },
    ]);
    expect(out.map((x) => x.id)).toEqual(["c", "b"]);
  });
});

describe("⚠実際の住所表記で通ること (@codex #358 P2)", () => {
  // サイトの一覧は「丸の内一丁目」(漢数字)。アプリの住所は「丸の内1丁目」や
  // 「丸の内1-1-1」(郵便表記)が普通。そろえないと**ごく一般的な住所が
  // すべて弾かれる**。
  const items = [{ id: "A", text: "丸の内一丁目" }];

  it("算用数字の丁目が漢数字の一覧に一致する", () => {
    const m = matchDialogItemByPrefix(items, "丸の内1丁目");
    expect(m?.item.id).toBe("A");
    expect(m?.rest).toBe("");
  });

  it("郵便表記（1-1-1）でも丁目として一致し、残りは地番になる", () => {
    const m = matchDialogItemByPrefix(items, "丸の内1-1-1");
    expect(m?.item.id).toBe("A");
    expect(m?.rest).toBe("1-1");
  });

  it("十丁目以上も扱える", () => {
    const m = matchDialogItemByPrefix(
      [{ id: "B", text: "西新宿十丁目" }],
      "西新宿10丁目",
    );
    expect(m?.item.id).toBe("B");
  });

  it("⚠地番そのものを丁目と誤読しない", () => {
    // 区域の一覧に無い「1-1」を丁目に化かして別の区域を選ばない。
    expect(matchDialogItemByPrefix(items, "1-1")).toBeNull();
  });

  it("looksLikeLotTail — 数字だけの残りは地番（区域ではない）", () => {
    expect(looksLikeLotTail("1-1")).toBe(true);
    expect(looksLikeLotTail("1番2の3")).toBe(true);
    expect(looksLikeLotTail("")).toBe(true);
    // 地名が残っているのは別の段がある証拠なので地番ではない
    expect(looksLikeLotTail("井土ヶ谷中町")).toBe(false);
    expect(looksLikeLotTail("丸の内1丁目")).toBe(false);
  });
});

describe("⚠丁目だけが並ぶ段 — 町名の次に「一丁目」「二丁目」…が出る作り(2026-08-10 本番実障害)", () => {
  // 実障害: 「東京都世田谷区若林2-18-3」で、区→町名まで降りた後に丁目だけの
  // 段が出る。残り「2-18-3」を**地番とみなして降りるのをやめて**しまい、
  // 丁目を選び残したままダイアログの「確定」が有効にならず中止していた
  // (ログ: shozai dialog: fix button not enabled)。
  const chome = [
    { id: "A", text: "一丁目", code: "1" },
    { id: "B", text: "二丁目", code: "2" },
    { id: "C", text: "三丁目", code: "3" },
  ];

  it("郵便表記の残り「2-18-3」から丁目を読み取って選ぶ（残りは地番）", () => {
    const m = matchDialogItemByPrefix(chome, "2-18-3");
    expect(m?.item.id).toBe("B");
    expect(m?.rest).toBe("18-3");
  });

  it("「2丁目18-3」のように丁目付きの表記はそのまま一致する", () => {
    const m = matchDialogItemByPrefix(chome, "2丁目18-3");
    expect(m?.item.id).toBe("B");
    expect(m?.rest).toBe("18-3");
  });

  it("残りが丁目だけ（「2」）でも選べる", () => {
    const m = matchDialogItemByPrefix(chome, "2");
    expect(m?.item.id).toBe("B");
    expect(m?.rest).toBe("");
  });

  it("⚠一覧に無い丁目は選ばない（当てずっぽう禁止＝取り違え防止）", () => {
    expect(matchDialogItemByPrefix(chome, "9-18-3")).toBeNull();
  });

  it("⚠地名が並ぶ段では数字を丁目と読み替えない", () => {
    // 「18-3」を「18丁目」と読み替えて、無関係な区域を選ばない。
    const towns = [
      { id: "T", text: "若林" },
      { id: "U", text: "三軒茶屋" },
    ];
    expect(matchDialogItemByPrefix(towns, "18-3")).toBeNull();
  });

  it("isChomeOnlyLevel — 丁目だけの一覧かを見分ける", () => {
    expect(isChomeOnlyLevel(chome)).toBe(true);
    expect(isChomeOnlyLevel([{ id: "A", text: "十丁目" }])).toBe(true);
    // 地名が混ざる段は「丁目だけ」ではない（読み替えを適用しない）
    expect(
      isChomeOnlyLevel([
        { id: "A", text: "若林" },
        { id: "B", text: "二丁目" },
      ]),
    ).toBe(false);
    expect(isChomeOnlyLevel([])).toBe(false);
  });

  it("expandLeadingChome — 先頭の数字だけを丁目として読む", () => {
    expect(expandLeadingChome("2-18-3")).toBe("2丁目18-3");
    expect(expandLeadingChome("2")).toBe("2丁目");
    // 丁目が既に書かれている・地名から始まるものには触らない
    expect(expandLeadingChome("2丁目18-3")).toBe("2丁目18-3");
    expect(expandLeadingChome("若林2-18-3")).toBe("若林2-18-3");
    expect(expandLeadingChome("")).toBe("");
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
    // 「市区町村郡」で切る方式は東村山市などで壊れる。サイトの一覧に当てる
    // (タブ重複を畳んだ deduped を渡す=2026-08-07 実障害対応)。
    const s = SRC();
    expect(s).toMatch(/matchDialogItemByPrefix\(deduped, remaining\)/);
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

  it("⚠分類済みの失敗を「外部サービスの障害」に潰さない (@codex #358 P2)", () => {
    // 所在が決められなかった(location_rejected)のに 502 で返すと、画面に
    // 「住所を直せば通る」という案内が出ず、利用者は原因が分からないまま
    // **有料の取得を押し直す**。候補検索側・有料取得側の両方で素通しする。
    const s = SRC();
    // catch で provider_error に変換している箇所は、直前に素通しの門がある
    const blocks = s.match(
      /\} catch \(err\) \{[\s\S]{0,700}?throw new RegistryFetchError\("provider_error"\);\s*\n\s*\}/g,
    ) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const b of blocks) {
      expect(
        b,
        "catch が RegistryFetchError を素通ししていない",
      ).toMatch(/if \(err instanceof RegistryFetchError\) throw err;/);
    }
  });

  it("⚠都道府県が無い住所はダイアログを開く前に止める (@codex #358 P2)", () => {
    // 所在選択ボタンは都道府県を選ぶまで押せない。無いまま進むと待ち続け、
    // 最後は「外部サービスの障害」に化ける。実際は住所を直せば通る話。
    const s = SRC();
    expect(s).toMatch(/if \(!prefecture\) \{/);
    expect(s).toMatch(
      /console\.warn\("\[registry-search\] address has no prefecture"\)/,
    );
    // 候補検索・有料取得の両方
    expect((s.match(/address has no prefecture/g) ?? []).length).toBe(2);
  });

  it("⚠残りが地番だけなら所在を弾かない (@codex #358 P2) — ただし確定できない段では降り続ける", () => {
    // 区域を選び終えた後に数字だけ残るのは正常（地番は別の欄）。
    // ⚠ただしサイトが canFix=NO を返している間は**まだ段が残っている**
    //   (丁目の選び残し=2026-08-10 本番実障害)。地番と早合点して抜けない。
    expect(SRC()).toMatch(
      /if \(!hit && looksLikeLotTail\(remaining\) && canFix !== "NO"\) \{/,
    );
  });

  it("⚠「確定」が押せるかはサイトの canFix を見る（実サイトJS GKuikiDialogSetButtonStatus）", () => {
    // 実サイトは #canFix の値が "YES" のときだけ確定ボタンを有効化する。
    // これが「最後の段まで降り切れたか」の唯一の正解。
    expect(SRC()).toMatch(/locationDialogCanFix: "#kuikiDialogArea #canFix"/);
    expect(DIALOG_FN()).toMatch(/locationDialogCanFix/);
  });

  it("⚠ボタンの状態より先に所在欄を見る（最終段は押した時点で欄が埋まり閉じる）", () => {
    // 実サイトJS: 最終段の区域の onclick は GKuikiDialogFixed で、押すと
    // 所在欄を埋めてダイアログを閉じる。このとき確定ボタンはもう押せないが
    // **所在の選択は成功している**。順序を逆にすると成功を失敗と報告する。
    const fn = DIALOG_FN();
    const fillIdx = fn.indexOf("alreadyFilled");
    const btnIdx = fn.indexOf("fix button not enabled");
    expect(fillIdx).toBeGreaterThan(-1);
    expect(btnIdx).toBeGreaterThan(-1);
    expect(fillIdx).toBeLessThan(btnIdx);
  });

  it("⚠段の上限を持つ（サイトの作りが変わっても待ち続けない）", () => {
    // 住所の残りは1段ごとに必ず短くなるので理屈の上では止まるが、上限が無いと
    // サイト側の変更で無限に回り「外部サービスの障害」に化ける。
    expect(SRC()).toMatch(/const MAX_SHOZAI_DIALOG_DEPTH = \d+;/);
    expect(DIALOG_FN()).toMatch(/depth > MAX_SHOZAI_DIALOG_DEPTH/);
  });

  it("⚠失敗ログにどの段で止まったかを残す（地名は残さない）", () => {
    const fn = DIALOG_FN();
    expect(fn).toMatch(/depth=/);
    expect(fn).toMatch(/canFix=/);
  });

  it("⚠地名をログに出さない（PII 方針）", () => {
    const fn = DIALOG_FN();
    const warns = fn.match(/console\.warn\([\s\S]*?\);/g) ?? [];
    expect(warns.length).toBeGreaterThan(0);
    for (const w of warns) {
      expect(w).not.toMatch(/remaining|hit\.item\.text|items\[/);
    }
  });

  it("⚠タブ重複を配線でも畳む — 可視性と区域コードを読み取り dedupe を通す(2026-08-07 実障害)", () => {
    const fn = DIALOG_FN();
    // 区域のtdは全タブ分がDOMに同時に存在する(隠れタブ= ui-tabs-hide)。
    expect(fn).toContain('closest(".ui-tabs-hide")');
    // onclick 第1引数 = 区域コード(同名の別区域と区別する唯一の手がかり)。
    expect(fn).toContain('getAttribute("onclick")');
    expect(fn).toContain("dedupeShozaiDialogItems(");
  });

  it("⚠毎段「全部」タブへ寄せる（既定の選択タブはサーバー次第で五十音になり得る）", () => {
    expect(DIALOG_FN()).toContain("locationDialogAllTab");
  });

  it("⚠見えないコピーしか選べなかったときは DOM click で押す（不可視要素は page.click が固まる）", () => {
    expect(DIALOG_FN()).toMatch(/visible === false/);
  });
});
