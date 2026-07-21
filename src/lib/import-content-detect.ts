/**
 * B-11 (UI総点検): 取込ファイル種別の内容(列構成)ベース判定。
 *
 * 従来はファイル名(「受付帳」「所有者」を含むか)だけで判定し、含まなければ
 * 422 で拒否していた。本モジュールは中身の列構成を第一シグナルにし、
 * ファイル名は補助シグナルへ降格する。
 *
 * 指紋の根拠 (既存実装の再利用・正本は reception-owner-match.ts):
 * - 受付帳: ヘッダ行の位置固定指紋 (H列=都道府県/都道府県名, I列=区/市区町村。
 *   detectExcludedReason の header_repeat 条件と同一) と、F列位置(=6列目)の
 *   区分値 (土地/建物/区分/区建/共担)。ヘッダ行が無い実ファイルにも対応するため
 *   1行目(parseSheet がヘッダ扱いした行)も値として検査する。
 * - 所有者: OWNER_HEADER_TO_FIELD 系のヘッダ名。所有者固有の強ヘッダ
 *   (所有者氏名/物件住所 等) があれば確定。汎用ヘッダ(住所/郵便番号 等)だけでは
 *   物件CSVと区別できないため、氏名を含む3種以上の組合せを要求する。
 *
 * 純関数のみ (I/O なし)。route (preview / 本取込) の両方から同じ入力で呼ぶことで
 * 「プレビューは通るが実行で拒否」の齟齬を防ぐ。
 */

import { detectImportFileType } from "@/lib/import-file-type";
import type { ImportFileType } from "@/lib/import-file-type";

export interface ContentTypeDetection {
  type: ImportFileType;
  /** 判定根拠 (平易な日本語・UI 表示用) */
  reasons: string[];
}

const RECEPTION_H_HEADERS = new Set(["都道府県", "都道府県名"]);
const RECEPTION_I_HEADERS = new Set(["区", "市区町村"]);
const RECEPTION_F_VALUES = new Set(["土地", "建物", "区分", "区建", "共担"]);
// 値フォールバックの裏取りに使う受付帳固有の値 (E列位置=新既 / B列位置=DL印)。
const RECEPTION_SHINKI_VALUES = new Set(["新", "既", "新規", "既存"]);
const RECEPTION_DL_MARKS = new Set(["〇", "○"]);

/** 所有者固有のヘッダ名 (これがあれば所有者ファイルとみなせる)。 */
const OWNER_STRONG_HEADERS = new Set([
  "所有者氏名",
  "所有者名",
  "所有者市区郡",
  "所有者区",
  "所有者住所",
  "物件住所",
]);

/** 所有者ファイルによく現れるが単独では決め手にならないヘッダ名。 */
const OWNER_WEAK_HEADERS = new Set([
  "氏名",
  "住所",
  "都道府県",
  "建物名",
  "マンション名",
  "部屋番号",
  "号室",
  "郵便番号",
  "〒",
  "DM",
]);

/** F列値の走査行数上限 (先頭だけ見れば十分・巨大ファイルの全走査を避ける)。 */
const CONTENT_SCAN_ROW_LIMIT = 50;

/**
 * ヘッダと先頭データ行から、受付帳/所有者のどちらの列構成かを判定する。
 * 判定できなければ unknown、両方の指紋が立てば ambiguous。
 */
export function detectImportFileTypeFromContent(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): ContentTypeDetection {
  const trimmed = headers.map((h) => (h ?? "").trim());
  const reasons: string[] = [];

  // --- 受付帳シグナル ---
  let reception = false;
  if (
    RECEPTION_H_HEADERS.has(trimmed[7] ?? "") &&
    RECEPTION_I_HEADERS.has(trimmed[8] ?? "")
  ) {
    reception = true;
    reasons.push("見出し行が受付帳の形式(8列目=都道府県・9列目=区)です");
  }
  if (!reception) {
    // ヘッダ行の無い受付帳 (1行目からデータ) の救済。物件CSV等の「ヘッダ行が
    // ある別スキーマ」のデータ行 (種別列に 土地/区分 等が入る) を誤検知しない
    // (@codex #309 P1) ため、次の両方を要求する:
    //  (1) 1行目(parseSheet がヘッダ扱いした行)自体が F 列位置に区分値を持つ
    //      = ヘッダ行が無いファイルである (「種別」等の見出し語なら不成立)
    //  (2) 同じファイル内に 新既(E列位置) か DL印(B列位置) の受付帳固有値がある
    const headerRowIsData = RECEPTION_F_VALUES.has(trimmed[5] ?? "");
    if (headerRowIsData) {
      const scanRows: readonly (readonly string[])[] = [
        trimmed,
        ...rows.slice(0, CONTENT_SCAN_ROW_LIMIT),
      ];
      const corroborated = scanRows.some(
        (row) =>
          RECEPTION_SHINKI_VALUES.has((row[4] ?? "").trim()) ||
          RECEPTION_DL_MARKS.has((row[1] ?? "").trim()),
      );
      if (corroborated) {
        reception = true;
        reasons.push(
          "1行目から受付帳形式のデータ(区分と新既/DL印)が始まっています",
        );
      }
    }
  }

  // --- 所有者シグナル ---
  const strong = trimmed.filter((h) => OWNER_STRONG_HEADERS.has(h));
  const weak = trimmed.filter((h) => OWNER_WEAK_HEADERS.has(h));
  let owner = false;
  if (strong.length >= 1) {
    owner = true;
    reasons.push(`所有者向けの見出し(${strong.slice(0, 3).join("・")})があります`);
  } else if (weak.includes("氏名") && weak.length >= 3) {
    owner = true;
    reasons.push("氏名・住所など所有者向け見出しの組合せがあります");
  }

  if (reception && owner) return { type: "ambiguous", reasons };
  if (reception) return { type: "reception", reasons };
  if (owner) return { type: "owner", reasons };
  return { type: "unknown", reasons };
}

