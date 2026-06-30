import { describe, it, expect, vi } from "vitest";

// api-helpers は auth/prisma を import するが、import 時には接続しない。
// handleApiError は純粋な分岐関数なので、重い依存は最小スタブで十分。
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: {} }));

import { handleApiError } from "../api-helpers";
import { RenderBusyError } from "../sales-sheet/render-gate";

describe("handleApiError: RenderBusyError は 503(混雑)に変換する", () => {
  it("503 + code RENDER_BUSY を返す(500 にしない)", async () => {
    const res = handleApiError(new RenderBusyError());
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.code).toBe("RENDER_BUSY");
  });
});
