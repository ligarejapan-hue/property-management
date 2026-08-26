/**
 * vitest は env=node（jsdom なし）なので renderToStaticMarkup + 文字列 assert で検証する。
 * クリックや state 遷移はここでは見られない（リポジトリの既定の作法）。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PasteImportReview, foldNoColumnFieldsIntoNote } from "../paste-import-review";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";

const draft = buildPasteDraft(
  "■査定ナンバー： SA-1\n■物件所在地： 東京都A区B1-2-3グリーンコート303\n" +
  "■物件名称： グリーンコート\n■お名前： 山田太郎",
);

const html = renderToStaticMarkup(
  createElement(PasteImportReview, { draft, rawText: "■物件所在地： 東京都A区B1-2-3" }),
);

/**
 * `data-field="X"` から次の `data-field="` の手前までを取り出す(その欄の描画ブロックだけ
 * を見るため)。「案内文がどこかに出た」ではなく「その欄の中に出た」ことを確かめたい。
 */
function extractFieldBlock(source: string, fieldKey: string): string {
  const marker = `data-field="${fieldKey}"`;
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const next = source.indexOf('data-field="', start + marker.length);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

/**
 * 「この内容で登録」ボタンの開始タグを取り出す。
 * ⚠**`/disabled/` で全体を検索してはいけない**。Button の className には
 *   `disabled:cursor-not-allowed` `disabled:opacity-60` が常に入っており、
 *   **無効化されていなくても必ず一致する**（空洞テストになる。実際に
 *   このリポの既存テストがこれで通っていた）。属性そのものを見る。
 */
function registerButtonTag(source: string): string {
  const labelAt = source.indexOf("この内容で登録");
  expect(labelAt).toBeGreaterThanOrEqual(0);
  const openAt = source.lastIndexOf("<button", labelAt);
  expect(openAt).toBeGreaterThanOrEqual(0);
  const closeAt = source.indexOf(">", openAt);
  return source.slice(openAt, closeAt + 1);
}

/** ボタンが本当に無効化されているか（属性 disabled="" が付いているか）。 */
function registerButtonDisabled(source: string): boolean {
  return registerButtonTag(source).includes('disabled=""');
}

describe("PasteImportReview（確認画面）", () => {
  it("拾えた値を表示する", () => {
    expect(html).toContain("東京都A区B1-2-3");
    expect(html).toContain("303");
  });

  it("★どの見出しから来たかを添える", () => {
    expect(html).toContain("物件所在地");
  });

  it("★元資料に無い欄は「元の資料に記載がありません」と出す", () => {
    expect(html).toContain("元の資料に記載がありません");
  });

  it("★地番が無いので謄本が取れない旨の警告を出す", () => {
    expect(html).toContain("地番がありません");
    expect(html).toContain("謄本");
  });

  it("貼った原文を並べて表示する", () => {
    expect(html).toContain("東京都A区B1-2-3");
  });

  it("送り元の名前を出す", () => {
    expect(html).toContain("HOME4U 査定依頼");
  });

  it("★推測で埋めた形跡がない（空欄の欄に値が入っていない）", () => {
    // 土地面積は元資料に無い → 数字が入っていないこと
    expect(html).not.toContain('data-field="landArea" data-value="');
  });
});

// ============================================================
// ここから下は Task 9 実装者が追加した検証。
// 「その部品が実際に制御していない文字列を assert しても、実装が壊れても
//  緑のまま」という repo の既知の罠(空洞テスト)を避けるため、
//  props を変えたときに出力が変わることまで確かめる形にしている。
// ============================================================

describe("PasteImportReview（3状態の描き分け・空洞テスト対策）", () => {
  it("要確認: 物件種別が判別できないときは警告文そのものが欄に添う（フィールド未定義なら失敗する)", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3\n■物件種別： 謎の種別X\n■お名前： 山田太郎",
    );
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, { draft: d, rawText: "" }),
    );
    // build-draft.ts が組み立てる警告文そのもの（実装が変われば文言も追随する）
    const warning = d.warnings.find((w) => w.code === "property_type_unknown");
    expect(warning).toBeTruthy();
    expect(out).toContain(warning!.message);
  });

  it("編集後の値（propertyValues）を渡すと、下書きの値ではなく渡した値が表示される", () => {
    const edited = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        propertyValues: {
          address: "東京都B区手直し後住所",
          lotNumber: "",
          buildingName: "",
          roomNo: "",
          propertyType: "",
          exclusiveArea: "",
          landArea: "",
          layoutType: "",
          occupancyStatus: "",
          builtYear: "",
        },
      }),
    );
    expect(edited).toContain("東京都B区手直し後住所");
    // 下書きが持っていた元の値(この fixture では必ず非nullの「東京都A区B1-2-3」)は、
    // propertyValues で上書きされて出ないことを確認する。
    // ⚠以前は `draft.property.address.value ?? "..."` という ?? フォールバックを使っていたが、
    //   左辺(address.value)はこの fixture では必ず非nullのため右辺(フォールバック)は
    //   絶対に通らない死コードだった。「前提が崩れても静かに空洞化する」書き方を避け、
    //   前提を明示的に assert してから使う。
    const originalAddress = draft.property.address.value;
    expect(originalAddress).not.toBeNull();
    expect(edited).not.toContain(originalAddress as string);
  });

  it("duplicates.blocked のとき、登録済みの断り文言と物件idへのリンクを出し、登録は無効になる", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        duplicates: { blocked: true, blockedByPropertyId: "prop-existing-1", similarPropertyIds: [] },
      }),
    );
    expect(out).toContain("この案件は登録済みです");
    expect(out).toContain("/properties/prop-existing-1");
    // ⚠登録ボタンの**属性**を見る(className の disabled:… に当たる空洞テストにしない)
    expect(registerButtonDisabled(out)).toBe(true);
  });

  it("similar が非空のとき、類似物件の一覧（住所つき）をブロックせずに出す", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        similar: [{ id: "prop-similar-1", address: "東京都C区similar住所", lotNumber: null }],
        duplicates: { blocked: false, blockedByPropertyId: null, similarPropertyIds: ["prop-similar-1"] },
      }),
    );
    expect(out).toContain("東京都C区similar住所");
    expect(out).toContain("/properties/prop-similar-1");
    // ブロックはされない = 「この案件は登録済みです」は出ない
    expect(out).not.toContain("この案件は登録済みです");
  });

  it("ownerCandidates の3種類のラベルを、日本語で見分けられる文言にする", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        ownerCandidates: [
          { id: "o1", name: "山田太郎", matchKind: "current_address" },
          { id: "o2", name: "山田太郎", matchKind: "registry_address" },
          { id: "o3", name: "山田太郎", matchKind: "name_only" },
        ],
      }),
    );
    expect(out).toContain("連絡先の住所も一致");
    expect(out).toContain("登記上の住所と一致");
    expect(out).toContain("氏名だけ一致（同姓同名の別人かもしれません）");
  });

  it("所有者なしで登録する選択肢が常に存在する", () => {
    expect(html).toContain("所有者なしで登録する");
  });
});

