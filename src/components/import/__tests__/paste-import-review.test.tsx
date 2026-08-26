/**
 * vitest は env=node（jsdom なし）なので renderToStaticMarkup + 文字列 assert で検証する。
 * クリックや state 遷移はここでは見られない（リポジトリの既定の作法）。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PasteImportReview,
  foldNoColumnFieldsIntoNote,
  DUPLICATE_INPUT_FIELDS,
  DUPLICATE_OWNER_FIELDS,
  ownerCandidateLabel,
  stripFilledRawLines,
  hasOwnerMatchWeakened,
  ownerMatchStrength,
  hasMatchKindWeakened,
} from "../paste-import-review";
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
          { id: "o1", name: "山田太郎", matchKind: "current_address", address: "東京都A区1-1", addressKind: "current" as const, propertyCount: 1 },
          { id: "o2", name: "山田太郎", matchKind: "registry_address", address: "東京都B区2-2", addressKind: "registry" as const, propertyCount: 2 },
          { id: "o3", name: "山田太郎", matchKind: "name_only", address: null, addressKind: null, propertyCount: 0 },
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
    // 備考には辞書に無かった見出し(所有者の個人情報**以外**)がそのまま入る。
    // ⚠「年齢」は11巡目 ① で備考から外した(所有者の個人情報＝項目別権限の迂回路)。
    //   ここで見たいのは「備考に入るものについて見え方を伝える」ことなので、
    //   所有者と無関係な見出し(建物構造)を使う。
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3\n■建物構造： 木造スレート葺\n■お名前： 山田太郎",
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
    expect(d.noteFromUnmapped).toContain("建物構造");
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

describe("査定ナンバー(外部キー)を確認・修正できる（6巡目 ①）", () => {
  it("★読み取った査定ナンバーが編集欄として出る（黙って送らない）", () => {
    // 設計書 §5.4「どの欄も編集できる」。誤った番号が保存されると、後日その番号の
    // 本物の反響が「登録済みです」で弾かれ、誤りが将来に持ち越される。
    const d = buildPasteDraft(
      "■査定ナンバー： SA2608-1234567" + NL + "■物件所在地： 東京都A区B1-2-3",
    );
    expect(d.externalLinkKey).toBe("SA2608-1234567");
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, { draft: d, rawText: "" }),
    );
    const block = extractFieldBlock(out, "externalLinkKey");
    expect(block).not.toBe("");
    expect(block).toContain('value="SA2608-1234567"');
    expect(block).toContain("査定ナンバー");
  });

  it("★渡された値（人が直した値）が下書きの値より優先して出る", () => {
    const d = buildPasteDraft(
      "■査定ナンバー： SA2608-1234567" + NL + "■物件所在地： 東京都A区B1-2-3",
    );
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft: d, rawText: "", externalLinkKey: "SA2608-7654321",
      }),
    );
    const block = extractFieldBlock(out, "externalLinkKey");
    expect(block).toContain('value="SA2608-7654321"');
    expect(block).not.toContain("SA2608-1234567");
  });

  it("★空にできる（空なら外部キー無しとして扱う旨の案内が添う）", () => {
    const d = buildPasteDraft(
      "■査定ナンバー： SA2608-1234567" + NL + "■物件所在地： 東京都A区B1-2-3",
    );
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, { draft: d, rawText: "", externalLinkKey: "" }),
    );
    const block = extractFieldBlock(out, "externalLinkKey");
    expect(block).toContain('value=""');
    expect(block).toContain("空にすると住所で判断します");
  });

  it("査定ナンバーが元資料に無ければ空欄で出る（推測で埋めない）", () => {
    const d = buildPasteDraft("■物件所在地： 東京都A区B1-2-3");
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, { draft: d, rawText: "" }),
    );
    const block = extractFieldBlock(out, "externalLinkKey");
    expect(block).not.toBe("");
    expect(block).toContain("元の資料に記載がありません");
  });
});

describe("重複の見直しは、直したあとに起こる（6巡目 ②③）", () => {
  const out = renderToStaticMarkup(
    createElement(PasteImportReview, {
      draft,
      rawText: "",
      ownerMode: "new",
      onDuplicateInputBlur: () => {},
    }),
  );

  it("★見直しの断り(recheckError)は画面に出る（黙って古い判定のままにしない）", () => {
    const withError = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft, rawText: "", recheckError: "重複の確認ができませんでした（通信に失敗しました）。",
      }),
    );
    expect(withError).toContain("重複の確認ができませんでした");
  });

  it("見直しの断りが無ければ何も出さない", () => {
    expect(out).not.toContain("重複の確認ができませんでした");
  });

  it("★どの欄を直したら見直すかが、実際の集合として決まっている", () => {
    // 住所の重複は登録APIが意図的にブロックしない＝画面の警告が唯一の防御線。
    expect([...DUPLICATE_INPUT_FIELDS].sort()).toEqual(["address", "lotNumber"]);
    expect([...DUPLICATE_OWNER_FIELDS].sort()).toEqual(["currentAddress", "name"]);
  });

  it("★その集合が実際に onBlur へ配線されている(部品のソースを走査して固定する)", () => {
    // ⚠renderToStaticMarkup は onBlur を属性として出さないため、描画結果からは
    //   配線を確かめられない。「id があること」だけを見る空振りにしないよう、
    //   呼び出し側の記述そのものを走査する(配線を外すと名指しで落ちる)。
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../paste-import-review.tsx"),
      "utf8",
    );
    // 物件の欄: 見直し対象の欄だけ onBlur を渡す
    expect(source).toContain(
      "onBlur={DUPLICATE_INPUT_FIELDS.has(f.key) ? onDuplicateInputBlur : undefined}",
    );
    // 所有者の欄
    expect(source).toContain(
      "onBlur={DUPLICATE_OWNER_FIELDS.has(f.key) ? onDuplicateInputBlur : undefined}",
    );
    // 査定ナンバーの欄は常に対象
    const keyBlock = source.slice(source.indexOf('fieldKey="externalLinkKey"'));
    expect(keyBlock.slice(0, 500)).toContain("onBlur={onDuplicateInputBlur}");
  });
});

describe("所有者候補の表示は、2件が完全に同じにならない（8巡目 ②）", () => {
  const base = {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    name: "山田太郎",
    matchKind: "name_only" as const,
    address: "東京都A区1-1-1",
    addressKind: "current" as const,
    propertyCount: 3,
  };

  it("★住所だけが違う2件は、違う表示になる", () => {
    expect(ownerCandidateLabel(base)).not.toBe(
      ownerCandidateLabel({ ...base, address: "大阪府B市2-2-2" }),
    );
  });

  it("★所有物件数だけが違う2件は、違う表示になる（住所が伏せられていても区別できる）", () => {
    const masked = { ...base, address: null };
    expect(ownerCandidateLabel(masked)).not.toBe(
      ownerCandidateLabel({ ...masked, propertyCount: 7 }),
    );
  });

  it("★住所も件数も同じでも、違う所有者なら違う表示になる（完全一致を作れない）", () => {
    expect(ownerCandidateLabel(base)).not.toBe(
      ownerCandidateLabel({ ...base, id: "bbbbbbbb-1111-2222-3333-444444444444" }),
    );
  });

  it("★一致の種類は引き続き読める", () => {
    expect(ownerCandidateLabel(base)).toContain("氏名だけ一致");
    expect(ownerCandidateLabel({ ...base, matchKind: "current_address" })).toContain(
      "連絡先の住所も一致",
    );
  });

  it("★画面にも住所と所有物件数が出る（部品が値を捨てていない）", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "",
        ownerCandidates: [
          { ...base, id: "id-a", address: "東京都A区1-1-1", propertyCount: 3 },
          { ...base, id: "id-b", address: "大阪府B市2-2-2", propertyCount: 7 },
        ],
      }),
    );
    expect(out).toContain("東京都A区1-1-1");
    expect(out).toContain("大阪府B市2-2-2");
    expect(out).toContain("所有物件 3件");
    expect(out).toContain("所有物件 7件");
  });
});

describe("見えない紐付けを残さない（8巡目 ①）", () => {
  const candidate = {
    id: "own-1",
    name: "山田太郎",
    matchKind: "name_only" as const,
    address: "東京都A区1-1-1",
    addressKind: "current" as const,
    propertyCount: 2,
  };

  it("★link のまま相手が選ばれていなければ、登録ボタンが無効で理由が画面に出る", () => {
    // 再判定で候補が入れ替わると、選択だけが残って画面に何も出ない状態が作れた。
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft, rawText: "", ownerMode: "link", linkedOwnerId: null,
        ownerCandidates: [candidate],
      }),
    );
    expect(registerButtonDisabled(out)).toBe(true);
    expect(out).toContain(">紐付ける所有者が選ばれていません。");
  });

  it("★候補が空になったのに link のままなら、やはり止まる（選択肢が消えたのに紐付けが残る状態を作れない）", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft, rawText: "", ownerMode: "link", linkedOwnerId: null, ownerCandidates: [],
      }),
    );
    expect(registerButtonDisabled(out)).toBe(true);
    expect(out).toContain(">紐付ける所有者が選ばれていません。");
  });

  it("★相手が選ばれていて候補にも出ていれば止めない（止めすぎていない）", () => {
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft, rawText: "", ownerMode: "link", linkedOwnerId: "own-1",
        ownerCandidates: [candidate],
      }),
    );
    expect(registerButtonDisabled(out)).toBe(false);
    expect(out).not.toContain(">紐付ける所有者が選ばれていません。");
    // 選んでいる相手が画面に見えていること。
    expect(out).toContain("山田太郎");
    expect(out).toContain("所有物件 2件");
  });

  it("★new / none のときはこの理由を出さない", () => {
    for (const mode of ["new", "none"] as const) {
      const out = renderToStaticMarkup(
        createElement(PasteImportReview, {
          draft, rawText: "", ownerMode: mode,
          ownerValues: { name: "山田太郎", nameKana: "", phone: "", email: "", currentAddress: "" },
        }),
      );
      expect(out).not.toContain(">紐付ける所有者が選ばれていません。");
    }
  });
});

describe("登録処理中は入力欄とラジオも触らせない（9巡目 ③）", () => {
  /** その id を持つ入力要素の開始タグ（属性そのものを見るため）。 */
  function tagById(source: string, id: string): string {
    const at = source.indexOf(`id="${id}"`);
    expect(at, `${id} が見つからない`).toBeGreaterThanOrEqual(0);
    const open = source.lastIndexOf("<", at);
    return source.slice(open, source.indexOf(">", at) + 1);
  }
  /** name="paste-owner-mode" のラジオの開始タグを全部。 */
  function ownerModeRadioTags(source: string): string[] {
    const tags: string[] = [];
    let at = source.indexOf('name="paste-owner-mode"');
    while (at !== -1) {
      const open = source.lastIndexOf("<", at);
      tags.push(source.slice(open, source.indexOf(">", at) + 1));
      at = source.indexOf('name="paste-owner-mode"', at + 1);
    }
    return tags;
  }

  const props = {
    draft,
    rawText: "",
    ownerMode: "new" as const,
    ownerValues: {
      name: "山田太郎", nameKana: "", phone: "", email: "", currentAddress: "",
    },
  };
  const idle = renderToStaticMarkup(createElement(PasteImportReview, props));
  const busy = renderToStaticMarkup(
    createElement(PasteImportReview, { ...props, registering: true }),
  );

  it("★登録中は物件の入力欄が無効になる（属性で確認）", () => {
    // ⚠className の `disabled:` に当たる空振りを避けるため、
    //   その入力要素のタグに `disabled=""` が付いているかだけを見る。
    for (const id of ["paste-field-address", "paste-field-lotNumber", "paste-field-externalLinkKey"]) {
      expect(tagById(busy, id)).toContain('disabled=""');
      expect(tagById(idle, id)).not.toContain('disabled=""');
    }
  });

  it("★登録中は選択式の欄（種別・現況）も無効になる", () => {
    for (const id of ["paste-field-propertyType", "paste-field-occupancyStatus"]) {
      expect(tagById(busy, id)).toContain('disabled=""');
      expect(tagById(idle, id)).not.toContain('disabled=""');
    }
  });

  it("★登録中は所有者の入力欄と備考も無効になる", () => {
    for (const id of ["paste-field-owner-name", "paste-field-owner-phone", "paste-field-note"]) {
      expect(tagById(busy, id)).toContain('disabled=""');
      expect(tagById(idle, id)).not.toContain('disabled=""');
    }
  });

  it("★登録中は所有者の扱いのラジオも無効になる（全部）", () => {
    const busyTags = ownerModeRadioTags(busy);
    expect(busyTags.length).toBeGreaterThan(0);
    for (const t of busyTags) expect(t).toContain('disabled=""');
    for (const t of ownerModeRadioTags(idle)) expect(t).not.toContain('disabled=""');
  });
});

