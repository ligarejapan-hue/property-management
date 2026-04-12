import prisma from "@/lib/prisma";

interface AuditLogInput {
  userId?: string | null;
  action: string;
  targetTable?: string;
  targetId?: string;
  detail?: unknown;
  ipAddress?: string;
  userAgent?: string;
}

export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  // Skip in mock mode
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return;

  try {
    await prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        action: input.action,
        targetTable: input.targetTable ?? null,
        targetId: input.targetId ?? null,
        detail: (input.detail as object) ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch (err) {
    // Audit log failures should not break the main operation
    console.error("Failed to write audit log:", err);
  }
}
