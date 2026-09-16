import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";
import { isCrossSiteOrigin } from "@/lib/public-origin";
import { parseInquiryForm, INQUIRY_ERROR_MESSAGES } from "@/lib/sale-dm-letter/inquiry-input";
import { recordInquiry, type InquiryClientLike } from "@/lib/sale-dm-letter/inquiry-record";
import { PUBLIC_PAGE_HEADERS } from "@/lib/sale-dm-letter/unsubscribe-page";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import {
  renderInquiryBusyPage,
  renderInquiryDonePage,
  renderInquiryInvalidPage,
  renderInquiryPreviewPage,
  renderInquiryThrottledPage,
  renderInquiryUnavailablePage,
} from "@/lib/sale-dm-letter/inquiry-page";

/**
 * 公開LPの査定申込の受け口(設計 §2.5)。認証不要(proxy.ts の PUBLIC_PATHS "/t/"・nginx の公開範囲 /t/ の中)。
 *
 * 守り(多層・/u/ と同じ考え方):
 *  1. 端末IPの回数制限(10/分・溢れたら拒否) — 尽力ベース(送信元IPは偽装し得る)。
 *  2. 送信元判定(public-origin.ts) — よそのサイトから踏ませる送信を 403。DB に触らない。
 *  3. token の形式門前払い(TOKEN_FORMAT・DB 無アクセス) — 追跡 token は randomBytes(8).toString("base64url")
 *     で発行するため、緩い 1..64 文字の許可は本物の token を絶対に弾かない。回数制限キーの長さも頭打ちにする。
 *     続けて公開ロールアウトゲート(lpPublicEnabled)— 無効なら 404(申込・回数制限の枠に触らない)。
 *     GET /t/<token> がフォームを出さない間に、受け口だけが直接の POST を受け付けないようにする。
 *  4. honeypot — 機械送信は「受け付けました」を返して何も残さない。
 *  5. 入力検証(inquiry-input.ts) — 不備は 422。入力値は画面に送り返さない。
 *  6. 存在確認(読み取りのみ・DB 書き込みなし) — 未知 token はここで 404(記録・監査なし)。
 *     **token/全体の回数制限は実在する token の要求だけが消費する**(/u/ が署名検証を通った要求だけ
 *     全体上限を消費するのと同じ考え方)。でたらめな token を毎分何十件連投しても、ここで先に 404 になり
 *     limiter を一切消費しないため、実在する宛先からの正規の申込枠(120/時)を減らせない。
 *  7. token の回数制限(5/時)と全体の回数制限(120/時) — 存在確認を通った要求だけが消費する。
 *  8. 送付済みの宛先だけ記録 — 送付前は 409(recordInquiry 側の unknown→404 は、存在確認から記録までの
 *     間に宛先が消えるごく短い窓のレース安全網として残す)。
 *  9. 監査は draftId と非PII(first/at)のみ。入力文字は出さない。
 */
const ipLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 }, { onOverflow: "deny" });
const tokenLimiter = createRateLimiter({ limit: 5, windowMs: 3_600_000 });
const globalLimiter = createRateLimiter({ limit: 120, windowMs: 3_600_000 });
// 全体上限に達した事実の監査は5分に1回まで(攻撃中に audit_logs を肥大させない)。
const throttleAuditLimiter = createRateLimiter({ limit: 1, windowMs: 300_000 });

// 追跡 token の形式(recordTrackingHit 発行 = randomBytes(8).toString("base64url"))。
// 緩い 1..64 文字は本物の token を弾かず、回数制限キー(`inq-token:${token}`)の長さを頭打ちにする。
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;

// 本文の上限。フォームの正規の最大(全欄を上限文字数まで埋め、UTF-8 の多バイト文字を
// percent-encode した長さ=おおむね 1,384 文字×9 バイト ≒ 12.5KB)より十分大きく、
// nginx の 12MB よりはるかに小さい。認証なしの受け口で大きな本文を解析させない。
const MAX_BODY_BYTES = 32 * 1024;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

type ReplyKind = "done" | "invalid" | "preview" | "unavailable" | "busy" | "throttled";

// accept: application/json のとき(LP の送信スクリプト)の応答ヘッダ。入力値は JSON にも入れない。
const JSON_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