describe("読み取れなかった値の見せ方（9巡目 ②・画面）", () => {
  const d = buildPasteDraft(
    "■物件所在地： 東京都A区B1-2-3" + NL + "■建物（専有）面積： 20坪（66.1㎡）",
  );
  const out = renderToStaticMarkup(createElement(PasteImportReview, { draft: d, rawText: "" }));
  const block = extractFieldBlock(out, "exclusiveArea");

  it("★その欄に「読み取れませんでした」の警告が出る", () => {
    const w = d.warnings.find((x) => x.field === "exclusiveArea");
    expect(w).toBeTruthy();
    expect(block).toContain(w!.message);
    expect(block).toContain("20坪（66.1㎡）");
  });

  it("★その欄に「元の資料に記載がありません」は出さない（元資料には書いてある）", () => {
    expect(block).not.toContain("元の資料に記載がありません");
  });

  it("★欄そのものは空のまま（推測で埋めない）", () => {
    expect(block).toContain('value=""');
  });

  it("本当に記載が無い欄には従来どおり「元の資料に記載がありません」が出る", () => {
    const layout = extractFieldBlock(out, "layoutType");
    expect(layout).toContain("元の資料に記載がありません");
  });
});

describe("備考へ入れなかった項目を画面に出す（11巡目 ①）", () => {
  const d = buildPasteDraft(
    "■物件所在地： 東京都A区B1-2-3" + NL + "■携帯電話： 090-1234-5678" + NL + "■建物構造： 木造スレート葺",
  );
  const out = renderToStaticMarkup(createElement(PasteImportReview, { draft: d, rawText: "" }));

  it("★備考に入れない旨と、その項目・値が画面に出る（捨てていない）", () => {
    expect(out).toContain('data-section="withheld-from-note"');
    expect(out).toContain("備考に入れません");
    expect(out).toContain("適切な欄へ移してください");
    expect(out).toContain("携帯電話");
    expect(out).toContain("090-1234-5678");
  });

  it("★その値は備考欄には入っていない", () => {
    const noteAt = out.indexOf('id="paste-field-note"');
    expect(noteAt).toBeGreaterThanOrEqual(0);
    // textarea の中身(次の </textarea> まで)に電話番号が無いこと。
    const noteBody = out.slice(noteAt, out.indexOf("</textarea>", noteAt));
    expect(noteBody).not.toContain("090-1234-5678");
    // 所有者と無関係な項目は備考に入っている。
    expect(noteBody).toContain("建物構造");
  });

  it("備考へ入れなかった項目が無ければ、その区画ごと出さない", () => {
    const clean = buildPasteDraft("■物件所在地： 東京都A区B1-2-3" + NL + "■建物構造： 木造");
    const outClean = renderToStaticMarkup(
      createElement(PasteImportReview, { draft: clean, rawText: "" }),
    );
    expect(outClean).not.toContain('data-section="withheld-from-note"');
    expect(outClean).not.toContain("備考に入れません");
  });
});

