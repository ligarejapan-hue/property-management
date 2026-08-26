import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { RenderBusyError } from "@/lib/sales-sheet/render-gate";
import {
  isDisplayLevelAction,
  isDisplayLevelResource,
} from "@/lib/permission-display-levels";
import { resolveOwnerDisplayConfig } from "@/lib/permissions";

// ---------- Custom error ----------

export class ApiError extends Error {
  status: number;
  code: string;
  /**
   * provider 由来の安全分類コード(charged_but_failed / rate_limited 等)を保持する任意フィールド。
   * RegistryFetchError を ApiError に包んで throw する箇所(謄本取得)が元コードを消さずに
   * 呼び出し側(一括取得の分類)へ渡すために使う。HTTP 応答(status/code/message)には影響しない。
   */
  providerCode?: string;

  constructor(status: number, message: string, code = "ERROR", providerCode?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.providerCode = providerCode;
  }
}

// ---------- Session helpers ----------

export interface ApiSession {
  id: string;
  email: string;
  name: string;
  role: string;
}

export async function getApiSession(): Promise<ApiSession> {
  // Mock mode: return mock admin session
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") {
    return {
      id: "00000000-0000-0000-0000-000000000001",
      email: "admin@example.com",
      name: "モック管理者",
      role: "admin",
    };
  }

  const session = await auth();
  if (!session?.user) {
    throw new ApiError(401, "認証が必要です", "UNAUTHORIZED");
  }

  const user = session.user as { id?: string; email?: string; name?: string; role?: string };
  if (!user.id) {
    throw new ApiError(401, "セッション情報が不正です", "UNAUTHORIZED");
  }

  return {
    id: user.id,
    email: user.email ?? "",
    name: user.name ?? "",
    role: (user as unknown as { role: string }).role ?? "field_staff",
  };
}

// ---------- Permission helpers ----------

export interface PermissionEntry {
  resource: string;
  action: string;
  granted: boolean;
}

export async function getUserPermissions(userId: string): Promise<PermissionEntry[]> {
  // Mock mode: return admin-level permissions (including owner field-level)
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") {
    return [
      { resource: "property", action: "read", granted: true },
      { resource: "property", action: "write", granted: true },
      { resource: "property", action: "delete", granted: true },
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
      { resource: "owner", action: "delete", granted: true },
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_name_kana", action: "full", granted: true },
      { resource: "owner_phone", action: "full", granted: true },
      { resource: "owner_zip", action: "full", granted: true },
      { resource: "owner_address", action: "full", granted: true },
      { resource: "owner_note", action: "full", granted: true },
      { resource: "owner_email", action: "full", granted: true },
      { resource: "owner_corporate_number", action: "full", granted: true },
      { resource: "csv_export", action: "read", granted: true },
      { resource: "csv_export_personal", action: "read", granted: true },
      { resource: "import", action: "write", granted: true },
      // 取込ジョブの全員分閲覧（import:read_all）。mock は admin 相当のため付与
      // （無いと mock 管理者が「自分の取込だけ」に絞られ、他人のジョブが見えない）。
      { resource: "import", action: "read_all", granted: true },
      { resource: "import", action: "manage", granted: true },
      { resource: "user_management", action: "read", granted: true },
      { resource: "user_management", action: "write", granted: true },
      { resource: "audit_log", action: "read", granted: true },
      { resource: "field_survey", action: "read", granted: true },
      { resource: "field_survey", action: "write", granted: true },
      { resource: "field_survey", action: "read_all", granted: true },
      { resource: "field_survey", action: "manage", granted: true },
      // 巡回なし撮影（field_survey:quick_capture）。mock は admin 相当のため付与。
      { resource: "field_survey", action: "quick_capture", granted: true },
      // PR2: 謄本自動取得（registry:auto_fetch）。mock は admin 相当の全権限のため付与。
      { resource: "registry", action: "auto_fetch", granted: true },
      // 売却促進DM の AI 生成（sale_dm:generate）。mock は admin 相当の全権限のため付与
      //（demo/dev で MockLetterProvider を使えるように・本番は admin が明示付与）。
      { resource: "sale_dm", action: "generate", granted: true },
      // S1b-1: 画面保護・謄本PDF権限の土台。mock は admin 相当のため付与（enforcement は後続 PR）。
      { resource: "screen_protection", action: "bypass", granted: true },
      { resource: "registry_pdf", action: "preview", granted: true },
      { resource: "registry_pdf", action: "download", granted: true },
    ];
  }

  // 1. Get user with role to determine template
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user) throw new ApiError(401, "ユーザーが見つかりません", "UNAUTHORIZED");

  // 2. Map role to default template name
  const templateNameMap: Record<string, string> = {
    field_staff: "現地担当用",
    office_staff: "事務担当用",
    admin: "管理者用",
  };

  const templateName = templateNameMap[user.role] ?? "現地担当用";

  // 3+4. Get template permissions & user overrides in parallel.
  // F5(17-C): template は templateName(user.role 由来・上で確定済み)のみ、
  // overrides は userId(引数)のみに依存し互いに独立のため並列取得する
  // （3直列往復→2往復）。クエリ本数(3本)・マージ順・throw 挙動は不変。
  // user 不在時の 401 throw（上記）が先行するため、user が存在しない場合に
  // これらのクエリが発行されない従来挙動も維持される。
  const [template, overrides] = await Promise.all([
    prisma.permissionTemplate.findUnique({
      where: { name: templateName },
      include: { templatePermissions: true },
    }),
    prisma.userPermission.findMany({
      where: { userId },
    }),
  ]);

  const templatePerms: PermissionEntry[] = (template?.templatePermissions ?? []).map((tp) => ({
    resource: tp.resource,
    action: tp.action,
    granted: tp.granted,
  }));

  // 5. Merge: overrides take precedence
  //
  // ⚠表示レベル（非表示/マスク/一部表示/閲覧のみ/全表示/編集可）は resource ごとに
  // 1 つだけ効く設計で、解決側（getOwnerDisplayConfig の resolveLevel）は**最も緩い
  // ものを採用**する。そのため resource:action をキーに素朴にマージすると、
  // 「テンプレ = 全表示」に「個別上書き = マスク」を足しても両方が残り、
  // **緩い全表示が勝ってマスクが効かない**（個別に絞ったつもりが絞れていない）。
  // → 個別上書きで表示レベルを指定している resource は、テンプレート由来の表示レベル
  //   行を落としてから上書きを載せる＝上書きが確実に勝つようにする。
  //   表示レベル以外（property:read 等）のマージ規則は従来どおり変更しない。
  // ⚠**granted の上書きだけ**が対象。「このレベルを外す」だけの拒否上書き
  // （granted:false）でテンプレ側のレベルまで消すと、従来 masked に落ちていたものが
  // hidden になる等、意図しない変化が出る。拒否上書きは従来どおり同じキーを
  // 打ち消すだけに留める。
  const levelOverriddenResources = new Set(
    overrides
      .filter(
        (o) =>
          o.granted &&
          isDisplayLevelResource(o.resource) &&
          isDisplayLevelAction(o.action),
      )
      .map((o) => o.resource),
  );

  const merged = new Map<string, PermissionEntry>();
  for (const p of templatePerms) {
    if (
      levelOverriddenResources.has(p.resource) &&
      isDisplayLevelAction(p.action)
    ) {
      continue;
    }
    merged.set(`${p.resource}:${p.action}`, p);
  }
  for (const o of overrides) {
    merged.set(`${o.resource}:${o.action}`, {
      resource: o.resource,
      action: o.action,
      granted: o.granted,
    });
  }

  return Array.from(merged.values());
}

