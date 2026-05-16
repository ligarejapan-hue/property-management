import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

// ---------- Custom error ----------

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = "ERROR") {
    super(message);
    this.status = status;
    this.code = code;
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
      { resource: "csv_export", action: "read", granted: true },
      { resource: "import", action: "write", granted: true },
      { resource: "user_management", action: "read", granted: true },
      { resource: "user_management", action: "write", granted: true },
      { resource: "audit_log", action: "read", granted: true },
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

  // 3. Get template permissions
  const template = await prisma.permissionTemplate.findUnique({
    where: { name: templateName },
    include: { templatePermissions: true },
  });

  const templatePerms: PermissionEntry[] = (template?.templatePermissions ?? []).map((tp) => ({
    resource: tp.resource,
    action: tp.action,
    granted: tp.granted,
  }));

  // 4. Get user overrides
  const overrides = await prisma.userPermission.findMany({
    where: { userId },
  });

  // 5. Merge: overrides take precedence
  const merged = new Map<string, PermissionEntry>();
  for (const p of templatePerms) {
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
}

export async function getOwnerDisplayConfig(userId: string): Promise<OwnerDisplayConfig> {
  const permissions = await getUserPermissions(userId);

  const resolveLevel = (field: string): DisplayLevel => {
    const levels: DisplayLevel[] = ["edit", "full", "read", "partial", "masked", "hidden"];
    for (const level of levels) {
      const entry = permissions.find(
        (p) => p.resource === field && p.action === level,
      );
      if (entry?.granted) return level;
    }
    return "hidden";
  };

  // owner_email が権限テンプレートに明示設定されていない場合は owner_phone にフォールバック。
  // これにより seed 実行前の既存本番テンプレートでも email が意図せず hidden にならない。
  // 「owner_email エントリが存在する（=明示設定済み）」と「存在しない（=未設定）」を区別する。
  const hasExplicitEmailEntry = permissions.some((p) => p.resource === "owner_email");
  const emailLevel = hasExplicitEmailEntry
    ? resolveLevel("owner_email")
    : resolveLevel("owner_phone"); // 未設定時は owner_phone の設定を継承

  return {
    name: resolveLevel("owner_name"),
    nameKana: resolveLevel("owner_name_kana"),
    phone: resolveLevel("owner_phone"),
    zip: resolveLevel("owner_zip"),
    address: resolveLevel("owner_address"),
    note: resolveLevel("owner_note"),
    email: emailLevel,
  };
}

// ---------- Response helpers ----------

export function apiResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function handleApiError(error: unknown) {
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