describe("専用欄に値を入れたら、備考の生値の行を取り除く（11巡目 ②）", () => {
  const d = buildPasteDraft(
    "■物件所在地： 東京都A区B1-2-3" + NL + "■土地面積： 20坪（66.1㎡）" + NL + "■建物構造： 木造",
  );
  const baseNote = d.noteFromUnmapped;
  const values = (over: Record<string, string>) => ({
    address: "", lotNumber: "", buildingName: "", roomNo: "", propertyType: "",
    exclusiveArea: "", landArea: "", layoutType: "", occupancyStatus: "", builtYear: "",
    ...over,
  });

  it("★値を入れたら、その項目の生値の行が消える", () => {
    expect(baseNote).toContain("土地面積: 20坪（66.1㎡）");
    const after = stripFilledRawLines(baseNote, d.unreadable, values({ landArea: "66.1" }));
    expect(after).not.toContain("20坪（66.1㎡）");
  });

  it("★空のままなら生値の行は残る（情報を失わない）", () => {
    const after = stripFilledRawLines(baseNote, d.unreadable, values({ landArea: "  " }));
    expect(after).toContain("土地面積: 20坪（66.1㎡）");
  });

  it("★他の項目の行は影響を受けない", () => {
    const after = stripFilledRawLines(baseNote, d.unreadable, values({ landArea: "66.1" }));
    expect(after).toContain("建物構造: 木造");
  });

  it("★人が備考を書き換えていたら触らない（完全一致の行だけ消す）", () => {
    const edited = baseNote.replace("20坪（66.1㎡）", "20坪くらい？");
    const after = stripFilledRawLines(edited, d.unreadable, values({ landArea: "66.1" }));
    expect(after).toContain("20坪くらい？");
  });

  it("★取り除いたあとに畳み込むと、矛盾した2行にならない", () => {
    const after = stripFilledRawLines(baseNote, d.unreadable, values({ landArea: "66.1" }));
    const folded = foldNoColumnFieldsIntoNote(after, { landArea: "66.1", builtYear: "" });
    expect(folded).toContain("土地面積: 66.1");
    expect(folded).not.toContain("20坪（66.1㎡）");
    // 「土地面積:」で始まる行が1つだけであること。
    const lines = folded.split("\n").filter((l) => l.startsWith("土地面積:"));
    expect(lines).toHaveLength(1);
  });
});

