"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export interface SalesSheetSummary {
  id: string;
  title: string;
  updatedAt: string;
}

/** GET endpoint that lists a property's saved sales sheets. */
export function salesSheetListUrl(propertyId: string): string {
  return `/api/properties/${propertyId}/sales-sheets`;
}

/** Editor route for one saved sheet. */
export function salesSheetEditHref(propertyId: string, sheetId: string): string {
  return `/properties/${propertyId}/sales-sheets/${sheetId}/edit`;
}

function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("ja-JP");
}

/**
 * Presentational list of saved sales sheets (pure render). Renders nothing when
 * there are none, so the section is invisible until a design exists.
 */
export function SalesSheetListView({
  propertyId,
  sheets,
}: {
  propertyId: string;
  sheets: SalesSheetSummary[];
}) {
  if (sheets.length === 0) return null;
  return (
    <div className="mb-4 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
        保存済み販売図面
      </h3>
      <ul className="space-y-1">
        {sheets.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
            <Link
              href={salesSheetEditHref(propertyId, s.id)}
              className="text-indigo-700 hover:underline dark:text-indigo-300"
            >
              {s.title}
            </Link>
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {formatUpdatedAt(s.updatedAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Fetches the property's saved sales sheets and renders the reopen list.
 * Read-only convenience (the list API requires property:read); editing a sheet
 * still enforces property:write at the PUT route.
 */
export function SalesSheetList({ propertyId }: { propertyId: string }) {
  const [sheets, setSheets] = useState<SalesSheetSummary[]>([]);
  useEffect(() => {
    let active = true;
    fetch(salesSheetListUrl(propertyId))
      .then((r) => (r.ok ? r.json() : []))
      .then((data: unknown) => {
        if (active) setSheets(Array.isArray(data) ? (data as SalesSheetSummary[]) : []);
      })
      .catch(() => {
        if (active) setSheets([]);
      });
    return () => {
      active = false;
    };
  }, [propertyId]);
  return <SalesSheetListView propertyId={propertyId} sheets={sheets} />;
}
