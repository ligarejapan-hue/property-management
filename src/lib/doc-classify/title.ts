/**
 * そろえたファイル名 `種類_物件名号室_YYYYMMDD.拡張子` と、本文からの日付(純関数)。
 * 元の名前は Attachment.fileName に残り、ここで作るのは表示・保存用の docTitle だけ。
 */
import { stripLeadingPostalCode } from "@/lib/paste-import/normalize";
import { TEXT_SCAN_LIMIT } from "./classify";

/** 物件名+号室(「号室」「号」と空白を除く)。物件名が無ければ所在地(郵便番号・空白を除く)。 */
export function propertyLabelForTitle(p: {
  buildingName: string | null | undefined;
  roomNo: string | null | undefined;
  address: string | null | undefined;
}): string {
  const name = (p.buildingName ?? "").normalize("NFKC").replace(/[\s　]/g, "");
  if (name !== "") {
    const room = (p.roomNo ?? "").normalize("NFKC").replace(/[\s　]/g, "").replace(/号室?$/, "");
    return `${name}${room}`;
  }
  return stripLeadingPostalCode((p.address ?? "").normalize("NFKC")).replace(/[\s　]/g, "");
}

/** 小文字の拡張子。無ければ null(`.hidden` のように名前が無いものも null)。 */
export function fileExtension(fileName: string): string | null {
  const m = /^.+\.([A-Za-z0-9]+)$/.exec(fileName);
  return m ? m[1].toLowerCase() : null;
}

/** ファイル名に使えない文字と制御文字を `_` に。 */
function sanitizeSegment(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
}

/** 日付だけの Date(UTC 0時)を YYYYMMDD に。 */
export function dateStamp(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function buildDocTitle(args: {
  kindLabel: string;
  propertyLabel: string;
  /** 日付だけの Date(UTC 0時)。todayDateOnly / parseDateOnly と同じ約束。 */
  date: Date;
  ext: string | null;
}): string {
  const base = `${sanitizeSegment(args.kindLabel)}_${sanitizeSegment(args.propertyLabel)}_${dateStamp(args.date)}`;
  return args.ext ? `${base}.${args.ext}` : base;
}

/** 同じ名前が既にあれば `_2`・`_3` を付ける。 */
export function uniqueDocTitle(title: string, taken: ReadonlySet<string>): string {
  if (!taken.has(title)) return title;
  const ext = fileExtension(title);
  const stem = ext ? title.slice(0, -(ext.length + 1)) : title;
  for (let n = 2; n < 1000; n++) {
    const candidate = ext ? `${stem}_${n}.${ext}` : `${stem}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return title;
}

/** そろえた名前の末尾の日付(YYYYMMDD)。連番つき(`_2`)も読む。無ければ null。 */
export function dateStampFromDocTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const m = /_(\d{8})(?:_\d+)?(?:\.[A-Za-z0-9]+)?$/.exec(title);
  return m ? m[1] : null;
}

/** YYYYMMDD → 日付だけの Date(UTC 0時)。暦に無ければ null。 */
export function dateFromStamp(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return null;
  return calendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function calendarDate(y: number, mo: number, d: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

const ERA_START: Record<string, number> = { 令和: 2018, 平成: 1988, 昭和: 1925 };

/**
 * 本文の先頭 3,000 文字から最初の日付(西暦または元号)を YYYYMMDD で。
 * 暦に無い日付・見つからなければ null。⚠推測で埋めない。
 */
export function extractDocumentDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = text.slice(0, TEXT_SCAN_LIMIT).normalize("NFKC");
  const seireki = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s);
  const wareki = /(令和|平成|昭和)(元|\d{1,2})年(\d{1,2})月(\d{1,2})日/.exec(s);
  let y: number;
  let mo: number;
  let d: number;
  if (seireki && (!wareki || seireki.index <= wareki.index)) {
    y = Number(seireki[1]);
    mo = Number(seireki[2]);
    d = Number(seireki[3]);
  } else if (wareki) {
    const nth = wareki[2] === "元" ? 1 : Number(wareki[2]);
    y = ERA_START[wareki[1]] + nth;
    mo = Number(wareki[3]);
    d = Number(wareki[4]);
  } else {
    return null;
  }
  const date = calendarDate(y, mo, d);
  return date ? dateStamp(date) : null;
}