describe("一致した方の住所を表示する（11巡目 ③）", () => {
  const base = {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    name: "山田太郎",
    propertyCount: 1,
  };

  it("★「登記上の住所と一致」なら、登記上住所であることが分かる表記で出る", () => {
    const label = ownerCandidateLabel({
      ...base,
      matchKind: "registry_address",
      address: "東京都A区1-1-1",
      addressKind: "registry",
    });
    expect(label).toContain("登記上の住所と一致");
    expect(label).toContain("登記上住所: 東京都A区1-1-1");
    expect(label).not.toContain("連絡先住所:");
  });

  it("★「連絡先の住所も一致」なら連絡先住所として出る", () => {
    const label = ownerCandidateLabel({
      ...base,
      matchKind: "current_address",
      address: "東京都B区2-2-2",
      addressKind: "current",
    });
    expect(label).toContain("連絡先の住所も一致");
    expect(label).toContain("連絡先住所: 東京都B区2-2-2");
    expect(label).not.toContain("登記上住所:");
  });

  it("★氏名だけ一致のときも、どちらの住所を出しているかが分かる", () => {
    const label = ownerCandidateLabel({
      ...base,
      matchKind: "name_only",
      address: "東京都C区3-3-3",
      addressKind: "registry",
    });
    expect(label).toContain("氏名だけ一致");
    expect(label).toContain("登記上住所: 東京都C区3-3-3");
  });

  it("住所が無ければ住所の札も出さない", () => {
    const label = ownerCandidateLabel({
      ...base,
      matchKind: "name_only",
      address: null,
      addressKind: null,
    });
    expect(label).not.toContain("登記上住所");
    expect(label).not.toContain("連絡先住所");
  });
});

