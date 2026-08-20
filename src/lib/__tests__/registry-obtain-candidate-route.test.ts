/**
 * PR-2b-3: auto-fetch route の candidateRef 分岐（所在検索の候補を選んで取得）の配線検証。
 * lib（resolveRegistryCandidate / runRegistryAutoFetch）は mock し、route が cond③ の再解決を
 * 経由して override 番号で取得することだけを固定する。権限は実 hasPermission + mock getUserPermissions。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => {
      const t = await r.text();
      return t.trim() === "" ? {} : JSON.parse(t);
    }),
    apiResponse: vi.fn((d: unknown, s = 200) =>
      Response.json(d as Record<string, unknown>, { status: s }),
    ),
    handleApiError: vi.fn((e: unknown) => {
      const x = e as { status?: number; message?: string; code?: string };
      if (typeof x?.status === "number") {
        return Response.json({ error: { message: x.message, code: x.code } }, { status: x.status });
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});

vi.mock("@/lib/registry-fetch/auto-fetch", () => ({
  getRegistryFetchProvider: vi.fn(),
  runRegistryAutoFetch: vi.fn(),
}));
vi.mock("@/lib/registry-fetch/live-view-store", () => ({
  beginLiveView: vi.fn(),
  reportLiveStep: vi.fn(() => 1),
  attachLiveShot: vi.fn(),
  completeLiveView: vi.fn(),
  closeLiveViewCancelWindow: vi.fn(),
  isValidLiveRef: vi.fn(() => true),
}));
vi.mock("@/lib/registry-fetch/search", () => ({
  resolveRegistryCandidate: vi.fn(),
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { getRegistryFetchProvider, runRegistryAutoFetch } from "@/lib/registry-fetch/auto-fetch";
import { resolveRegistryCandidate } from "@/lib/registry-fetch/search";
import {
  attachLiveShot,
  reportLiveStep,
  completeLiveView,
  beginLiveView,
} from "@/lib/registry-fetch/live-view-store";
import * as routeModule from "@/app/api/properties/[id]/registry/auto-fetch/route";

const { POST } = routeModule;
const PROP_ID = "11111111-1111-4111-8111-111111111111";
const PERMS_FULL = [
  { resource: "registry", action: "auto_fetch", granted: true },
  { resource: "property", action: "read", granted: true },
];

function callRoute(body: unknown) {
  const req = new Request(
    `http://test/api/properties/${PROP_ID}/registry/auto-fetch`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) },
  ) as never;
  return POST(req, { params: Promise.resolve({ id: PROP_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "user-1", role: "admin", email: "u@t", name: "U" });
  (getUserPermissions as Mock).mockResolvedValue(PERMS_FULL);
  (getRegistryFetchProvider as Mock).mockReturnValue({
    name: "mock",
    supportsLocationSearch: true,
    searchCandidates: vi.fn(),
    fetchRegistryPdf: vi.fn(),
  });
  (runRegistryAutoFetch as Mock).mockResolvedValue({ status: "obtained" });
  // 段階②(2026-07-31): 解決結果は判別付き(number / location)。既定は番号候補。
  (resolveRegistryCandidate as Mock).mockResolvedValue({
    candidate: { kind: "number", realEstateNumber: "RESOLVED-REN" },
    fingerprint: "FP-RESOLVE",
  });
});

describe("auto-fetch route: candidateRef 分岐（cond③ 再解決の配線）", () => {
  it("candidateRef 指定 → resolveRegistryCandidate 経由で解決した番号で取得", async () => {
    const res = await callRoute({ confirmed: true, candidateRef: "cand-1" });
    expect(res.status).toBe(200);
    expect(resolveRegistryCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: PROP_ID, confirmed: true, candidateRef: "cand-1" }),
    );
    expect(runRegistryAutoFetch).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: PROP_ID, confirmed: true, realEstateNumber: "RESOLVED-REN", expectedFingerprint: "FP-RESOLVE" }),
      expect.anything(),
    );
  });

  it("段階②: location 候補は locationCandidate として渡す（番号は渡さない）", async () => {
    (resolveRegistryCandidate as Mock).mockResolvedValue({
      candidate: { kind: "location", lotNumber: "1-1", buildingNumber: null },
      fingerprint: "FP-RESOLVE",
    });
    const res = await callRoute({ confirmed: true, candidateRef: "１－１" });
    expect(res.status).toBe(200);
    const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
    expect(arg.locationCandidate).toEqual({ lotNumber: "1-1", buildingNumber: null });
    expect(arg.realEstateNumber).toBeUndefined();
    expect(arg.expectedFingerprint).toBe("FP-RESOLVE");
  });

  it("candidateRef 無し → 従来の物件番号取得（resolve は呼ばない・override 無し）", async () => {
    const res = await callRoute({ confirmed: true });
    expect(res.status).toBe(200);
    expect(resolveRegistryCandidate).not.toHaveBeenCalled();
    const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
    expect(arg.realEstateNumber).toBeUndefined();
  });

  it("candidateRef 空文字 → candidateRef 分岐に入らない（従来取得）", async () => {
    await callRoute({ confirmed: true, candidateRef: "   " });
    expect(resolveRegistryCandidate).not.toHaveBeenCalled();
    expect(runRegistryAutoFetch).toHaveBeenCalledTimes(1);
  });

  it("再解決で候補が見つからない（resolve が 409）→ 409・取得しない", async () => {
    (resolveRegistryCandidate as Mock).mockRejectedValue(
      Object.assign(new Error("not found"), { status: 409, code: "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND" }),
    );
    const res = await callRoute({ confirmed: true, candidateRef: "cand-x" });
    expect(res.status).toBe(409);
    expect(runRegistryAutoFetch).not.toHaveBeenCalled();
  });

  it("confirmed:true 無しは 400（candidateRef があっても resolve/取得しない）", async () => {
    const res = await callRoute({ candidateRef: "cand-1" });
    expect(res.status).toBe(400);
    expect(resolveRegistryCandidate).not.toHaveBeenCalled();
    expect(runRegistryAutoFetch).not.toHaveBeenCalled();
  });
});

describe("【回収】mode:recover の受け渡し(課金経路と取り違えない)", () => {
  const LOCATION_CANDIDATE = {
    candidate: { kind: "location", lotNumber: "1-1", buildingNumber: null },
    fingerprint: "FP-RESOLVE",
  };

  it("mode:recover は lib へそのまま渡る(回収として実行される)", async () => {
    (resolveRegistryCandidate as Mock).mockResolvedValue(LOCATION_CANDIDATE);
    const res = await callRoute({
      confirmed: true,
      candidateRef: "cand-1",
      mode: "recover",
    });
    expect(res.status).toBe(200);
    const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
    expect(arg.mode).toBe("recover");
    expect(arg.locationCandidate).toEqual({ lotNumber: "1-1", buildingNumber: null });
  });

  it("⚠mode 未指定は従来どおりの有料取得(回収に化けない)", async () => {
    (resolveRegistryCandidate as Mock).mockResolvedValue(LOCATION_CANDIDATE);
    await callRoute({ confirmed: true, candidateRef: "cand-1" });
    const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
    expect(arg.mode).toBeUndefined();
  });

  it.each(["purchase"])(
    "%s は従来どおりの有料取得(回収にしない)",
    async (mode) => {
      (resolveRegistryCandidate as Mock).mockResolvedValue(LOCATION_CANDIDATE);
      const res = await callRoute({ confirmed: true, candidateRef: "cand-1", mode });
      expect(res.status).toBe(200);
      const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
      expect(arg.mode).toBeUndefined();
    },
  );

  it.each(["RECOVER", "recover ", "", "obtain", 1, true, null])(
    "⚠知らない値(%s)は課金扱いにせず 400 で止める(打ち間違いで課金しない)",
    async (mode) => {
      (resolveRegistryCandidate as Mock).mockResolvedValue(LOCATION_CANDIDATE);
      const res = await callRoute({ confirmed: true, candidateRef: "cand-1", mode });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "REGISTRY_MODE_INVALID" },
      });
      expect(runRegistryAutoFetch).not.toHaveBeenCalled();
      expect(resolveRegistryCandidate).not.toHaveBeenCalled();
    },
  );

  it.each([undefined])(
    "候補(%s)が無い回収は**物件自身の地番**で実行する(課金経路へは落とさない)",
    async (candidateRef) => {
      // 取込が途中まで進むと物件に不動産番号が入り、所在検索が対象外になる。
      // 検索の中にある入口しか無いと、買った書類に二度と手が届かない
      // (@codex #394 R6 P1)。
      const res = await callRoute({
        confirmed: true,
        mode: "recover",
        expectedVersion: 3,
        expectedIdentifier: "69-2",
        expectedAddress: "テスト市テスト町一丁目",
        ...(candidateRef === undefined ? {} : { candidateRef }),
      });
      expect(res.status).toBe(200);
      // 候補キャッシュ(誤課金防止の仕組み)には依存しない=解決を呼ばない。
      expect(resolveRegistryCandidate).not.toHaveBeenCalled();
      const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
      expect(arg.mode).toBe("recover");
      // 地番は server 側(物件行)から採る=client からは受け取らない。
      expect(arg.locationCandidate).toBeUndefined();
      expect(arg.realEstateNumber).toBeUndefined();
    },
  );

  it.each(["ALL", "owner ", "全部事項", 1, true])(
    "⚠回収で謄本の種類(%s)が読めない値なら 400(黙って所有者事項にしない)",
    async (certificateType) => {
      const res = await callRoute({
        confirmed: true,
        mode: "recover",
        certificateType,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "REGISTRY_RECOVER_CERTIFICATE_TYPE_INVALID" },
      });
      expect(runRegistryAutoFetch).not.toHaveBeenCalled();
    },
  );

  it.each(["owner", "all"])("回収で %s は通る", async (certificateType) => {
    const res = await callRoute({
      confirmed: true,
      mode: "recover",
      certificateType,
      expectedVersion: 3,
      expectedIdentifier: "69-2",
      expectedAddress: "テスト市テスト町一丁目",
    });
    expect(res.status).toBe(200);
    const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
    expect(arg.certificateType).toBe(certificateType);
  });

  it("⚠従来の有料取得は今までどおり(読めない値は既定=所有者事項に倒す)", async () => {
    // 安い方に倒す fail-safe。回収と違って挙動を変えない。
    (resolveRegistryCandidate as Mock).mockResolvedValue({
      candidate: { kind: "location", lotNumber: "1-1", buildingNumber: null },
      fingerprint: "FP-RESOLVE",
    });
    const res = await callRoute({
      confirmed: true,
      candidateRef: "cand-1",
      certificateType: "ALL",
    });
    expect(res.status).toBe(200);
    const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
    expect(arg.certificateType).toBe("owner");
  });

  it("候補なしの回収は画面が見せていた版番号・識別子を渡す", async () => {
    const res = await callRoute({
      confirmed: true,
      mode: "recover",
      expectedVersion: 7,
      expectedIdentifier: "69-2",
      expectedAddress: "テスト市テスト町一丁目",
    });
    expect(res.status).toBe(200);
    const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
    expect(arg.recoverExpectedVersion).toBe(7);
    expect(arg.recoverExpectedIdentifier).toBe("69-2");
  });

  it.each(["7", true, {}])(
    "⚠版番号が数値でない(%s)なら 400(検査を黙って無効化しない)",
    async (expectedVersion) => {
      const res = await callRoute({
        confirmed: true,
        mode: "recover",
        expectedVersion,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "REGISTRY_RECOVER_EXPECTED_VERSION_INVALID" },
      });
      expect(runRegistryAutoFetch).not.toHaveBeenCalled();
    },
  );

  it.each(["land", "building"])(
    "候補なしの回収は recoverKind(%s)をそのまま渡す",
    async (kind) => {
      const res = await callRoute({
        confirmed: true,
        mode: "recover",
        recoverKind: kind,
        expectedVersion: 3,
        expectedIdentifier: "69-2",
        expectedAddress: "テスト市テスト町一丁目",
      });
      expect(res.status).toBe(200);
      const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
      expect(arg.recoverKind).toBe(kind);
    },
  );

  it.each(["LAND", "土地", "", 1, true])(
    "⚠知らない種別(%s)は 400 で止める(黙って別の登記を探さない)",
    async (kind) => {
      const res = await callRoute({
        confirmed: true,
        mode: "recover",
        recoverKind: kind,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "REGISTRY_RECOVER_KIND_INVALID" },
      });
      expect(runRegistryAutoFetch).not.toHaveBeenCalled();
    },
  );

  it.each(["", "   ", 123, true, {}, null])(
    "⚠候補を指定したのに壊れている(%s)回収は 400(黙って別の探し方に落とさない)",
    async (candidateRef) => {
      // 未指定(物件自身の地番で探す)と、壊れた指定は**別物**として扱う。
      // 両方の識別子を持つ物件では、土地の候補を落とすと建物優先の規則で
      // 建物のPDFを取り込みかねない(@codex #394 R18 P2)。
      const res = await callRoute({
        confirmed: true,
        mode: "recover",
        candidateRef,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "REGISTRY_RECOVER_CANDIDATE_REF_INVALID" },
      });
      expect(runRegistryAutoFetch).not.toHaveBeenCalled();
      expect(resolveRegistryCandidate).not.toHaveBeenCalled();
    },
  );

  it("⚠従来の有料取得は今までどおり(空の候補は従来経路へ)", async () => {
    const res = await callRoute({ confirmed: true, candidateRef: "   " });
    expect(res.status).toBe(200);
    expect(resolveRegistryCandidate).not.toHaveBeenCalled();
    expect(runRegistryAutoFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["版番号なし", { expectedIdentifier: "69-2", expectedAddress: "A町" }],
    ["識別子なし", { expectedVersion: 3, expectedAddress: "A町" }],
    ["所在なし", { expectedVersion: 3, expectedIdentifier: "69-2" }],
    ["すべて無し", {}],
  ])(
    "⚠候補なしの回収で確認情報(%s)が欠けていたら 400(検査を省略させない)",
    async (_label, extra) => {
      const res = await callRoute({
        confirmed: true,
        mode: "recover",
        ...extra,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "REGISTRY_RECOVER_SNAPSHOT_REQUIRED" },
      });
      expect(runRegistryAutoFetch).not.toHaveBeenCalled();
    },
  );

  it("⚠候補が無いのは回収のときだけ通す(従来の取得は今までどおり)", async () => {
    // mode 未指定で候補も無ければ、従来経路(番号での取得)がそのまま走る。
    await callRoute({ confirmed: true });
    const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
    expect(arg.mode).toBeUndefined();
  });
  it("⚠回収でも確認(confirmed)は要る(誤操作で走らせない)", async () => {
    const res = await callRoute({ candidateRef: "cand-1", mode: "recover" });
    expect(res.status).toBe(400);
    expect(runRegistryAutoFetch).not.toHaveBeenCalled();
  });
});

describe("実況は必ず閉じる(パネルが固まったように見えない)", () => {

  it("⚠確認情報が足りない回収でも実況は開かれない/残らない", async () => {
    const res = await callRoute({
      confirmed: true,
      mode: "recover",
      liveRef: "live-1",
    });
    expect(res.status).toBe(400);
    // 始めていないので閉じる必要も無い(始めたのに閉じない、が最悪)。
    expect(beginLiveView).not.toHaveBeenCalled();
  });

  it("⚠候補の解決が失敗しても実況を完了させる(期限切れまで回り続けない)", async () => {
    (resolveRegistryCandidate as Mock).mockRejectedValue(
      Object.assign(new Error("stale"), {
        status: 409,
        code: "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND",
      }),
    );
    const res = await callRoute({
      confirmed: true,
      candidateRef: "cand-x",
      liveRef: "live-1",
    });
    expect(res.status).toBe(409);
    expect(completeLiveView).toHaveBeenCalledTimes(1);
  });
});

describe("実況の画面写真は『全物件を見られる役割』にだけ渡す(@codex #394 R2 P1)", () => {
  // 自動操作はマイページ/請求リスト(**口座全体**)を開くので、全画面の写真には
  // 他の物件の所在・受付番号まで写る。物件単位の認可を写真が素通りさせない。
  const LOCATION_CANDIDATE = {
    candidate: { kind: "location", lotNumber: "1-1", buildingNumber: null },
    fingerprint: "FP-RESOLVE",
  };

  async function runWithRole(role: string) {
    (getApiSession as Mock).mockResolvedValue({
      id: "user-1",
      role,
      email: "u@t",
      name: "U",
    });
    (resolveRegistryCandidate as Mock).mockResolvedValue(LOCATION_CANDIDATE);
    const res = await callRoute({
      confirmed: true,
      candidateRef: "cand-1",
      liveRef: "live-1",
    });
    expect(res.status).toBe(200);
    const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
    // route が組んだ live をそのまま動かして、行き先を実測する。
    arg.live.attachShot(1, new Uint8Array([1, 2, 3]));
    return arg;
  }

  it("管理者(全物件を見られる)には写真が渡る", async () => {
    await runWithRole("admin");
    expect(attachLiveShot).toHaveBeenCalledTimes(1);
  });

  it("⚠担当分しか見られない役割(field_staff)には写真を渡さない", async () => {
    await runWithRole("field_staff");
    expect(attachLiveShot).not.toHaveBeenCalled();
  });

  it("写真を出さないことは文字で伝える(黙って消さない)", async () => {
    await runWithRole("field_staff");
    const labels = (reportLiveStep as Mock).mock.calls.map((c) => c[3]);
    expect(labels.join(" ")).toContain("画面の写真は記録しません");
  });

  it("文字の進行そのものは役割に関係なく届く", async () => {
    const arg = await runWithRole("field_staff");
    arg.live.step("テスト進行");
    const labels = (reportLiveStep as Mock).mock.calls.map((c) => c[3]);
    expect(labels).toContain("テスト進行");
  });
});