// ============================================================
// レビュー指摘(Critical/Important)対応: 土地面積・築年は Property に対応する
// DB 列が無い(commit API の契約にも無い)。値を無言で捨てず備考へ回す。
// 「builtYear は Property の列として実在する」というレビュー時点の指摘は誤りだった
// (schema.prisma の builtYear は Building モデルの列。Property モデルには存在しない。
//  `awk '/^model Property \{/,/^\}/' prisma/schema.prisma | grep -i built` はヒット無し)。
// このため builtYear も landArea と同じ扱い(備考へ行を足す)にした。
// ============================================================

describe("foldNoColumnFieldsIntoNote(土地面積・築年を備考へ畳み込む純関数)", () => {
  it("両方空なら備考をそのまま返す(空行を作らない)", () => {
    expect(foldNoColumnFieldsIntoNote("既存の備考", { landArea: "", builtYear: "" })).toBe(
      "既存の備考",
    );
  });

  it("土地面積だけあれば行を1つ足す(既存の備考は消えない)", () => {
    expect(foldNoColumnFieldsIntoNote("既存の備考", { landArea: "120.5", builtYear: "" })).toBe(
      "既存の備考\n土地面積: 120.5",
    );
  });

  it("築年だけあれば行を1つ足す", () => {
    expect(foldNoColumnFieldsIntoNote("既存の備考", { landArea: "", builtYear: "1998" })).toBe(
      "既存の備考\n築年: 1998",
    );
  });

  it("両方あれば2行とも足す(備考が空でも先頭に空行を作らない)", () => {
    expect(foldNoColumnFieldsIntoNote("", { landArea: "120.5", builtYear: "1998" })).toBe(
      "土地面積: 120.5\n築年: 1998",
    );
  });
});

