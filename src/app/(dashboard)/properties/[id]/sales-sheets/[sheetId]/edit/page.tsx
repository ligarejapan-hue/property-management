import { notFound, redirect } from "next/navigation";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import prisma from "@/lib/prisma";
import { getDesign } from "@/lib/sales-sheet/design-service";
import { parseSalesSheetDocument } from "@/lib/sales-sheet/document-schema";
import { SalesSheetEditor } from "@/components/sales-sheet/editor/SalesSheetEditor";

export default async function SalesSheetEditPage({
  params,
}: {
  params: Promise<{ id: string; sheetId: string }>;
}) {
  const { id, sheetId } = await params;

  let session: Awaited<ReturnType<typeof getApiSession>>;
  try {
    session = await getApiSession();
  } catch {
    redirect("/login");
  }

  const permissions = await getUserPermissions(session.id);
  if (!hasPermission(permissions, "property", "read")) {
    redirect(`/properties/${id}`);
  }

  const property = await prisma.property.findUnique({
    where: { id },
    // address は地図QR(物件の場所を Google マップ検索する QR)のリンク生成に使う。
    select: { id: true, createdBy: true, assignedTo: true, address: true },
  });
  if (!property || !canAccessPropertyRecord(session, property)) {
    redirect(`/properties/${id}`);
  }

  const design = await getDesign(id, sheetId);
  if (!design) notFound();

  const document = parseSalesSheetDocument(design.document);

  return (
    <div className="h-screen flex flex-col">
      <SalesSheetEditor
        initial={{
          document,
          sheetId: design.id,
          propertyId: id,
          propertyAddress: property.address,
          updatedAt: design.updatedAt.toISOString(),
        }}
      />
    </div>
  );
}
