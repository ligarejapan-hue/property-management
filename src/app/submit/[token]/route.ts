import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";
import { docLinkKey, verifyDocLinkToken } from "@/lib/deals/doc-links/token";
import { loadPublicPage } from "@/lib/deals/doc-links/public-store";
import {
  newPageNonce, renderSubmitMessage, renderSubmitPage, submitHeaders, SUBMIT_THROTTLED_MESSAGE, SUBMIT_UNAVAILABLE_MESSAGE,
} from "@/lib/deals/doc-links/public-page";
import { badTokenLimiter } from "@/lib/deals/doc-links/public-limits";

type Ctx = { params: Promise<{ token: string }> };

const pageLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 }, { onOverflow: "allow" });
const HTML = "text/html; charset=utf-8";
const message = (text: string, status: number) => new Response(renderSubmitMessage(text), { status, headers: submitHeaders(HTML) });

/**
 * お客様のページ(ログイン不要・認証は proxy.ts の PUBLIC_PATHS "/submit/")。
 * 署名の鍵が無い・形や署名が違う・期限切れ・無効・中止は、すべて同じ 404(見分けさせない)。何も記録しない。
 */
export async function GET(req: Request, { params }: Ctx) {
  const ip = clientRateKey(req.headers);
  if (!pageLimiter.hit(`submit-page:${ip}`) || !badTokenLimiter.wouldAllow(`submit-bad:${ip}`)) return message(SUBMIT_THROTTLED_MESSAGE, 429);
  const key = docLinkKey();
  const publicId = key ? verifyDocLinkToken((await params).token, key) : null;
  if (!publicId) {
    badTokenLimiter.hit(`submit-bad:${ip}`);
    return message(SUBMIT_UNAVAILABLE_MESSAGE, 404);
  }
  try {
    const page = await loadPublicPage(publicId, new Date());
    if (!page) return message(SUBMIT_UNAVAILABLE_MESSAGE, 404);
    const nonce = newPageNonce();
    return new Response(renderSubmitPage({ ...page, nonce }), { status: 200, headers: submitHeaders(HTML, nonce) });
  } catch (err) {
    console.error("[deal_doc_page] load failed", { name: err instanceof Error ? err.name : "Unknown" });
    return message("ただいま表示できません。しばらくしてからもう一度お試しください。", 503);
  }
}
