/**
 * DQ-04: 制御文字 / 文字化け（U+FFFD 等）検出ライブラリ（純関数）テスト。
 *
 * 設計（22B-dq-02-04-05-design.md DQ-04）:
 * - removable（自動除去が安全）: C0/C1/DEL 制御文字（\t\n\r 以外）・ゼロ幅・BOM・bidi 制御。
 *   表示不能・不可視で意味を持たない＝除去しても情報は失われない。
 * - audit-only（自動除去しない）: U+FFFD（�＝デコード失敗痕）と mojibake ヒューリスティック。
 *   除去すると欠損が見えなくなり再取込での修復機会を失う。
 *
 * 検証観点: 制御文字検出 / U+FFFD（文字化け）検出 / 誤検出回避（正規 JP・EN・改行・絵文字 ZWJ）/
 * removable vs audit-only 分離 / 冪等性 / 全角・unicode / 空・null。
 *
 * 戻り値はコード/件数のみ（生値を返さない＝AuditLog / API 安全）であることも検証する。
 */
import { describe, it, expect } from "vitest";
import {
  inspectText,
  sanitizeControlChars,
  hasRemovableControlChars,
  classifyTextHygiene,
  decideTextHygieneFix,
  checkTextHygieneFixSafety,
  emptyTextHygieneSummary,
  tallyTextHygiene,
  type TextHygieneReport,
} from "../owner-text-hygiene";

// テスト用の代表文字（不可視のため String.fromCharCode で構成。ソースに
// リテラル制御文字を埋め込まず git でテキスト扱いを維持する）。
const NUL = String.fromCharCode(0x0000); // U+0000 C0
const BEL = String.fromCharCode(0x0007); // U+0007 C0
const VT = String.fromCharCode(0x000B); // U+000B C0 (vertical tab) removable
const FF = String.fromCharCode(0x000C); // U+000C C0 (form feed) removable
const ESC = String.fromCharCode(0x001B); // U+001B C0
const DEL = String.fromCharCode(0x007F); // U+007F DEL
const NEL = String.fromCharCode(0x0085); // U+0085 C1
const APC = String.fromCharCode(0x009F); // U+009F C1
const ZWSP = String.fromCharCode(0x200B); // U+200B zero-width space
const ZWNJ = String.fromCharCode(0x200C); // U+200C zero-width non-joiner
const ZWJ = String.fromCharCode(0x200D); // U+200D zero-width joiner (also used in emoji ZWJ sequences)
const WJ = String.fromCharCode(0x2060); // U+2060 word joiner
const BOM = String.fromCharCode(0xFEFF); // U+FEFF BOM / zero-width no-break space
const LRE = String.fromCharCode(0x202A); // U+202A bidi
const RLO = String.fromCharCode(0x202E); // U+202E bidi (override; most abused)
const PDF = String.fromCharCode(0x202C); // U+202C bidi pop
const LRI = String.fromCharCode(0x2066); // U+2066 bidi isolate
const PDI = String.fromCharCode(0x2069); // U+2069 bidi isolate pop
const FFFD = String.fromCharCode(0xFFFD); // U+FFFD replacement char (decode-failure signal)
const NBSP = String.fromCharCode(0x00A0); // U+00A0 no-break space
const IDSP = String.fromCharCode(0x3000); // U+3000 ideographic (full-width) space

