/**
 * 広告用の公開ページ(設計 docs/superpowers/specs/2026-10-20-lp-public-page-design.md)の純関数。
 *  - 公開名(/lp/<slug>)の規則
 *  - どの広告から来たか(utm_* / gclid)の読み取り
 *  - Google のタグ ID・コンバージョン ラベルの規則
 *  - 公開ページの応答ヘッダ(Google のタグがあるときだけ CSP を広げる)
 * ⚠外部由来の文字は許可リストで組み立てる(伏せ字ではなく、合わないものは捨てる)。
 */
import { LP_PAGE_HEADERS } from "./lp-page";

/** 公開名: 半角小文字英数字とハイフン 2〜40 字。 */
export const PUBLIC_SLUG_RE = /^[a-z0-9-]{2,40}$/;

/**
 * 正規化の結果。⚠文字列の目印("invalid" など)は使わない=規則上は有効な値(公開名 "invalid"・ラベル "invalid")と
 * 衝突する(@codex #535 R4 P2)。
 */
export type Normalized = { kind: "empty" } | { kind: "invalid" } | { kind: "ok"; value: string };
const EMPTY: Normalized = { kind: "empty" };
const INVALID: Normalized = { kind: "invalid" };

/** 空=empty(公開しない)・規則外=invalid・それ以外は小文字に揃えた公開名。 */
export function normalizePublicSlug(raw: string | null | undefined): Normalized {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "") return EMPTY;
  return PUBLIC_SLUG_RE.test(s) ? { kind: "ok", value: s } : INVALID;
}

/** 正規化の結果から値だけ取り出す(empty/invalid は null)。保存前の検証を通った値を読む側で使う。 */
export function normalizedValue(n: Normalized): string | null {
  return n.kind === "ok" ? n.value : null;
}

export function publicLpPath(slug: string): string {
  return `/lp/${slug}`;
}

/** フォームの隠し欄・URL の query の鍵(そのまま保存する列名は camelCase)。 */
export const AD_PARAM_KEYS = [
  ["utm_source", "utmSource"],
  ["utm_medium", "utmMedium"],
  ["utm_campaign", "utmCampaign"],
  ["utm_term", "utmTerm"],
  ["utm_content", "utmContent"],
  ["gclid", "gclid"],
] as const;
export type AdParamKey = (typeof AD_PARAM_KEYS)[number][1];
export type AdParams = Record<AdParamKey, string | null>;
export const AD_PARAM_MAX = 200;

const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;

/** URL の query かフォームの隠し欄から、広告の印を読む。制御文字は落とし・前後の空白を除き・200 字で切る。 */
export function readAdParams(get: (key: string) => string | null): AdParams {
  const out = {} as AdParams;
  for (const [query, field] of AD_PARAM_KEYS) {
    const v = (get(query) ?? "").replace(CONTROL_ALL, "").trim();
    out[field] = v === "" ? null : [...v].slice(0, AD_PARAM_MAX).join("");
  }
  return out;
}

export const EMPTY_AD_PARAMS: Readonly<AdParams> = Object.freeze({
  utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null, gclid: null,
});

/**
 * Google のタグに渡してよい広告の印だけで組んだ query(先頭の "?" 付き・無ければ "")。
 * 広告の印は訪問者が自由に書ける文字列(電話番号・メールが紛れ得る)なので、タグには素の URL を渡さず、
 * 許可リスト(英数字と . _ - のみ・@ や空白を含むものは落とす)を通った値だけを付け直す(@codex #535 R4 P1)。
 * gclid は Google が発行する英数字の印。
 */