describe("画面: 専用の欄が無い旨の案内(空洞テスト対策=その欄のブロック内に限定して確認)", () => {
  it("土地面積の欄のブロック内に案内が出る", () => {
    const block = extractFieldBlock(html, "landArea");
    expect(block).not.toBe("");
    expect(block).toContain("専用の欄が無いため、備考に記録されます");
  });

  it("築年の欄のブロック内に案内が出る", () => {
    const block = extractFieldBlock(html, "builtYear");
    expect(block).not.toBe("");
    expect(block).toContain("専用の欄が無いため、備考に記録されます");
  });

  it("住所など、対応する列がある欄には案内が出ない(過剰表示になっていない)", () => {
    const block = extractFieldBlock(html, "address");
    expect(block).not.toBe("");
    expect(block).not.toContain("専用の欄が無いため");
  });
});

describe("備考の見え方についての断り書き（全体レビュー I-7）", () => {
  it("★備考欄に「この物件を見られる人全員に表示される」旨が出る", () => {
    // 備考には辞書に無かった見出し(実サンプルでは「年齢」)がそのまま入る。
    // 除外はしない発注者判断のため、せめて見え方を伝える。
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3\n■年齢： 71 歳\n■お名前： 山田太郎",
    );
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, { draft: d, rawText: "" }),
    );
    // 断り書きが、備考の入力欄そのものに結び付いていること(どこか遠くの
    // 文言では意味がない)。
    expect(out).toContain('aria-describedby="paste-field-note-visibility"');
    expect(out).toContain('id="paste-field-note-visibility"');
    expect(out).toContain("この物件を見られる人全員に表示されます");
    // 備考にその値が実際に入っていること(断り書きが空振りでないことの裏取り)。
    expect(d.noteFromUnmapped).toContain("年齢");
  });
});

const NL = "\n";

describe("登録済みの断り帯は id が無くても出る（再レビュー Important）", () => {
  it("★担当外の物件でブロックされた場合（id が null）でも、赤帯と文言が出る", () => {
    // サーバー(/api/import/paste)は「ブロック相手が担当外なら blocked は残して
    // id だけ null」を返す。id を条件にすると帯が消え、押せない灰色のボタンだけが
    // 残る(理由は title 属性のみ＝スマホでは出ない)。
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        duplicates: { blocked: true, blockedByPropertyId: null, similarPropertyIds: [] },
      }),
    );
    expect(out).toContain("この案件は登録済みです");
    expect(out).toContain("担当外のため開けません");
    // 開けない物件へのリンクは出さない。
    expect(out).not.toContain("既存の物件を見る");
    expect(out).not.toContain("/properties/");
  });

  it("id があるときは従来どおりリンクを出し、担当外の断りは出さない", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        duplicates: { blocked: true, blockedByPropertyId: "prop-x", similarPropertyIds: [] },
      }),
    );
    expect(out).toContain("/properties/prop-x");
    expect(out).toContain("既存の物件を見る");
    expect(out).not.toContain("担当外のため開けません");
  });

  it("blocked でなければ帯は出ない（出しっぱなしになっていない）", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        duplicates: { blocked: false, blockedByPropertyId: null, similarPropertyIds: [] },
      }),
    );
    expect(out).not.toContain("この案件は登録済みです");
  });
});

