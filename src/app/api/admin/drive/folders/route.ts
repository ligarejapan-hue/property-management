import { NextResponse, type NextRequest } from "next/server";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { requireDriveAdmin, toDriveApiError } from "@/lib/drive/admin-access";
import { getDriveClient } from "@/lib/drive/connection";
import { candidatesForChildFolders } from "@/lib/drive/candidates";

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
    // フォルダの中を開くとき(URL を貼って開く・2026-10-26)は、まずフォルダかどうかを確かめる。
    // ファイルの番号・見る権限の無いフォルダ・ゴミ箱の中なら、空の一覧ではなく「見つかりません」と返す。
    let opened: { id: string; name: string; ownedByMe: boolean } | null = null;
    if (parent !== "root" && parent !== "shared") {
      const folder = await client.getFolder(parent);
      if (!folder || folder.trashed) {
        throw new ApiError(
          404,
          "フォルダが見つかりません。フォルダの URL か、接続したアカウントでそのフォルダを開けるかを確かめてください",
          "DRIVE_FOLDER_NOT_FOUND",
        );
      }
      opened = { id: folder.id, name: folder.name, ownedByMe: folder.ownedByMe };
    }
    const [listed, path] = await Promise.all([
      client.listFolders({ parent, nameContains: q || undefined, pageToken }),
      parent === "root" || parent === "shared" ? Promise.resolve("") : client.folderPath(parent),
    ]);
    const links = await prisma.propertyDriveFolder.findMany({
      select: { folderId: true, propertyId: true, property: { select: { buildingName: true, roomNo: true, address: true } } },
    });
    const linkedByFolder = new Map(links.map((l) => [l.folderId, l]));
    const linkedByProperty = new Map(links.map((l) => [l.propertyId, l.folderId]));
    // 親フォルダの名前(道の最後)。子(売却・購入)に手がかりが無いときは親の名前で候補を出す(@codex #577 P2)。
    const parentName = path ? (path.split(" › ").pop() ?? null) : null;
    const candidates = await candidatesForChildFolders(
      listed.folders.map((f) => f.name),
      parentName,
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
    // 開いたフォルダそのものの行(URL を貼って開いたフォルダ自体を紐づけられるように・@codex #597 P2)。
    // 候補は、そのフォルダの名前と、道のひとつ上の名前から出す(子の行と同じ出し方)。
    let self = null;
    if (opened) {
      const names = path ? path.split(" › ") : [];
      const upper = names.length >= 2 ? names[names.length - 2] : null;
      const selfCandidates = await candidatesForChildFolders([opened.name], upper, linkedByProperty);
      const link = linkedByFolder.get(opened.id);
      self = {
        id: opened.id,
        name: opened.name,
        ownedByMe: opened.ownedByMe,
        ownerEmail: null,
        linkedProperty: link
          ? { id: link.propertyId, buildingName: link.property.buildingName, roomNo: link.property.roomNo, address: link.property.address }
          : null,
        candidates: link ? [] : (selfCandidates.get(opened.name) ?? []),
      };
    }
    return NextResponse.json(
      { data, path, folderName: opened?.name ?? null, self, nextPageToken: listed.nextPageToken },
      noStore,
    );
  } catch (e) {
    return handleApiError(toDriveApiError(e));
  }
}