describe("選択の根拠が弱くなったことを見分ける（12巡目 ①）", () => {
  const cand = (id: string, matchKind: "current_address" | "registry_address" | "name_only") => ({
    id,
    name: "山田太郎",
    matchKind,
    address: "東京都A区1-1-1",
    addressKind: "registry" as const,
    propertyCount: 1,
  });

  it("★同じ id のまま 住所一致 → 氏名だけ一致 に落ちたら「弱くなった」", () => {
    // ⚠ここが id の集合比較では取りこぼす形。id は同じ、matchKind だけ違う。
    expect(hasOwnerMatchWeakened(cand("o1", "registry_address"), cand("o1", "name_only"))).toBe(true);
    expect(hasOwnerMatchWeakened(cand("o1", "current_address"), cand("o1", "name_only"))).toBe(true);
  });

  it("★一致の種類が変わらなければ「弱くなった」ではない", () => {
    for (const k of ["current_address", "registry_address", "name_only"] as const) {
      expect(hasOwnerMatchWeakened(cand("o1", k), cand("o1", k)), k).toBe(false);
    }
  });

  it("★強くなった場合は止めない（氏名だけ一致 → 住所も一致）", () => {
    expect(hasOwnerMatchWeakened(cand("o1", "name_only"), cand("o1", "registry_address"))).toBe(false);
  });

  it("★連絡先住所 ⇄ 登記上住所 の入れ替わりは「弱くなった」ではない（どちらも住所一致）", () => {
    // 別の案内(候補が変わりました)で拾う。ここで「住所の一致が無くなった」と
    // 言うと嘘になる。
    expect(hasOwnerMatchWeakened(cand("o1", "current_address"), cand("o1", "registry_address"))).toBe(false);
    expect(hasOwnerMatchWeakened(cand("o1", "registry_address"), cand("o1", "current_address"))).toBe(false);
  });

  it("★別の id なら比べない（候補から消えた側の判定に任せる）", () => {
    expect(hasOwnerMatchWeakened(cand("o1", "registry_address"), cand("o2", "name_only"))).toBe(false);
  });

  it("★どちらかが無ければ false", () => {
    expect(hasOwnerMatchWeakened(null, cand("o1", "name_only"))).toBe(false);
    expect(hasOwnerMatchWeakened(cand("o1", "registry_address"), null)).toBe(false);
    expect(hasOwnerMatchWeakened(undefined, undefined)).toBe(false);
  });

  it("ownerMatchStrength: 住所まで一致 > 氏名だけ一致", () => {
    expect(ownerMatchStrength("current_address")).toBeGreaterThan(ownerMatchStrength("name_only"));
    expect(ownerMatchStrength("registry_address")).toBeGreaterThan(ownerMatchStrength("name_only"));
  });
});