function renderReplyPage(kind: ReplyKind, messages: readonly string[], backHref: string): string {
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
function createResponder(wantsJson: boolean, backHref: string) {
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

/** 本文を上限つきで読む。上限を超えた時点で読むのをやめて 413(content-length の無い分割送信も含む)。 */
async function readBoundedBody(
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const wantsJson = (req.headers.get("accept") ?? "").toLowerCase().includes("application/json");
  const reply = createResponder(wantsJson, `/t/${encodeURIComponent(token)}#inquiry`);

  if (!ipLimiter.hit(`inq-ip:${clientRateKey(req.headers)}`)) {
    return reply("throttled", 429);
  }
  if (isCrossSiteOrigin(req.headers, req.url)) {
    return reply("unavailable", 403);
  }

  // 形式外は DB にも回数制限のキーにも触らせない(存在確認より先に頭打ち)。
  if (!TOKEN_FORMAT.test(token)) {
    return reply("unavailable", 404);
  }

  // 公開ロールアウトゲート。読み込みに失敗したら無効扱い(安全側)。
  let publicEnabled = false;
  try {
    publicEnabled = (await loadSaleDmPublicPageConfig()).lpPublicEnabled;
  } catch {
    publicEnabled = false;
  }
  if (!publicEnabled) {
    return reply("unavailable", 404);
  }

  // 本文を読む前に形式と宣言された大きさで絞る(フォームは urlencoded だけ・charset 付きは可)。
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith(FORM_CONTENT_TYPE)) {
    return reply("unavailable", 415);
  }
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    return reply("unavailable", 413);
  }
  const body = await readBoundedBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    return reply("unavailable", body.status);
  }
  let fields: URLSearchParams;
  try {
    fields = new URLSearchParams(body.text);
  } catch {
    return reply("unavailable", 400);
  }
  const get = (key: string): string | null => fields.get(key);

  const parsed = parseInquiryForm(get);
  if (parsed.kind === "bot") {
    return reply("done", 200);
  }
  if (parsed.kind === "invalid") {
    const messages = parsed.errors.map((e) => INQUIRY_ERROR_MESSAGES[e]);
    return reply("invalid", 422, messages);
  }

  // 存在確認(読み取りのみ)。未知 token はここで 404 にし、token/全体の回数制限を一切消費しない
  // (でたらめな token の連投が実在する宛先の申込枠を食い潰せないようにする)。
  let exists: { id: string } | null;
  try {
    exists = await prisma.dmRecipientDraft.findUnique({
      where: { trackingToken: token },
      select: { id: true },
    });
  } catch (err) {
    // ⚠エラーの message は引数(token・入力)を含み得るので出さない。許可リスト(name/code)だけ。
    console.error("[sale_dm_inquiry] existence lookup failed", {
      name: err instanceof Error ? err.name : "Unknown",
      code: typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : null,
    });
    return reply("busy", 503);
  }
  if (!exists) {
    return reply("unavailable", 404);
  }

  // token と全体の枠は「両方通るときだけ両方消費する」。先に token を hit すると、全体上限で断った
  // 再試行が宛先の 5/時を食い潰す。先に全体を hit すると、1通の手紙の持ち主が token で断られる要求で
  // 全体の枠を食い潰せる。だから数えずに両方確かめてから続けて hit する(間に await を挟まない=
  // 単一スレッドなので確認と消費の間に他の要求が割り込めない)。
  const tokenKey = `inq-token:${token}`;
  const rateNow = Date.now();
  if (!tokenLimiter.wouldAllow(tokenKey, rateNow)) {
    return reply("throttled", 429);
  }
  if (!globalLimiter.wouldAllow("global", rateNow)) {
    if (throttleAuditLimiter.hit("audit")) {
      await writeAuditLog({
        action: "sale_dm_inquiry_submit",
        targetTable: "dm_recipient_drafts",
        detail: { result: "throttled", at: new Date().toISOString() },
      });
    }
    return reply("throttled", 429);
  }
  tokenLimiter.hit(tokenKey, rateNow);
  globalLimiter.hit("global", rateNow);

  let result: Awaited<ReturnType<typeof recordInquiry>>;
  try {
    result = await recordInquiry(prisma as unknown as InquiryClientLike, token, parsed.value);
  } catch (err) {
    // ⚠エラーの message は引数(申込者の入力)を含み得るので出さない。許可リスト(name/code)だけ。
    console.error("[sale_dm_inquiry] record failed", {
      name: err instanceof Error ? err.name : "Unknown",
      code: typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : null,
    });
    return reply("busy", 503);
  }

  if (result.kind === "unknown") return reply("unavailable", 404);
  if (result.kind === "not_sent") return reply("preview", 409);

  await writeAuditLog({
    action: "sale_dm_inquiry_submit",
    targetTable: "dm_recipient_drafts",
    targetId: result.draftId,
    detail: { first: result.first, at: new Date().toISOString() },
  });
  return reply("done", 200);
}