describe("inspectText — 検出（read-only）", () => {
  it("クリーンな日本語テキストはすべて false", () => {
    const r = inspectText("田中　太郎");
    expect(r.hasControl).toBe(false);
    expect(r.hasReplacementChar).toBe(false);
    expect(r.hasZeroWidth).toBe(false);
    expect(r.hasBidi).toBe(false);
    expect(r.hasMojibake).toBe(false);
    expect(r.controlCount).toBe(0);
    expect(r.zeroWidthCount).toBe(0);
    expect(r.bidiCount).toBe(0);
    expect(r.replacementCount).toBe(0);
    expect(r.hasAnyIssue).toBe(false);
    expect(r.hasRemovable).toBe(false);
    expect(r.hasAuditOnly).toBe(false);
  });

  it("C0/C1/DEL 制御文字を検出する（\\t\\n\\r は対象外）", () => {
    expect(inspectText(`a${NUL}b`).hasControl).toBe(true);
    expect(inspectText(`a${BEL}b`).hasControl).toBe(true);
    expect(inspectText(`a${VT}b`).hasControl).toBe(true);
    expect(inspectText(`a${FF}b`).hasControl).toBe(true);
    expect(inspectText(`a${ESC}b`).hasControl).toBe(true);
    expect(inspectText(`a${DEL}b`).hasControl).toBe(true);
    expect(inspectText(`a${NEL}b`).hasControl).toBe(true);
    expect(inspectText(`a${APC}b`).hasControl).toBe(true);
  });

  it("\\t \\n \\r は制御文字として検出しない（正規の空白/改行）", () => {
    const r = inspectText("行1\n行2\t列\r\n行3");
    expect(r.hasControl).toBe(false);
    expect(r.controlCount).toBe(0);
    expect(r.hasAnyIssue).toBe(false);
  });

  it("controlCount は出現回数を数える", () => {
    expect(inspectText(`${NUL}${BEL}${DEL}`).controlCount).toBe(3);
    expect(inspectText(`a${ESC}b${ESC}c`).controlCount).toBe(2);
  });

  it("ゼロ幅文字（ZWSP/ZWNJ/ZWJ/WJ/BOM）を検出する", () => {
    expect(inspectText(`a${ZWSP}b`).hasZeroWidth).toBe(true);
    expect(inspectText(`a${ZWNJ}b`).hasZeroWidth).toBe(true);
    expect(inspectText(`a${ZWJ}b`).hasZeroWidth).toBe(true);
    expect(inspectText(`a${WJ}b`).hasZeroWidth).toBe(true);
    expect(inspectText(`${BOM}abc`).hasZeroWidth).toBe(true);
    expect(inspectText(`a${ZWSP}${BOM}b`).zeroWidthCount).toBe(2);
  });

  it("bidi 制御文字（LRE/RLO/PDF/isolate）を検出する", () => {
    expect(inspectText(`a${LRE}b`).hasBidi).toBe(true);
    expect(inspectText(`a${RLO}b${PDF}`).hasBidi).toBe(true);
    expect(inspectText(`a${LRI}b${PDI}`).hasBidi).toBe(true);
    expect(inspectText(`${RLO}${LRE}`).bidiCount).toBe(2);
  });

  it("U+FFFD（置換文字）を文字化けシグナルとして検出する", () => {
    const r = inspectText(`住所${FFFD}番地`);
    expect(r.hasReplacementChar).toBe(true);
    expect(r.replacementCount).toBe(1);
    expect(inspectText(`${FFFD}${FFFD}`).replacementCount).toBe(2);
  });

  it("生値（PII）を report に含めない（コード/件数のみ）", () => {
    const r = inspectText(`田中${NUL}太郎${FFFD}`);
    const json = JSON.stringify(r);
    expect(json).not.toContain("田中");
    expect(json).not.toContain("太郎");
    // report はブール/数値のみ
    for (const v of Object.values(r as unknown as Record<string, unknown>)) {
      expect(["boolean", "number"]).toContain(typeof v);
    }
  });
});