const SAFE_UTM_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SAFE_GCLID_RE = /^[A-Za-z0-9_-]{1,200}$/;
export function safeAdQuery(ad: AdParams): string {
  const parts: string[] = [];
  for (const [query, field] of AD_PARAM_KEYS) {
    const v = ad[field];
    if (!v) continue;
    const ok = field === "gclid" ? SAFE_GCLID_RE.test(v) : SAFE_UTM_RE.test(v);
    if (ok) parts.push(`${query}=${encodeURIComponent(v)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** Google のタグ ID(G-=GA4 / AW-=Google広告 / GT-=Google タグ)。 */
export const GOOGLE_TAG_ID_RE = /^(G|AW|GT)-[A-Z0-9]{4,20}$/;
export function normalizeGoogleTagId(raw: string | null | undefined): Normalized {
  const s = (raw ?? "").trim().toUpperCase();
  if (s === "") return EMPTY;
  return GOOGLE_TAG_ID_RE.test(s) ? { kind: "ok", value: s } : INVALID;
}

/** 申込完了のコンバージョン ラベル(Google広告の「send_to」の後半)。 */
export const GOOGLE_CONV_LABEL_RE = /^[A-Za-z0-9_-]{4,64}$/;
export function normalizeGoogleConvLabel(raw: string | null | undefined): Normalized {
  const s = (raw ?? "").trim();
  if (s === "") return EMPTY;
  return GOOGLE_CONV_LABEL_RE.test(s) ? { kind: "ok", value: s } : INVALID;
}

export interface GoogleTagConfig { tagId: string; convLabel: string | null }

/**
 * Google のタグを動かすのに要る通信先(gtag.js の配信・GA4・Google広告のコンバージョン)。
 * ⚠ここに無い通信先はブラウザが止める(タグが増えたら設計書とこの一覧を同時に直す)。
 */
const GOOGLE_SCRIPT_SRC = ["https://www.googletagmanager.com"];
const GOOGLE_CONNECT_SRC = [
  "https://www.googletagmanager.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://*.googleadservices.com",
  "https://www.google.com",
  "https://www.google.co.jp",
  "https://googleads.g.doubleclick.net",
  "https://pagead2.googlesyndication.com",
];
const GOOGLE_IMG_SRC = [
  "https://www.google.com",
  "https://www.google.co.jp",
  "https://www.googletagmanager.com",
  "https://*.google-analytics.com",
  "https://googleads.g.doubleclick.net",
  "https://pagead2.googlesyndication.com",
];
const GOOGLE_FRAME_SRC = ["https://td.doubleclick.net", "https://www.googletagmanager.com"];

/** 既にある directive には末尾に足し、無い directive は新しく足す。 */
function addToDirective(csp: string, directive: string, hosts: string[]): string {
  const parts = csp.split(";").map((p) => p.trim()).filter((p) => p !== "");
  const i = parts.findIndex((p) => p === directive || p.startsWith(`${directive} `));
  if (i === -1) return [...parts, `${directive} ${hosts.join(" ")}`].join("; ");
  parts[i] = `${parts[i]} ${hosts.join(" ")}`;
  return parts.join("; ");
}

function widenCsp(base: string, google: GoogleTagConfig | null): string {
  if (!google) return base;
  let csp = base;
  csp = addToDirective(csp, "script-src", GOOGLE_SCRIPT_SRC);
  csp = addToDirective(csp, "connect-src", GOOGLE_CONNECT_SRC);
  csp = addToDirective(csp, "img-src", GOOGLE_IMG_SRC);
  csp = addToDirective(csp, "frame-src", GOOGLE_FRAME_SRC);
  return csp;
}

/**
 * 広告用の公開ページの応答ヘッダ。DM 用(LP_PAGE_HEADERS)と同じ守りを基本にし、
 * Google のタグが設定されているときだけ、その通信先を許す。検索よけ(X-Robots-Tag)は付けない。
 */
export function buildPublicLpHeaders(google: GoogleTagConfig | null): Record<string, string> {
  const headers: Record<string, string> = { ...LP_PAGE_HEADERS };
  delete headers["X-Robots-Tag"];
  headers["Content-Security-Policy"] = widenCsp(LP_PAGE_HEADERS["Content-Security-Policy"], google);
  return headers;
}
