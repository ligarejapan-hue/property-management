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

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, { status, headers: { ...PUBLIC_PAGE_HEADERS } });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!ipLimiter.hit(`inq-ip:${clientRateKey(req.headers)}`)) {
    return html(renderInquiryThrottledPage(), 429);
  }
  if (isCrossSiteOrigin(req.headers, req.url)) {
    return html(renderInquiryUnavailablePage(), 403);
  }
  const { token } = await params;

  // 形式外は DB にも回数制限のキーにも触らせない(存在確認より先に頭打ち)。
  if (!TOKEN_FORMAT.test(token)) {
    return html(renderInquiryUnavailablePage(), 404);
  }

  // 公開ロールアウトゲート。読み込みに失敗したら無効扱い(安全側)。
  let publicEnabled = false;
  try {
    publicEnabled = (await loadSaleDmPublicPageConfig()).lpPublicEnabled;
  } catch {
    publicEnabled = false;
  }
  if (!publicEnabled) {
    return html(renderInquiryUnavailablePage(), 404);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return html(renderInquiryUnavailablePage(), 400);
  }
  const get = (key: string): string | null => {
    const v = form.get(key);
    return typeof v === "string" ? v : null;
  };

  const parsed = parseInquiryForm(get);
  if (parsed.kind === "bot") {
    return html(renderInquiryDonePage(), 200);
  }
  if (parsed.kind === "invalid") {
    const messages = parsed.errors.map((e) => INQUIRY_ERROR_MESSAGES[e]);
    return html(renderInquiryInvalidPage(messages, `/t/${encodeURIComponent(token)}#inquiry`), 422);
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
    return html(renderInquiryBusyPage(), 503);
  }
  if (!exists) {
    return html(renderInquiryUnavailablePage(), 404);
  }

  if (!tokenLimiter.hit(`inq-token:${token}`)) {
    return html(renderInquiryThrottledPage(), 429);
  }
  if (!globalLimiter.hit("global")) {
    if (throttleAuditLimiter.hit("audit")) {
      await writeAuditLog({
        action: "sale_dm_inquiry_submit",
        targetTable: "dm_recipient_drafts",
        detail: { result: "throttled", at: new Date().toISOString() },
      });
    }
    return html(renderInquiryThrottledPage(), 429);
  }

  let result: Awaited<ReturnType<typeof recordInquiry>>;
  try {
    result = await recordInquiry(prisma as unknown as InquiryClientLike, token, parsed.value);
  } catch (err) {
    // ⚠エラーの message は引数(申込者の入力)を含み得るので出さない。許可リスト(name/code)だけ。
    console.error("[sale_dm_inquiry] record failed", {
      name: err instanceof Error ? err.name : "Unknown",
      code: typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : null,
    });
    return html(renderInquiryBusyPage(), 503);
  }

  if (result.kind === "unknown") return html(renderInquiryUnavailablePage(), 404);
  if (result.kind === "not_sent") return html(renderInquiryPreviewPage(), 409);

  await writeAuditLog({
    action: "sale_dm_inquiry_submit",
    targetTable: "dm_recipient_drafts",
    targetId: result.draftId,
    detail: { first: result.first, at: new Date().toISOString() },
  });
  return html(renderInquiryDonePage(), 200);
}