describe("inspectText — mojibake ヒューリスティック（audit-only）", () => {
  it("典型的な UTF-8→Latin-1 誤デコード残骸（Ã/Â + 記号連続）を検出する", () => {
    // 実データの混入で頻出する「先導 + 後続高位ラテン」の連鎖。可視の高位ラテン補助
    // （U+00A1-U+00FF）だけで String.fromCharCode で構成し、ソースに不可視 C1 制御を埋め込まない。
    // 例1: Ux00C3 Ux00A3 + Ux00C2 Ux00A2 の連鎖。
    const mojibake1 = String.fromCharCode(0x00c3, 0x00a3, 0x00c2, 0x00a2);
    // 例2: Ux00C2 + 各記号（Ux00A3 / Ux00A5 / Ux00A7）の連鎖。
    const mojibake2 = String.fromCharCode(0x00c2, 0x00a3, 0x00c2, 0x00a5, 0x00c2, 0x00a7);
    expect(inspectText(mojibake1).hasMojibake).toBe(true);
    expect(inspectText(mojibake2).hasMojibake).toBe(true);
  });

  it("正規の日本語・英語・記号は mojibake と誤判定しない", () => {
    expect(inspectText("田中太郎").hasMojibake).toBe(false);
    expect(inspectText("Yamada Taro").hasMojibake).toBe(false);
    expect(inspectText("東京都千代田区1-2-3").hasMojibake).toBe(false);
    expect(inspectText("株式会社ABC（本店）").hasMojibake).toBe(false);
    // ラテン拡張が少数混じる正規名（フランス語等）は誤検出しない
    expect(inspectText("Café").hasMojibake).toBe(false);
    expect(inspectText("Müller").hasMojibake).toBe(false);
  });

  it("正当なアクセント/北欧名（連続濁点含む・文字＋文字）は mojibake と誤判定しない", () => {
    // 判別基準を「**継続文字種別**」へ変更（Codex P2）: 高位ラテン(U+00A1-U+00FF)が
    //   - GARBLE-NEIGHBOR（C1 制御 U+0080-U+009F / CP1252 記号・約物 U+00A0-U+00BF /
    //     CP1252 スマート約物 U+2013-U+2122）に隣接 → mojibake
    //   - **別の高位ラテン文字**（アクセント文字 U+00C0-U+00FF: ó ð å é ü þ …）に隣接 → 正規名
    // よって連続するアクセント付き北欧/ラテン文字を持つ正規名は **文字＋文字** で非フラグ。
    // Þórð（北欧名・ð はアクセント文字 ó/r に隣接）/ café's（é はアクセント e と ASCII 区切りに
    // 隣接＝記号でも約物でもない）/ àé / Ååå（連続アクセント Å/å）/ Café / Müller は全て非フラグ。
    // これらは GARBLE-NEIGHBOR（C1 / CP1252 記号 / スマート約物）に一切隣接しない（誤検出ゼロ）。
    expect(inspectText("Þórð").hasMojibake).toBe(false);
    expect(inspectText("café's").hasMojibake).toBe(false);
    expect(inspectText("àé").hasMojibake).toBe(false);
    expect(inspectText("Ååå").hasMojibake).toBe(false);
    expect(inspectText("Café").hasMojibake).toBe(false);
    expect(inspectText("Müller").hasMojibake).toBe(false);
  });

  it("日本語 mojibake（高位ラテン + 隣接 C1 制御）を検出し audit-only(manual) へ回す", () => {
    // Codex P1: 日本語 'あ'（UTF-8 = E3 81 82）を Latin-1/CP1252 として誤デコードすると
    // 'ã'(U+00E3) + C1 制御 U+0081 + U+0082 になる。先導 'ã' は [ÂÃâ] に含まれないため
    // 旧 MOJIBAKE_RE では hasMojibake=false となり、C1 制御が removable 集合に属するため
    // decideTextHygieneFix が **sanitize** 経路で C1 を剥がして 'ã' に潰す＝PII 二次破損。
    // 高位ラテン(U+00A1-U+00FF)が C1 制御(U+0080-U+009F)に隣接するシグナルを mojibake と
    // 判定することで、これを audit-only（手動・再取込）へ正しく振り分ける。
    const jpMojibake = String.fromCharCode(0x00e3, 0x0081, 0x0082); // 'あ' as CP1252
    expect(inspectText(jpMojibake).hasMojibake).toBe(true);

    // end-to-end: action は manual（mojibake 短絡）であり sanitize ではない＝C1 は自動除去されない。
    const decided = decideTextHygieneFix(jpMojibake);
    expect(decided.action).toBe("manual");
    expect(decided.manualReason).toBe("mojibake");
    expect(decided.cleanedValue).toBeNull();
    expect(decided.changedFields).toEqual([]);
  });

  it("C1 制御が先・高位ラテンが後の隣接順でも mojibake として検出する（双方向）", () => {
    // 隣接シグナルは順不同（[¡-ÿ][garble] と [garble][¡-ÿ] の両 alternation）。
    // 例: U+0082 + 'à'(U+00E0) のように C1 が先行するケースも拾う。
    const c1First = String.fromCharCode(0x0082, 0x00e0);
    expect(inspectText(c1First).hasMojibake).toBe(true);
    expect(decideTextHygieneFix(c1First).action).toBe("manual");
  });

  it("CP1252 で誤デコードされた日本語化け（C1 制御なし・継続文字が記号）も検出する（Codex P2）", () => {
    // Codex P2: CP1252 で誤デコードされた日本語 mojibake のうち **C1 制御を 1 つも含まない**
    // ものは、旧 MOJIBAKE_RE（先導 [ÂÃâ] か C1 隣接のみ）では取りこぼされていた。これらの継続
    // 文字は CP1252 の **記号**（±/°/¤/§/" 等＝U+00A0-U+00BF や U+2013-U+2122）であって C1 では
    // ないため、inspectText が hasMojibake=false を返し DQ-04 が実在の化けを黙って見逃していた。
    // 継続文字種別での判別（高位ラテン + GARBLE-NEIGHBOR[C1/CP1252記号/スマート約物]）により拾う。
    //
    // 山田（UTF-8 を CP1252 として誤読）→ å±±ç"° :
    //   U+00E5 U+00B1 U+00B1 U+00E7 U+201D U+00B0（C1 制御は皆無・記号と高位ラテンの連鎖）。
    const yamadaMojibake = String.fromCharCode(
      0x00e5,
      0x00b1,
      0x00b1,
      0x00e7,
      0x201d,
      0x00b0,
    );
    // 大谷 → å¤§è°· : U+00E5 U+00A4 U+00A7 U+00E8 U+00B0 U+00B7（同上・C1 なし）。
    const otaniMojibake = String.fromCharCode(
      0x00e5,
      0x00a4,
      0x00a7,
      0x00e8,
      0x00b0,
      0x00b7,
    );

    expect(inspectText(yamadaMojibake).hasMojibake).toBe(true);
    expect(inspectText(otaniMojibake).hasMojibake).toBe(true);

    // end-to-end: 黙って見逃さず（none ではない）、かつ自動 sanitize もせず（sanitize ではない）、
    // audit-only として manual（再取込）へ振り分けられること＝PII を二次破損しない。
    for (const m of [yamadaMojibake, otaniMojibake]) {
      const decided = decideTextHygieneFix(m);
      expect(decided.action).toBe("manual");
      expect(decided.manualReason).toBe("mojibake");
      expect(decided.cleanedValue).toBeNull();
      expect(decided.changedFields).toEqual([]);
    }
  });

  it("高位ラテン + スマート約物（例 ü€ = ü+U+20AC）も flag する＝許容済みの無害な過検出（audit-only）", () => {
    // ACCEPTED behavior change（Codex P2）: 継続文字種別ルールは「高位ラテン + スマート約物
    // （U+2013-U+2122）」も mojibake として拾う。例えば ü€（U+00FC + U+20AC[EURO SIGN]）。
    // mojibake は **audit-only**（自動 sanitize されない・apply-gate のブロッカーでもない）ため、
    // これは「人手レビュー行が 1 件増える」だけの **無害な過検出**であり、矛盾ではない。
    // （以前は非フラグだったが、CP1252 日本語化けを取りこぼさないための意図的な広げ。）
    const uEuro = String.fromCharCode(0x00fc, 0x20ac); // ü€
    expect(inspectText(uEuro).hasMojibake).toBe(true);

    // データ破損が起きないことを固定: manual（自動除去なし）・cleanedValue は null。
    const decided = decideTextHygieneFix(uEuro);
    expect(decided.action).toBe("manual");
    expect(decided.manualReason).toBe("mojibake");
    expect(decided.cleanedValue).toBeNull();
    expect(decided.changedFields).toEqual([]);

    // apply-gate（checkTextHygieneFixSafety）は mojibake ヒューリスティックを適用しない方針なので
    // 過検出があってもクリーンな新値は通る＝当該所有者を修正不能化しない。
    const r = checkTextHygieneFixSafety({
      isArchived: false,
      versionMatches: true,
      currentValue: `${uEuro}社`,
      newValue: "クリーンな値",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newValue).toBe("クリーンな値");
  });
});

describe("sanitizeControlChars — removable のみ除去（U+FFFD は残す）", () => {
  it("C0/C1/DEL を除去する", () => {
    expect(sanitizeControlChars(`a${NUL}b${BEL}c${DEL}d${NEL}e${APC}f`)).toBe(
      "abcdef",
    );
    expect(sanitizeControlChars(`${VT}${FF}${ESC}`)).toBe("");
  });

  it("ゼロ幅・BOM・bidi を除去する", () => {
    expect(sanitizeControlChars(`a${ZWSP}b${ZWJ}c`)).toBe("abc");
    expect(sanitizeControlChars(`${BOM}東京`)).toBe("東京");
    expect(sanitizeControlChars(`a${RLO}b${PDF}c`)).toBe("abc");
    expect(sanitizeControlChars(`a${LRI}b${PDI}c`)).toBe("abc");
  });

  it("U+FFFD は除去しない（欠損を隠さない＝audit-only）", () => {
    expect(sanitizeControlChars(`住所${FFFD}番地`)).toBe(`住所${FFFD}番地`);
    // 制御文字は除去しつつ U+FFFD は温存
    expect(sanitizeControlChars(`A${NUL}${FFFD}B`)).toBe(`A${FFFD}B`);
  });

  it("\\t \\n \\r は除去せず空白へ畳んで trim する（正規改行は失わない方針＝空白化）", () => {
    // 連続空白/タブ/改行は 1 個の半角空白へ畳む（owner-name-quality と同方針）。
    expect(sanitizeControlChars("  田中\t\t太郎  ")).toBe("田中 太郎");
    expect(sanitizeControlChars("行1\n\n行2")).toBe("行1 行2");
    expect(sanitizeControlChars("a\r\nb")).toBe("a b");
  });

  it("全角空白(U+3000)も畳み対象（正規の全角文字は保持）", () => {
    expect(sanitizeControlChars("田中　　太郎")).toBe("田中 太郎");
    expect(sanitizeControlChars("東京都")).toBe("東京都"); // 全角文字本体は不変
  });

  it("NBSP(U+00A0) / 全角空白(U+3000) の正規化契約を固定する", () => {
    // 契約: NBSP・全角空白はいずれも空白として畳まれ半角空白 1 個へ正規化される
    // （\s に NBSP/U+3000 は含まれるが、明示的にここで挙動を pin して drift を防ぐ）。
    expect(sanitizeControlChars(`田中${NBSP}太郎`)).toBe("田中 太郎");
    expect(sanitizeControlChars(`田中${IDSP}太郎`)).toBe("田中 太郎");
    // 連続・混在も 1 個へ畳む
    expect(sanitizeControlChars(`A${NBSP}${IDSP} B`)).toBe("A B");
    // 前後の NBSP / 全角空白は trim 同様に除去される
    expect(sanitizeControlChars(`${NBSP}田中${IDSP}`)).toBe("田中");
    // NBSP / 全角空白のみは空文字
    expect(sanitizeControlChars(`${NBSP}${IDSP}`)).toBe("");
  });

  it("クリーンな文字列は不変（trim のみ）", () => {
    expect(sanitizeControlChars("田中太郎")).toBe("田中太郎");
    expect(sanitizeControlChars("Yamada Taro")).toBe("Yamada Taro");
  });

  it("空 / null / undefined は空文字を返す", () => {
    expect(sanitizeControlChars("")).toBe("");
    expect(sanitizeControlChars(null)).toBe("");
    expect(sanitizeControlChars(undefined)).toBe("");
    expect(sanitizeControlChars("   ")).toBe("");
  });

  it("冪等（2回適用しても変わらない）", () => {
    const inputs = [
      `a${NUL}b${ZWSP}c${RLO}d`,
      "  田中\t太郎  ",
      `住所${FFFD}番地`,
      "東京都千代田区",
      `${BOM}A${APC}B`,
    ];
    for (const s of inputs) {
      const once = sanitizeControlChars(s);
      expect(sanitizeControlChars(once)).toBe(once);
    }
  });

  it("絵文字本体は壊さない（surrogate pair を温存）", () => {
    // 単体絵文字（家）は除去対象外。ZWJ は除去対象（owner 氏名/住所では不可視ノイズ扱い）。
    expect(sanitizeControlChars("家🏠")).toBe("家🏠");
  });
});

describe("hasRemovableControlChars — 除去対象の有無", () => {
  it("removable が含まれるとき true", () => {
    expect(hasRemovableControlChars(`a${NUL}b`)).toBe(true);
    expect(hasRemovableControlChars(`a${ZWSP}b`)).toBe(true);
    expect(hasRemovableControlChars(`a${RLO}b`)).toBe(true);
    expect(hasRemovableControlChars(`${BOM}a`)).toBe(true);
  });
  it("U+FFFD だけ・クリーンは false（FFFD は removable ではない）", () => {
    expect(hasRemovableControlChars(`住所${FFFD}番地`)).toBe(false);
    expect(hasRemovableControlChars("田中太郎")).toBe(false);
    expect(hasRemovableControlChars("行1\n行2")).toBe(false); // \n は removable 扱いしない
    expect(hasRemovableControlChars(null)).toBe(false);
    expect(hasRemovableControlChars("")).toBe(false);
  });
});

describe("REMOVABLE_ALL の集合不変条件（drift 防止）", () => {
  // REMOVABLE_ALL_RE_G は内部定数（非 export）だが、hasRemovableControlChars が
  // それに駆動される。ここでは control / zero-width / bidi の各構成正規表現の **和集合**
  // と hasRemovableControlChars の判定が全コードポイントで一致することを固定し、
  // REMOVABLE_ALL のレンジが構成要素から静かにずれる（drift する）のを検出する。
  // 構成要素は owner-text-hygiene.ts の定義と同一に再構成する（仕様の二重記述で乖離検知）。
  const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/; // \t\n\r 除外
  const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/;
  const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
  const unionMatches = (cp: number): boolean => {
    const ch = String.fromCharCode(cp);
    return CONTROL.test(ch) || ZERO_WIDTH.test(ch) || BIDI.test(ch);
  };

  it("REMOVABLE_ALL == control ∪ zero-width ∪ bidi（U+0000–U+FFFF 全域）", () => {
    const mismatches: number[] = [];
    for (let cp = 0x0000; cp <= 0xffff; cp++) {
      // surrogate 単独は String 構成が不定なので比較から除外（実害なし）。
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCharCode(cp);
      const viaLib = hasRemovableControlChars(ch);
      const viaUnion = unionMatches(cp);
      if (viaLib !== viaUnion) mismatches.push(cp);
    }
    expect(mismatches).toEqual([]);
  });

  it("U+FFFD は removable 和集合に含まれない（audit-only）", () => {
    expect(unionMatches(0xfffd)).toBe(false);
    expect(hasRemovableControlChars(FFFD)).toBe(false);
  });
});

describe("classifyTextHygiene — removable vs audit-only 分離", () => {
  it("removable のみ → action 系 issue + severity=warning（自動 sanitize 可）", () => {
    const r = classifyTextHygiene(`田中${NUL}${ZWSP}太郎`);
    expect(r.issues).toContain("control_chars");
    expect(r.issues).toContain("zero_width");
    expect(r.issues).not.toContain("replacement_char");
    expect(r.removable).toBe(true);
    expect(r.auditOnly).toBe(false);
    expect(r.severity).toBe("warning");
  });

  it("U+FFFD → audit-only issue（removable に含めない）", () => {
    const r = classifyTextHygiene(`住所${FFFD}番地`);
    expect(r.issues).toContain("replacement_char");
    expect(r.removable).toBe(false);
    expect(r.auditOnly).toBe(true);
    // 文字化け確定は重大シグナル
    expect(r.severity).toBe("error");
  });

  it("mojibake ヒューリスティック → audit-only", () => {
    const r = classifyTextHygiene("Â£Â¥Â§");
    expect(r.issues).toContain("mojibake");
    expect(r.removable).toBe(false);
    expect(r.auditOnly).toBe(true);
  });

  it("removable と audit-only が同居（両フラグ）", () => {
    const r = classifyTextHygiene(`A${NUL}${FFFD}B`);
    expect(r.removable).toBe(true);
    expect(r.auditOnly).toBe(true);
    expect(r.issues).toContain("control_chars");
    expect(r.issues).toContain("replacement_char");
    expect(r.severity).toBe("error"); // audit-only(error) が優先
  });

  it("bidi は removable かつ severity=warning（表示偽装防止で除去）", () => {
    const r = classifyTextHygiene(`A${RLO}B`);
    expect(r.issues).toContain("bidi");
    expect(r.removable).toBe(true);
    expect(r.auditOnly).toBe(false);
  });

  it("クリーンは issue 空・severity=null", () => {
    const r = classifyTextHygiene("田中太郎");
    expect(r.issues).toEqual([]);
    expect(r.severity).toBeNull();
    expect(r.removable).toBe(false);
    expect(r.auditOnly).toBe(false);
  });

  it("空 / null は issue 空", () => {
    expect(classifyTextHygiene("").issues).toEqual([]);
    expect(classifyTextHygiene(null).issues).toEqual([]);
    expect(classifyTextHygiene(undefined).issues).toEqual([]);
    expect(classifyTextHygiene("   ").issues).toEqual([]);
  });
});

describe("decideTextHygieneFix — preview（sanitize / manual / none）", () => {
  it("removable のみ → action=sanitize（cleanedValue 提示）", () => {
    const p = decideTextHygieneFix(`田中${NUL}${ZWSP}太郎`);
    expect(p.action).toBe("sanitize");
    expect(p.cleanedValue).toBe("田中太郎");
    expect(p.changedFields).toEqual(["value"]);
    expect(p.manualReason).toBeNull();
  });

  it("U+FFFD を含む → action=manual（自動除去しない・再取込案内）", () => {
    const p = decideTextHygieneFix(`住所${FFFD}番地`);
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("replacement_char");
    expect(p.cleanedValue).toBeNull();
    expect(p.changedFields).toEqual([]);
  });

  it("mojibake → action=manual", () => {
    const p = decideTextHygieneFix("Â£Â¥Â§");
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("mojibake");
    expect(p.cleanedValue).toBeNull();
  });

  it("removable と U+FFFD 同居 → manual（audit-only 優先・安全側）", () => {
    const p = decideTextHygieneFix(`A${NUL}${FFFD}B`);
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("replacement_char");
    expect(p.cleanedValue).toBeNull();
  });

  it("空白畳みだけでも値が変わるなら sanitize", () => {
    const p = decideTextHygieneFix("  田中\t太郎  ");
    expect(p.action).toBe("sanitize");
    expect(p.cleanedValue).toBe("田中 太郎");
  });

  it("クリーン（変化なし）→ action=none", () => {
    const p = decideTextHygieneFix("田中太郎");
    expect(p.action).toBe("none");
    expect(p.cleanedValue).toBe("田中太郎");
    expect(p.changedFields).toEqual([]);
  });

  it("sanitize で空になる（不可視文字のみ）→ manual（空書込しない）", () => {
    const p = decideTextHygieneFix(`${ZWSP}${NUL}${BOM}`);
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("would_be_empty");
    expect(p.cleanedValue).toBeNull();
  });

  it("元から空 / null → none（DQ なし）", () => {
    expect(decideTextHygieneFix("").action).toBe("none");
    expect(decideTextHygieneFix(null).action).toBe("none");
    expect(decideTextHygieneFix(undefined).action).toBe("none");
    expect(decideTextHygieneFix("   ").action).toBe("none");
  });
});

describe("checkTextHygieneFixSafety — apply gate", () => {
  const base = {
    isArchived: false,
    versionMatches: true,
    currentValue: `田中${NUL}太郎`,
    newValue: "田中太郎",
  };

  it("正常 sanitize 適用は ok", () => {
    const r = checkTextHygieneFixSafety(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newValue).toBe("田中太郎");
  });

  it("archive 済 / version mismatch は reason 列挙", () => {
    const r = checkTextHygieneFixSafety({
      ...base,
      isArchived: true,
      versionMatches: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toContain("owner_archived");
      expect(r.reasons).toContain("version_mismatch");
    }
  });

  it("変化なしは no_change", () => {
    const r = checkTextHygieneFixSafety({
      ...base,
      currentValue: "田中太郎",
      newValue: "田中太郎",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("no_change");
  });

  it("新値に再び removable 制御文字が残る → forbidden_value（品質を必ず改善する方向のみ）", () => {
    const r = checkTextHygieneFixSafety({ ...base, newValue: `田中${ZWSP}太郎` });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("forbidden_value");
  });

  it("新値に U+FFFD が残る → forbidden_value（文字化けを書き戻さない）", () => {
    const r = checkTextHygieneFixSafety({ ...base, newValue: `田中${FFFD}太郎` });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("forbidden_value");
  });

  it("新値が空（クリア）は許可しない（氏名等で空書込を避ける）→ would_be_empty", () => {
    const r = checkTextHygieneFixSafety({ ...base, newValue: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("would_be_empty");
  });

  it("人手承認後の正当な北欧名（連続濁点）を新値として許可する（un-fixable 化しない）", () => {
    // 連続アクセント文字を含む正規名（Þórð）は mojibake ではない。apply-gate が
    // mojibake ヒューリスティックで弾くと、こうした所有者が修正不能になる（P1-1）。
    const r = checkTextHygieneFixSafety({
      isArchived: false,
      versionMatches: true,
      currentValue: `Þórð${NEL}`, // 除去すべき制御文字を持つ（要クリーニング）
      newValue: "Þórð", // 人手確認済みのクリーン値
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newValue).toBe("Þórð");
  });

  it("北欧名 + 隣接 C1 制御は fail-safe で manual（自動 sanitize しない）／クリーン北欧名は apply-gate を通る（end-to-end）", () => {
    // Codex P1（fail-safe / Option 1）: この日本向けアプリでは、アクセント付きラテン文字が
    // C1 制御に隣接した並びは、日本語 mojibake（高位ラテン + C1。例 'あ' の CP1252 誤読 =
    // 'ã' + C1）とバイト上区別がつかない。よって "Þórð" + U+0085(NEL) のように
    // 高位ラテン ð(U+00F0) が C1 制御 NEL(U+0085) と隣接するケースは、自動 sanitize で C1 を
    // 剥がして PII を二次破損させるリスクを避け、**常に manual（再取込）へ fail-safe** する。
    // まれな正当ケース（アクセント名 + 迷い込んだ C1 制御）も、原本からの再取込で容易に回復できる。
    const original = `Þórð${NEL}`;
    const decided = decideTextHygieneFix(original);
    expect(decided.action).toBe("manual");
    expect(decided.manualReason).toBe("mojibake");
    expect(decided.cleanedValue).toBeNull();
    expect(decided.changedFields).toEqual([]);

    // apply-gate の本来意図は保持する: **クリーンな**北欧名（C1 制御を含まない "Þórð"）は
    // mojibake ヒューリスティックで弾かれず、人手承認後の新値として ok:true で通ること。
    // （apply-gate がクリーンなアクセント名/北欧名を罠にかけてはならない＝修正不能化の防止。）
    const cleanName = "Þórð";
    expect(inspectText(cleanName).hasMojibake).toBe(false);
    const r = checkTextHygieneFixSafety({
      isArchived: false,
      versionMatches: true,
      currentValue: original,
      newValue: cleanName,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newValue).toBe("Þórð");
  });
});

describe("summary 集計", () => {
  it("emptyTextHygieneSummary は全 0", () => {
    const s = emptyTextHygieneSummary();
    expect(s).toEqual({
      controlChars: 0,
      zeroWidth: 0,
      bidi: 0,
      replacementChar: 0,
      mojibake: 0,
      removableCandidates: 0,
      auditOnlyCandidates: 0,
      totalCandidates: 0,
    });
  });

  it("tally は種別ごとに加算し removable/auditOnly/total を更新", () => {
    const s = emptyTextHygieneSummary();
    tallyTextHygiene(s, classifyTextHygiene(`A${NUL}${ZWSP}B`)); // removable
    tallyTextHygiene(s, classifyTextHygiene(`X${FFFD}Y`)); // audit-only
    tallyTextHygiene(s, classifyTextHygiene(`P${RLO}${FFFD}Q`)); // 両方
    tallyTextHygiene(s, classifyTextHygiene("田中太郎")); // クリーン=寄与なし

    expect(s.controlChars).toBe(1);
    expect(s.zeroWidth).toBe(1);
    expect(s.bidi).toBe(1);
    expect(s.replacementChar).toBe(2);
    expect(s.removableCandidates).toBe(2); // row1, row3
    expect(s.auditOnlyCandidates).toBe(2); // row2, row3
    expect(s.totalCandidates).toBe(3); // クリーンは数えない
  });
});

describe("型エクスポート", () => {
  it("TextHygieneReport を import できる（型のみ）", () => {
    const r: TextHygieneReport = inspectText("x");
    expect(typeof r.hasAnyIssue).toBe("boolean");
  });
});