// ---------------------------------------------------------------------------
// 期待種別に対する最終判定 (route のゲートで使用)
// ---------------------------------------------------------------------------

export type ExpectedImportFileType = "reception" | "owner";

export interface ResolvedFileType {
  /** 採用した種別 (= expected。ok=false のときは参考値) */
  type: ExpectedImportFileType;
  /** 取込を進めてよいか。false のときは error に理由 */
  ok: boolean;
  /** 判定の根拠元 */
  source: "content" | "filename" | "assumed";
  /** UI 表示用の判定ラベル (平易な日本語) */
  label: string | null;
  /** ok=false のときの理由 (取り違えの示唆を含む) */
  error: string | null;
  /** ok=true でも表示したい注意文言 */
  warning: string | null;
}

const TYPE_LABEL: Record<ExpectedImportFileType, string> = {
  reception: "受付帳",
  owner: "所有者",
};

/**
 * 「この枠 (expected) に置かれたファイル」として取り込んでよいかを決める。
 *
 * - 内容が expected の形式 → ok (ファイル名は不問。名前が逆なら注意のみ)
 * - 内容がもう一方の形式 → エラー (枠の取り違え)
 * - 内容から判定できない → ファイル名にフォールバック。ファイル名がもう一方を
 *   示す場合のみエラー。どちらも不明なら受け付けて warning で確認を促す
 *   (従来はここで 422 拒否していた = ファイル名依存の解消点)。
 */
export function resolveImportFileType(
  expected: ExpectedImportFileType,
  fileName: string | null | undefined,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): ResolvedFileType {
  const other: ExpectedImportFileType =
    expected === "reception" ? "owner" : "reception";
  const expLabel = TYPE_LABEL[expected];
  const otherLabel = TYPE_LABEL[other];
  const content = detectImportFileTypeFromContent(headers, rows);
  const byName = detectImportFileType(fileName);

  if (content.type === expected) {
    return {
      type: expected,
      ok: true,
      source: "content",
      label: `内容(列構成)から${expLabel}と判定しました`,
      error: null,
      warning:
        byName.type === other
          ? `ファイル名には「${otherLabel}」とありますが、内容は${expLabel}の形式です。ファイルの取り違えでないかご確認ください。`
          : null,
    };
  }

  if (content.type === other) {
    return {
      type: expected,
      ok: false,
      source: "content",
      label: null,
      error: `内容(列構成)が${otherLabel}の形式です。${expLabel}の枠とファイルを取り違えていないか確認してください`,
      warning: null,
    };
  }

  // content が ambiguous / unknown → ファイル名にフォールバック
  if (byName.type === expected) {
    return {
      type: expected,
      ok: true,
      source: "filename",
      label: `ファイル名から${expLabel}として認識しました`,
      error: null,
      warning:
        content.type === "ambiguous"
          ? "内容に受付帳と所有者の両方の特徴があり、形式を絞り込めませんでした。プレビューの内容をご確認ください。"
          : null,
    };
  }

  if (byName.type === other) {
    return {
      type: expected,
      ok: false,
      source: "filename",
      label: null,
      error: `ファイル名が「${otherLabel}」のファイルで、内容からも${expLabel}の形式を確認できませんでした。ファイルを取り違えていないか確認してください`,
      warning: null,
    };
  }

  // 内容もファイル名も不明: 受け付けたうえでプレビュー確認を促す
  return {
    type: expected,
    ok: true,
    source: "assumed",
    label: `${expLabel}として取り込みます(形式は自動判定できませんでした)`,
    error: null,
    warning:
      "ファイル種別を自動判定できませんでした。プレビューの内容を必ず確認してから取り込んでください。",
  };
}
