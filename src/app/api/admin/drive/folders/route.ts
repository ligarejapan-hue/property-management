import { NextResponse, type NextRequest } from "next/server";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { requireDriveAdmin, toDriveApiError } from "@/lib/drive/admin-access";
import { getDriveClient } from "@/lib/drive/connection";
import { candidatesForFolderNames } from "@/lib/drive/candidates";

const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * GET /api/admin/drive/folders?parent=root|shared|<id>&q=&pageToken=
 * ドライブのフォルダの一覧(そのフォルダの道・紐づけ済みか・アプリの物件の候補つき)。
 * ⚠読むだけ。紐づけていないフォルダの「中のファイル」は読まない(フォルダの名前だけ)。
 */
export async function GET(request: NextRequest) {
  try {
    await requireDriveAdmin();
    const sp = request.nextUrl.searchParams;
    const parent = (sp.get("parent") ?? "root").trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(parent)) throw new ApiError(422, "フォルダの指定が正しくありません", "VALIDATION_ERROR");
    const q = (sp.get("q") ?? "").trim().slice(0, 100);
    const pageToken = (sp.get("pageToken") ?? "").trim() || undefined;

    const client = await getDriveClient();
    const [listed, path] = await Promise.all([
      client.listFolders({ parent, nameContains: q || undefined, pageToken }),
      parent === "root" || parent === "shared" ? Promise.resolve("") : client.folderPath(parent),
    ]);
    const links = await prisma.propertyDriveFolder.findMany({
      select: { folderId: true, propertyId: true, property: { select: { buildingName: true, roomNo: true, address: true } } },
    });
    const linkedByFolder = new Map(links.map((l) => [l.folderId, l]));
    const linkedByProperty = new Map(links.map((l) => [l.propertyId, l.folderId]));
    const candidates = await candidatesForFolderNames(
      listed.folders.map((f) => f.name),
      linkedByProperty,
    );
    const data = listed.folders.map((f) => {
      const link = linkedByFolder.get(f.id);
      return {
        ...f,
        linkedProperty: link
          ? { id: link.propertyId, buildingName: link.property.buildingName, roomNo: link.property.roomNo, address: link.property.address }
          : null,
        candidates: link ? [] : (candidates.get(f.name) ?? []),
      };
    });
    return NextResponse.json({ data, path, nextPageToken: listed.nextPageToken }, noStore);
  } catch (e) {
    return handleApiError(toDriveApiError(e));
  }
}
