/**
 * 申込の受け口(POST /t/<token>/inquiry・POST /lp/<公開名>/inquiry)で共通の HTTP の作法。
 *  - 結果の返し方: JS 送信(accept: application/json)は画面を離れないよう JSON、それ以外は HTML の結果ページ。
 *  - 本文の上限つき読み取り(認証なしの受け口で大きな本文を解析させない)。
 * ⚠お客様が見る画面・JSON に入力値は一切入れない(送り返さない)。
 */
import { NextResponse } from "next/server";
import { PUBLIC_PAGE_HEADERS } from "./unsubscribe-page";
import {
  renderInquiryBusyPage,
  renderInquiryDonePage,
  renderInquiryInvalidPage,
  renderInquiryPreviewPage,
  renderInquiryThrottledPage,
  renderInquiryUnavailablePage,
} from "./inquiry-page";

export type ReplyKind = "done" | "invalid" | "preview" | "unavailable" | "busy" | "throttled";

// 本文の上限。フォームの正規の最大(全欄を上限文字数まで埋め、UTF-8 の多バイト文字を
// percent-encode した長さ=おおむね 1,600 文字×9 バイト ≒ 14KB)より十分大きく、
// nginx の 12MB よりはるかに小さい。
export const MAX_INQUIRY_BODY_BYTES = 32 * 1024;
export const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

// accept: application/json のとき(LP の送信スクリプト)の応答ヘッダ。入力値は JSON にも入れない。
export const JSON_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin",
};

export function renderReplyPage(kind: ReplyKind, messages: readonly string[], backHref: string): string {
  switch (kind) {
    case "done": return renderInquiryDonePage();
    case "invalid": return renderInquiryInvalidPage(messages, backHref);
    case "preview": return renderInquiryPreviewPage();
    case "unavailable": return renderInquiryUnavailablePage();
    case "busy": return renderInquiryBusyPage();
    case "throttled": return renderInquiryThrottledPage();
  }
}

/** 結果の返し方を1か所に。JS 送信(accept: application/json)は画面を離れないよう JSON、
 *  それ以外(JS なしの通常送信)は従来どおり HTML ページ。状態コードは両方同じ。 */
export function createResponder(wantsJson: boolean, backHref: string) {
  return (kind: ReplyKind, status: number, messages: readonly string[] = []): NextResponse => {
    if (wantsJson) {
      const payload = kind === "invalid" ? { result: kind, messages } : { result: kind };
      return new NextResponse(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS } });
    }
    return new NextResponse(renderReplyPage(kind, messages, backHref), {
      status,
      headers: { ...PUBLIC_PAGE_HEADERS },
    });
  };
}

export function wantsJsonReply(req: Request): boolean {
  return (req.headers.get("accept") ?? "").toLowerCase().includes("application/json");
}

/** 本文を上限つきで読む。上限を超えた時点で読むのをやめて 413(content-length の無い分割送信も含む)。 */
export async function readBoundedBody(
  req: Request,
  max: number,
): Promise<{ ok: true; text: string } | { ok: false; status: 413 | 400 }> {
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return { ok: true, text: new TextDecoder("utf-8").decode(bytes) };
  } catch {
    return { ok: false, status: 400 };
  }
}

/**
 * フォーム本文(application/x-www-form-urlencoded)を読んで URLSearchParams にする。
 * content-type / content-length / 上限 / 解析の失敗は、呼び出し側が「unavailable」で返す状態コードを添えて返す。
 */
export async function readFormBody(
  req: Request,
): Promise<{ ok: true; fields: URLSearchParams } | { ok: false; status: 415 | 413 | 400 }> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith(FORM_CONTENT_TYPE)) return { ok: false, status: 415 };
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_INQUIRY_BODY_BYTES)) {
    return { ok: false, status: 413 };
  }
  const body = await readBoundedBody(req, MAX_INQUIRY_BODY_BYTES);
  if (!body.ok) return { ok: false, status: body.status };
  try {
    return { ok: true, fields: new URLSearchParams(body.text) };
  } catch {
    return { ok: false, status: 400 };
  }
}