// ---------- Owner display config ----------

type DisplayLevel = "hidden" | "masked" | "partial" | "full" | "read" | "edit";

export interface OwnerDisplayConfig {
  name: DisplayLevel;
  nameKana: DisplayLevel;
  phone: DisplayLevel;
  zip: DisplayLevel;
  address: DisplayLevel;
  note: DisplayLevel;
  email: DisplayLevel;
  corporateNumber: DisplayLevel;
}

/**
 * owner 各フィールドの表示レベル設定を解決する。
 *
 * F6(17-C): 呼び出し側が同一リクエスト内で既に `getUserPermissions(userId)` を
 * 実行済みの場合、その結果を `preloadedPermissions` に渡すことで権限の
 * 二重解決（user/permissionTemplate/userPermission の DB 再クエリ）を省略できる。
 * 渡さない場合は従来どおり内部で取得する（挙動・導出ロジックは完全に同一）。
 * 注意: `preloadedPermissions` は必ず同じ `userId` の getUserPermissions 結果を渡すこと。
 */
export async function getOwnerDisplayConfig(
  userId: string,
  preloadedPermissions?: PermissionEntry[],
): Promise<OwnerDisplayConfig> {
  const permissions = preloadedPermissions ?? (await getUserPermissions(userId));
  // ⚠導出は @/lib/permissions の純関数1本に集約してある（@codex PR#414 17巡目 ①）。
  //   next-auth を読み込めない場所（uploads-authorization）からも同じ判定を使うため。
  //   ここで再実装しない。
  return resolveOwnerDisplayConfig(permissions) as OwnerDisplayConfig;
}

// ---------- Request body helpers ----------

/**
 * リクエスト本文を JSON として読む。
 *  - 空ボディは `{}` として扱う（オプションキーのみの POST/PATCH を許容）
 *  - JSON リテラルの `null` も `{}` に正規化する（総点検P3）。`null` は**有効な
 *    JSON** なので catch に落ちず、そのまま返すと呼び出し側の
 *    `(body as { x?: unknown }).x` が TypeError で 500 になる（auto-fetch /
 *    sale-dm regenerate で実在した）。「何も指定していない」= {} に揃えれば、
 *    各 route 自身の検証（confirmed 必須等）が正しい 400/422 を返す。
 *  - malformed JSON は ApiError(400, INVALID_JSON) を投げる（state mutation 前に reject）
 *
 * 既存の `request.json().catch(() => ({}))` パターンは malformed と空を
 * 区別できず、不正 body でも処理が進んでしまうため本 helper で置き換える。
 */
export async function parseJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed === null ? {} : parsed;
  } catch {
    throw new ApiError(
      400,
      "リクエストボディが不正な JSON です",
      "INVALID_JSON",
    );
  }
}

// ---------- Response helpers ----------

export function apiResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function handleApiError(error: unknown) {
  // 出力(PDF/PNG)の同時実行上限超過は 500 でなく 503(混雑・リトライ可)として返す。
  if (error instanceof RenderBusyError) {
    return NextResponse.json(
      { error: { message: error.message, code: "RENDER_BUSY" } },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { message: error.message, code: error.code } },
      { status: error.status },
    );
  }

  // Zod validation errors
  if (
    error &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray((error as { issues: unknown[] }).issues)
  ) {
    const issues = (error as { issues: Array<{ path: (string | number)[]; message: string }> }).issues;
    const messages = issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    );
    return NextResponse.json(
      {
        error: {
          message: `入力内容に問題があります: ${messages.join(", ")}`,
          code: "VALIDATION_ERROR",
          details: issues,
        },
      },
      { status: 422 },
    );
  }

  console.error("Unexpected API error:", error);
  return NextResponse.json(
    { error: { message: "サーバーエラーが発生しました", code: "INTERNAL_ERROR" } },
    { status: 500 },
  );
}
