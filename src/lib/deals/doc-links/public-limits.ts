import { createRateLimiter } from "@/lib/public-rate-limit";

/** 形や署名の違うトークンを試す端末を止める(ページと提出で同じ枠)。 */
export const badTokenLimiter = createRateLimiter({ limit: 20, windowMs: 600_000 }, { onOverflow: "deny" });
