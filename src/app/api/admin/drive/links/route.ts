import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { requireDriveAdmin, toDriveApiError } from "@/lib/drive/admin-access";
import { getDriveClient } from "@/lib/drive/connection";

const noStore = { headers: { "Cache-Control": "no-store" } };

const LINK_SELECT = {
  id: true, propertyId: true, folderId: true, folderName: true, folderPath: true, webViewLink: true, createdAt: true,
  property: { select: { buildingName: true, roomNo: true, address: true } },
} as const;

/** GET: 紐づけの一覧(物件の名前つき)。 */
export async function GET() {
  try {
    await requireDriveAdmin();
    const rows = await prisma.propertyDriveFolder.findMany({ select: LINK_SELECT, orderBy: { createdAt: "desc" } });
    return NextResponse.json({ data: rows }, noStore);
  } catch (e) {
    return handleApiError(e);
  }
}

const postSchema = z.object({
  propertyId: z.string().uuid(),
  folderId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
});

/**
 * POST: 物件とフォルダを紐づける。フォルダは Drive で実在するフォルダ(ゴミ箱でない)に限る。
 * 1物件=1フォルダ・1フォルダ=1物件(すでに紐づいていれば 409)。
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireDriveAdmin();
    const body = postSchema.parse(await parseJsonBody(request));
    const property = await prisma.property.findUnique({ where: { id: body.propertyId }, select: { id: true } });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");

    const client = await getDriveClient();
    const folder = await client.getFolder(body.folderId);
    if (!folder || folder.trashed) throw new ApiError(404, "ドライブにそのフォルダが見つかりません", "NOT_FOUND");
    const folderPath = (await client.folderPath(folder.id)) || folder.name;

    const existing = await prisma.propertyDriveFolder.findFirst({
      where: { OR: [{ propertyId: body.propertyId }, { folderId: body.folderId }] },
      select: { propertyId: true, folderId: true },
    });
    if (existing) {
      throw new ApiError(
        409,
        existing.propertyId === body.propertyId ? "この物件はすでに別のフォルダと紐づいています(先に外してください)" : "このフォルダはすでに別の物件と紐づいています",
        "ALREADY_LINKED",
      );
    }
    const row = await prisma.propertyDriveFolder.create({
      data: {
        propertyId: body.propertyId,
        folderId: folder.id,
        folderName: folder.name,
        folderPath,
        webViewLink: folder.webViewLink,
        linkedById: session.id,
      },
      select: LINK_SELECT,
    });
    // ⚠監査にはフォルダ名を書かない(所有者名を含むことがある)。
    await writeAuditLog({
      userId: session.id,
      action: "drive_folder_link",
      targetTable: "property_drive_folders",
      targetId: row.id,
      detail: { propertyId: body.propertyId },
    });
    return NextResponse.json({ data: row }, { status: 201, ...noStore });
  } catch (e) {
    return handleApiError(toDriveApiError(e));
  }
}