describe("blur とクリックの競争でも弱化の検出がすり抜けない（15巡目 ②）", () => {
  type Kind = "current_address" | "registry_address" | "name_only";
  const cand = (id: string, matchKind: Kind) => ({
    id,
    name: "山田太郎",
    matchKind,
    address: "東京都A区1-1-1",
    addressKind: "registry" as const,
    propertyCount: 1,
  });

  /**
   * 画面の順序を**実際に再現**する。
   *   1. 住所を編集 → blur が再判定を発火（応答はまだ返らない）
   *   2. 応答が返る前に、強い一致の候補をクリックして選択
   *   3. 再判定の応答が届き、候補リストを name_only に書き換える
   *   4. 登録
   * ⚠応答を**遅延させて**、3が2より後に起きることを本当に作る。
   */
  async function runRace() {
    let candidates = [cand("o1", "registry_address")];
    let resolveRecheck: ((v: typeof candidates) => void) | null = null;
    const pending = new Promise<typeof candidates>((r) => {
      resolveRecheck = r;
    });

    // 1. blur の再判定が走り出す（まだ解決しない）
    const inFlight = pending.then((next) => {
      // 3. 応答が届いて候補リストを書き換える
      candidates = next;
      return next;
    });

    // 2. 応答より先にクリック → **選択時の証拠**を固定
    const clicked = candidates.find((c) => c.id === "o1")!;
    const evidence = { id: clicked.id, matchKindAtSelection: clicked.matchKind };

    // 3. ここで応答が届く（クリックの後）
    resolveRecheck!([cand("o1", "name_only")]);
    await inFlight;

    return { evidence, candidatesAfter: candidates };
  }

  it("★順序が本当に作れている（クリックの後に応答が届き、候補が書き換わる）", async () => {
    const { evidence, candidatesAfter } = await runRace();
    expect(evidence.matchKindAtSelection).toBe("registry_address");
    // 候補リストは応答で name_only に書き換えられている＝汚染された状態。
    expect(candidatesAfter[0].matchKind).toBe("name_only");
    expect(candidatesAfter[0].id).toBe(evidence.id);
  });

  it("★選択時の証拠を基準にすれば、弱化を検出できる（登録に進めない）", async () => {
    const { evidence, candidatesAfter } = await runRace();
    const latest = candidatesAfter.find((c) => c.id === evidence.id)!;
    expect(hasMatchKindWeakened(evidence.matchKindAtSelection, latest.matchKind)).toBe(true);
  });

  it("★候補リストどうしを比べる旧方式では、この競争をすり抜ける（差の裏取り）", async () => {
    const { candidatesAfter } = await runRace();
    // 旧方式は「書き換わったあとの候補リスト」を before としても使うため
    // name_only 対 name_only になり「弱化なし」と誤判断する。
    const polluted = candidatesAfter[0];
    expect(hasMatchKindWeakened(polluted.matchKind, polluted.matchKind)).toBe(false);
    expect(hasOwnerMatchWeakened(polluted, polluted)).toBe(false);
  });

  it("★弱化が無い通常の経路は、従来どおり通る", async () => {
    const evidence = { id: "o1", matchKindAtSelection: "registry_address" as Kind };
    const latest = cand("o1", "registry_address");
    expect(hasMatchKindWeakened(evidence.matchKindAtSelection, latest.matchKind)).toBe(false);
  });
});
