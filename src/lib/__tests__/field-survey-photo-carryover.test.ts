import { describe, it, expect, vi } from "vitest";
import { copyPinPhotosToProperty } from "../field-survey-photo-carryover";

interface PhotoRow {
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedByUserId: string;
  sortOrder: number;
}

function makeDeps(pinPhotos: PhotoRow[], reads: (Buffer | null)[]) {
  const create = vi.fn(async () => ({ id: "pp" }));
  const findMany = vi.fn(async () => pinPhotos);
  let readIdx = 0;
  const read = vi.fn(async (_key: string) => {
    const b = reads[readIdx++];
    return b ? { body: b } : null;
  });
  const upload = vi.fn(
    async (_buf: Buffer, opts: { key: string; mimeType: string; fileName: string }) => ({
      url: `/uploads/${opts.key}`,
      key: opts.key,
    }),
  );
  const db = { fieldSurveyPinPhoto: { findMany }, propertyPhoto: { create } };
  const storage = { read, upload };
  let n = 0;
  const deps = { db, storage, uuid: () => `uuid${n++}`, now: () => 1000 };
  return { deps, create, read, upload, findMany };
}

const photo = (o: Partial<PhotoRow> = {}): PhotoRow => ({
  fileUrl: "/uploads/field-survey/pins/p1/photos/a.jpg",
  fileName: "a.jpg",
  fileSize: 10,
  mimeType: "image/jpeg",
  uploadedByUserId: "u1",
  sortOrder: 0,
  ...o,
});

describe("copyPinPhotosToProperty", () => {
  it("全枚を read→upload(新propertyキー)→create で複製し copied を返す", async () => {
    const { deps, create, upload } = makeDeps(
      [photo(), photo({ sortOrder: 1 })],
      [Buffer.from("x"), Buffer.from("y")],
    );
    const r = await copyPinPhotosToProperty("p1", "prop-1", deps);
    expect(r).toEqual({ copied: 2, failed: 0 });
    expect(upload.mock.calls[0][1].key).toMatch(/^properties\/prop-1\/photos\/1000-uuid0\.jpg$/);
    expect(create.mock.calls[0][0].data.propertyId).toBe("prop-1");
    expect(create.mock.calls[0][0].data.takenBy).toBe("u1");
    expect(create.mock.calls[0][0].data.fileUrl).toBe("/uploads/properties/prop-1/photos/1000-uuid0.jpg");
  });

  it("read が null の写真はスキップし failed に数える(残りは複製)", async () => {
    const { deps, create } = makeDeps(
      [photo(), photo({ sortOrder: 1 })],
      [null, Buffer.from("y")],
    );
    const r = await copyPinPhotosToProperty("p1", "prop-1", deps);
    expect(r).toEqual({ copied: 1, failed: 1 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("写真0枚なら何もせず {copied:0,failed:0}", async () => {
    const { deps, create } = makeDeps([], []);
    const r = await copyPinPhotosToProperty("p1", "prop-1", deps);
    expect(r).toEqual({ copied: 0, failed: 0 });
    expect(create).not.toHaveBeenCalled();
  });
});