describe("読み取れなかった行(unlabeled)を原文側に出す（再レビュー Minor c）", () => {
  it("★区切りの無い行が確認画面に出る（下書きに持つだけで終わらせない）", () => {
    const d = buildPasteDraft(
      "この物件についてのご相談です" + NL +
      "■物件所在地： 東京都A区B1-2-3" + NL +
      "至急ご連絡ください",
    );
    expect(d.unlabeled).toEqual(["この物件についてのご相談です", "至急ご連絡ください"]);
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, { draft: d, rawText: "" }),
    );
    // rawText は空にしてあるので、この2行が出るのは unlabeled を描いているから。
    expect(out).toContain('data-section="unlabeled"');
    expect(out).toContain("この物件についてのご相談です");
    expect(out).toContain("至急ご連絡ください");
    expect(out).toContain("項目として読み取れなかった行（2行）");
  });

  it("読み取れなかった行が無ければ、その区画ごと出さない", () => {
    const d = buildPasteDraft("■物件所在地： 東京都A区B1-2-3");
    expect(d.unlabeled).toEqual([]);
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, { draft: d, rawText: "" }),
    );
    expect(out).not.toContain('data-section="unlabeled"');
    expect(out).not.toContain("項目として読み取れなかった行");
  });
});

describe("「新しい所有者として登録する」のまま氏名が空なら登録を止める（4巡目 ②）", () => {
  const emptyOwner = {
    name: "", nameKana: "ヤマダタロウ", phone: "09012345678",
    email: "a@example.jp", currentAddress: "東京都A区B1-2-3",
  };

  it("★氏名が空なら登録ボタンが無効で、理由が画面に出る", () => {
    // 以前は氏名を消した瞬間に owner が null に落ち、**所有者なしで登録が成功**して
    // 入力済みの電話・メール・住所も捨てられていた（画面は「新しい所有者として
    // 登録する」を選んだままなのに）。「所有者なしで登録する」は別の選択肢。
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft, rawText: "", ownerMode: "new", ownerValues: emptyOwner,
      }),
    );
    expect(registerButtonDisabled(out)).toBe(true);
    // ⚠**画面に文字で出ている**ことを見る(title 属性にも同じ趣旨の文が入るので、
    //   素の toContain だと title だけでも通ってしまう)。要素の中身として出る
    //   句点つきの言い回しを、開き山括弧の直後で照合する。
    expect(out).toContain(">所有者の氏名を入力してください。");
    expect(out).toContain('role="alert"');
  });

  it("★氏名があれば止めない（止めすぎていない）", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft, rawText: "", ownerMode: "new",
        ownerValues: { ...emptyOwner, name: "山田太郎" },
      }),
    );
    expect(out).not.toContain(">所有者の氏名を入力してください。");
    expect(registerButtonDisabled(out)).toBe(false);
  });

  it("★「所有者なしで登録する」を選んでいれば、氏名が空でも止めない", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft, rawText: "", ownerMode: "none", ownerValues: emptyOwner,
      }),
    );
    expect(out).not.toContain(">所有者の氏名を入力してください。");
    expect(registerButtonDisabled(out)).toBe(false);
  });

  it("登録済みでブロックされているときは、そちらの理由を優先して出す", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft, rawText: "", ownerMode: "new", ownerValues: emptyOwner,
        duplicates: { blocked: true, blockedByPropertyId: "p1", similarPropertyIds: [] },
      }),
    );
    expect(out).toContain("この案件は登録済みです");
    expect(out).not.toContain(">所有者の氏名を入力してください。");
    expect(registerButtonDisabled(out)).toBe(true);
  });
});
