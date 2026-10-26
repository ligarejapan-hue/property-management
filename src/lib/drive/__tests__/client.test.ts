/**
 * Google ドライブ API の薄い包み(第2段 2a)。fetch を差し込んで、問い合わせの形と応答の読み方を確かめる。
 * npm の部品は使わない(REST を直接)。
 */
import { describe, it, expect } from "vitest";
import { DriveClient, DriveApiError, FOLDER_MIME } from "../client";

type Call = { url: URL; init?: RequestInit };
function fake(responses: Array<{ status: number; body: unknown }>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe("DriveClient", () => {
  it("about: 接続したアカウントのメールだけを返す", async () => {
    const { fetch, calls } = fake([{ status: 200, body: { user: { emailAddress: "a@example.com", displayName: "A" } } }]);
    const c = new DriveClient("tok", fetch);
    expect(await c.about()).toEqual({ emailAddress: "a@example.com" });
    expect(calls[0].url.origin + calls[0].url.pathname).toBe("https://www.googleapis.com/drive/v3/about");
    expect(calls[0].url.searchParams.get("fields")).toBe("user(emailAddress)");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("listFolders(root): マイドライブ直下のフォルダだけ・ゴミ箱を除く・名前順・所有者つき", async () => {
    const { fetch, calls } = fake([
      {
        status: 200,
        body: {
          files: [
            { id: "f1", name: "ハマイハイライズ 305", mimeType: FOLDER_MIME, ownedByMe: true, owners: [{ emailAddress: "me@example.com" }] },
            { id: "f2", name: "2024", mimeType: FOLDER_MIME, ownedByMe: false, owners: [{ emailAddress: "other@example.com" }] },
          ],
          nextPageToken: "np",
        },
      },
    ]);
    const c = new DriveClient("tok", fetch);
    const r = await c.listFolders({ parent: "root" });
    expect(r).toEqual({
      folders: [
        { id: "f1", name: "ハマイハイライズ 305", ownedByMe: true, ownerEmail: "me@example.com" },
        { id: "f2", name: "2024", ownedByMe: false, ownerEmail: "other@example.com" },
      ],
      nextPageToken: "np",
    });
    const q = calls[0].url.searchParams.get("q") ?? "";
    expect(q).toContain("'root' in parents");
    expect(q).toContain(`mimeType = '${FOLDER_MIME}'`);
    expect(q).toContain("trashed = false");
    expect(calls[0].url.searchParams.get("orderBy")).toBe("name");
    expect(calls[0].url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(calls[0].url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
  });

  it("listFolders(フォルダの中): 共有ドライブの中も読めるよう、すべてのドライブを対象にする", async () => {
    const { fetch, calls } = fake([{ status: 200, body: { files: [] } }]);
    await new DriveClient("tok", fetch).listFolders({ parent: "0AbCdEfGhIjKlUk9PVA" });
    expect(calls[0].url.searchParams.get("corpora")).toBe("allDrives");
    expect(calls[0].url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
  });

  it("listFolders(root・shared): マイドライブ・共有アイテムは今までどおり(対象を広げない)", async () => {
    const { fetch, calls } = fake([
      { status: 200, body: { files: [] } },
      { status: 200, body: { files: [] } },
    ]);
    const c = new DriveClient("tok", fetch);
    await c.listFolders({ parent: "root" });
    await c.listFolders({ parent: "shared" });
    expect(calls[0].url.searchParams.get("corpora")).toBeNull();
    expect(calls[1].url.searchParams.get("corpora")).toBeNull();
  });

  it("listFolders(shared): 共有されたフォルダ(sharedWithMe)", async () => {
    const { fetch, calls } = fake([{ status: 200, body: { files: [] } }]);
    await new DriveClient("tok", fetch).listFolders({ parent: "shared" });
    expect(calls[0].url.searchParams.get("q")).toContain("sharedWithMe = true");
  });

  it("listFolders(name で絞る): 名前の ' と \\ を逃がす(検索文字列の注入を防ぐ)", async () => {
    const { fetch, calls } = fake([{ status: 200, body: { files: [] } }]);
    await new DriveClient("tok", fetch).listFolders({ parent: "f1", nameContains: "a'b\\c" });
    const q = calls[0].url.searchParams.get("q") ?? "";
    expect(q).toContain("'f1' in parents");
    expect(q).toContain("name contains 'a\\'b\\\\c'");
  });

  it("getFolder: フォルダでなければ null・親と名前と webViewLink を返す", async () => {
    const { fetch } = fake([
      { status: 200, body: { id: "f1", name: "売却", mimeType: FOLDER_MIME, parents: ["p0"], trashed: false, webViewLink: "https://drive.google.com/x" } },
    ]);
    expect(await new DriveClient("tok", fetch).getFolder("f1")).toEqual({
      id: "f1", name: "売却", parents: ["p0"], trashed: false, webViewLink: "https://drive.google.com/x", ownedByMe: false,
    });
    const { fetch: f2 } = fake([{ status: 200, body: { id: "x", name: "a.pdf", mimeType: "application/pdf" } }]);
    expect(await new DriveClient("tok", f2).getFolder("x")).toBeNull();
  });

  it("folderPath: 親を最大4段たどって『親 › 子』の形(root は含めない)", async () => {
    const { fetch } = fake([
      { status: 200, body: { id: "f2", name: "売却", mimeType: FOLDER_MIME, parents: ["f1"] } },
      { status: 200, body: { id: "f1", name: "ハマイハイライズ 305", mimeType: FOLDER_MIME, parents: ["root0"] } },
      { status: 200, body: { id: "root0", name: "マイドライブ", mimeType: FOLDER_MIME } },
    ]);
    expect(await new DriveClient("tok", fetch).folderPath("f2")).toBe("ハマイハイライズ 305 › 売却");
  });

  it("★404 は null・401 は DriveApiError(status=401・needsReconnect)", async () => {
    const { fetch } = fake([{ status: 404, body: { error: { message: "not found" } } }]);
    expect(await new DriveClient("tok", fetch).getFolder("zz")).toBeNull();
    const { fetch: f401 } = fake([{ status: 401, body: { error: { message: "Invalid Credentials" } } }]);
    const err = await new DriveClient("tok", f401).about().catch((e) => e);
    expect(err).toBeInstanceOf(DriveApiError);
    expect(err.status).toBe(401);
    expect(err.needsReconnect).toBe(true);
  });
});
