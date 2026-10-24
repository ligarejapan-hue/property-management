/**
 * Google ドライブ API の包み(第2段b=見回り用): 中身の一覧・取り出し・フォルダ作成・写しの置き方・名前の付け直し。
 */
import { describe, it, expect } from "vitest";
import { DriveClient, DriveApiError, FOLDER_MIME } from "../client";

type Call = { url: URL; init?: RequestInit };
function fake(responses: Array<{ status: number; body?: unknown; raw?: BodyInit; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    const body = r.raw ?? (r.body === undefined ? null : JSON.stringify(r.body));
    return new Response(body, { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe("DriveClient(見回り用)", () => {
  it("listChildren: フォルダの中身を全ページ読む・ゴミ箱を除く・md5 と目印(appProperties)を返す", async () => {
    const { fetch, calls } = fake([
      {
        status: 200,
        body: {
          files: [{ id: "d1", name: "契約資料", mimeType: FOLDER_MIME }],
          nextPageToken: "p2",
        },
      },
      {
        status: 200,
        body: {
          files: [
            {
              id: "f1",
              name: "a.pdf",
              mimeType: "application/pdf",
              md5Checksum: "m1",
              size: "1234",
              modifiedTime: "2026-10-24T00:00:00.000Z",
              appProperties: { pmSource: "app" },
            },
          ],
        },
      },
    ]);
    const c = new DriveClient("tok", fetch);
    const items = await c.listChildren("root'x");
    expect(items).toEqual([
      { id: "d1", name: "契約資料", mimeType: FOLDER_MIME, md5: null, size: null, modifiedTime: null, appSource: null, appAttachmentId: null },
      {
        id: "f1",
        name: "a.pdf",
        mimeType: "application/pdf",
        md5: "m1",
        size: 1234,
        modifiedTime: "2026-10-24T00:00:00.000Z",
        appSource: "app",
        appAttachmentId: null,
      },
    ]);
    expect(calls[0].url.searchParams.get("q")).toBe("'root\\'x' in parents and trashed = false");
    expect(calls[1].url.searchParams.get("pageToken")).toBe("p2");
  });

  it("download: alt=media で中身を Buffer で返す", async () => {
    const { fetch, calls } = fake([{ status: 200, raw: new Uint8Array([1, 2, 3]) }]);
    const c = new DriveClient("tok", fetch);
    const buf = await c.download("f1");
    expect([...buf]).toEqual([1, 2, 3]);
    expect(calls[0].url.pathname).toBe("/drive/v3/files/f1");
    expect(calls[0].url.searchParams.get("alt")).toBe("media");
  });

  it("createFolder: 親の下にフォルダを作って id を返す", async () => {
    const { fetch, calls } = fake([{ status: 200, body: { id: "nf" } }]);
    const c = new DriveClient("tok", fetch);
    expect(await c.createFolder("p1", "③契約関係")).toBe("nf");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ name: "③契約関係", mimeType: FOLDER_MIME, parents: ["p1"] });
  });

  it("uploadFile: 再開型で置く(1回目=名前と目印・2回目=中身)・id と md5 を返す", async () => {
    const { fetch, calls } = fake([
      { status: 200, body: {}, headers: { location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=U" } },
      { status: 200, body: { id: "nf", md5Checksum: "m9" } },
    ]);
    const c = new DriveClient("tok", fetch);
    const r = await c.uploadFile({
      parentId: "p1",
      name: "売買契約書.pdf",
      mimeType: "application/pdf",
      body: Buffer.from("abc"),
      appProperties: { pmSource: "app", pmAttachmentId: "a1" },
    });
    expect(r).toEqual({ id: "nf", md5: "m9" });
    expect(calls[0].url.searchParams.get("uploadType")).toBe("resumable");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      name: "売買契約書.pdf",
      parents: ["p1"],
      mimeType: "application/pdf",
      appProperties: { pmSource: "app", pmAttachmentId: "a1" },
    });
    expect(calls[1].url.searchParams.get("upload_id")).toBe("U");
    expect(calls[1].init?.method).toBe("PUT");
  });

  it("uploadFile: 戻り先(location)が Google 以外なら送らない", async () => {
    const { fetch, calls } = fake([{ status: 200, body: {}, headers: { location: "https://evil.example.com/x" } }]);
    const c = new DriveClient("tok", fetch);
    await expect(
      c.uploadFile({ parentId: "p", name: "n", mimeType: "application/pdf", body: Buffer.from("a"), appProperties: {} }),
    ).rejects.toBeInstanceOf(DriveApiError);
    expect(calls).toHaveLength(1);
  });

  it("rename: 名前だけを PATCH", async () => {
    const { fetch, calls } = fake([{ status: 200, body: { id: "f1" } }]);
    const c = new DriveClient("tok", fetch);
    await c.rename("f1", "新しい名前.pdf");
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ name: "新しい名前.pdf" });
  });

  it("失敗はファイル名を含まないエラー・401 は再接続が要る", async () => {
    const { fetch } = fake([{ status: 401, body: {} }]);
    const c = new DriveClient("tok", fetch);
    const e = await c.download("秘密の名前").catch((x) => x);
    expect(e).toBeInstanceOf(DriveApiError);
    expect(e.needsReconnect).toBe(true);
    expect(String(e.message)).not.toContain("秘密");
  });
});
