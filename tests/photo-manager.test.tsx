import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const actions = vi.hoisted(() => ({ removePhoto: vi.fn(), reorderPhotos: vi.fn() }));
// SEC-007: stands in for POST /api/photos, which receives the FormData and answers JSON { status }.
const upload = vi.hoisted(() => vi.fn());
const refreshPhotos = vi.hoisted(() => vi.fn());
vi.mock("@/server/photo-actions", () => actions);
vi.mock("@/server/onboarding-actions", () => ({ refreshOnboardingPhotos: refreshPhotos }));
import { PhotoManager } from "@/components/photo-manager";
const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const photo = () => new File(["synthetic"], "synthetic.webp", { type: "image/webp" });
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input !== "/api/photos" || init?.method !== "POST") throw new Error("Network forbidden");
    const result = await upload(init.body);
    return result instanceof Response ? result : Response.json({ status: result.status }, { status: result.status === "ok" ? 200 : 400 });
  });
  upload.mockResolvedValue({ status: "ok", photoId: b }); actions.reorderPhotos.mockResolvedValue({ status: "ok" }); actions.removePhoto.mockResolvedValue({ status: "ok" });
  refreshPhotos.mockResolvedValue([a, b]);
});
afterEach(() => {
  for (const [input, init] of fetchSpy.mock.calls) {
    expect(input).toBe("/api/photos");
    expect(init).toEqual({ method: "POST", body: expect.any(FormData), redirect: "manual", cache: "no-store" });
  }
  vi.restoreAllMocks();
});
const rows = () => within(screen.getByRole("list", { name: "登録した写真" })).getAllByRole("listitem");
const add = async (file = photo()) => userEvent.setup({ delay: null, applyAccept: false }).upload(screen.getByLabelText("写真を追加"), file);

describe("photo manager", () => {
  it("matches persisted main/order after deleting the first photo and uploading into its vacant position", async () => {
    const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    // SQL remove_photo leaves a gap; service_register_photo fills its first
    // vacant position. Keep this persistence model separate from UI ordering.
    const persisted = new Map([[a, 0], [b, 1]]);
    const canonical = () => [...persisted].sort((left, right) => left[1] - right[1]).map(([id]) => id);
    actions.removePhoto.mockImplementation(async (id: string) => { persisted.delete(id); return { status: "ok" }; });
    upload.mockImplementation(async () => {
      const position = [0, 1, 2, 3, 4, 5].find((value) => ![...persisted.values()].includes(value))!;
      persisted.set(c, position);
      return { status: "ok", photoId: c };
    });
    refreshPhotos.mockImplementation(async () => canonical());
    const onChange = vi.fn(); const user = userEvent.setup({ delay: null });
    const { unmount } = render(<PhotoManager initial={canonical()} onChange={onChange} />);
    await user.click(within(rows()[0]).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([b]));
    expect(persisted.get(b)).toBe(1);
    await add();
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([c, b]));
    expect(refreshPhotos).toHaveBeenCalledExactlyOnceWith();
    const displayed = () => rows().map((row) => within(row).getByRole("img").getAttribute("src"));
    expect(displayed()).toEqual(canonical().map((id) => `/media/photos/${id}`));
    expect(within(rows()[0]).getByText("メイン")).toBeInTheDocument();
    expect(onChange.mock.calls).not.toContainEqual([[b, c]]);
    unmount(); render(<PhotoManager initial={canonical()} />);
    expect(displayed()).toEqual([`/media/photos/${c}`, `/media/photos/${b}`]);
  });
  it.each(["null", "throw"])("hides uncertain order on a %s refresh failure and retries the read without reuploading", async (failure) => {
    if (failure === "null") refreshPhotos.mockResolvedValueOnce(null);
    else refreshPhotos.mockRejectedValueOnce(new Error("private provider detail"));
    const onChange = vi.fn(); render(<PhotoManager initial={[a]} onChange={onChange} />);
    await add();
    expect(await screen.findByRole("button", { name: "写真を再読み込み" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("現在保存できません。時間をおいて再度お試しください。");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByLabelText("写真を追加")).toBeDisabled();
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.queryByText("private provider detail")).not.toBeInTheDocument();
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "写真を再読み込み" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([a, b]));
    expect(upload).toHaveBeenCalledOnce();
    expect(refreshPhotos).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("写真を追加")).toBeEnabled();
  });
  it("keeps controls and completion pending until the canonical order has loaded", async () => {
    let finish!: (ids: string[]) => void;
    refreshPhotos.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onChange = vi.fn(), onPendingChange = vi.fn();
    render(<PhotoManager initial={[a]} onChange={onChange} onPendingChange={onPendingChange} />);
    await add();
    await waitFor(() => expect(refreshPhotos).toHaveBeenCalledOnce());
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByLabelText("写真を追加")).toBeDisabled();
    expect(screen.getByRole("button", { name: "写真を再読み込み" })).toBeDisabled();
    await act(async () => { finish([b, a]); });
    expect(onChange).toHaveBeenLastCalledWith([b, a]);
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });
  it("adds, reorders and removes through the actions and updates parent ids", async () => {
    const onChange = vi.fn(); const user = userEvent.setup({ delay: null });
    render(<PhotoManager initial={[a]} onChange={onChange} />);
    expect(screen.getByLabelText("写真を追加")).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
    expect(screen.getByRole("img", { name: "登録した写真 1" })).toHaveAttribute("src", `/media/photos/${a}`);
    expect(within(rows()[0]).getByText("メイン")).toBeInTheDocument();
    expect(within(rows()[0]).getByRole("button", { name: "前へ" })).toBeDisabled();
    const file = photo(); await add(file);
    await waitFor(() => expect(rows()).toHaveLength(2));
    // jsdom cannot decode images, so the original bytes go up under a neutral name (UI-014).
    const part = upload.mock.calls[0][0].get("photo") as File;
    expect([part.name, part.type, await part.text()]).toEqual(["photo.webp", "image/webp", "synthetic"]);
    expect(onChange).toHaveBeenLastCalledWith([a, b]);
    await user.click(within(rows()[1]).getByRole("button", { name: "前へ" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([b, a]));
    expect(actions.reorderPhotos).toHaveBeenLastCalledWith([b, a]);
    expect(screen.getByRole("img", { name: "登録した写真 1" })).toHaveAttribute("src", `/media/photos/${b}`);
    await user.click(within(rows()[0]).getByRole("button", { name: "後へ" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([a, b]));
    await user.click(within(rows()[1]).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(actions.removePhoto).toHaveBeenCalledWith(b); expect(onChange).toHaveBeenLastCalledWith([a]);
  });
  it.each([
    ["invalid", "JPEG、PNG、WebPの画像を選んでください。"],
    ["too_large", "4MB以下の画像を選んでください。"],
    ["too_many", "写真は6枚までです。"],
    ["rate_limited", "しばらくしてから再度お試しください。"],
    ["unauthenticated", "ログインの有効期限が切れました。"],
    ["unavailable", "現在保存できません。時間をおいて再度お試しください。"],
  ])("shows the fixed %s upload message", async (status, message) => {
    upload.mockResolvedValue({ status }); render(<PhotoManager initial={[]} />); await add();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    if (status === "unauthenticated") expect(screen.getByRole("link", { name: "ログインへ" })).toHaveAttribute("href", "/login?next=/onboarding");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("shows last_photo and retains the photo", async () => {
    actions.removePhoto.mockResolvedValue({ status: "last_photo" }); render(<PhotoManager initial={[a]} />);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "削除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("最後の1枚は削除できません。"); expect(rows()).toHaveLength(1);
  });
  it("retains order on failure and permits a keyboard retry", async () => {
    actions.reorderPhotos.mockResolvedValueOnce({ status: "unavailable" }); const user = userEvent.setup({ delay: null });
    render(<PhotoManager initial={[a, b]} />);
    const next = within(rows()[0]).getByRole("button", { name: "後へ" }); next.focus(); await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("現在保存できません。");
    expect(screen.getByRole("img", { name: "登録した写真 1" })).toHaveAttribute("src", `/media/photos/${a}`);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("img", { name: "登録した写真 1" })).toHaveAttribute("src", `/media/photos/${b}`));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("shows the 4MB limit in the hint", () => {
    render(<PhotoManager initial={[]} />);
    expect(screen.getByText("JPEG、PNG、WebP・4MB以下・6枚まで")).toBeInTheDocument();
  });
  it("checks 4 MiB before upload, including an oversized unaccepted type", async () => {
    render(<PhotoManager initial={[]} />);
    const oversized = new File(["synthetic"], "synthetic.txt", { type: "text/plain" }); Object.defineProperty(oversized, "size", { value: 4_194_305 });
    await add(oversized); expect(await screen.findByRole("alert")).toHaveTextContent("4MB以下の画像を選んでください。");
    expect(upload).not.toHaveBeenCalled();
    const boundary = photo(); Object.defineProperty(boundary, "size", { value: 4_194_304 }); await add(boundary);
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
  });
  it.each([
    ["an opaque login redirect", () => Object.defineProperty(new Response(null, { status: 200 }), "type", { value: "opaqueredirect" }), "ログインの有効期限が切れました。"],
    ["Vercel's plain-text 413", () => new Response("Request Entity Too Large FUNCTION_PAYLOAD_TOO_LARGE private-id", { status: 413, headers: { "Content-Type": "text/plain" } }), "4MB以下の画像を選んでください。"],
    ["the route's JSON 413", () => Response.json({ status: "too_large" }, { status: 413 }), "4MB以下の画像を選んでください。"],
    ["a non-JSON 404", () => new Response("<html>private page</html>", { status: 404, headers: { "Content-Type": "text/html" } }), "現在保存できません。時間をおいて再度お試しください。"],
    ["an unknown status", () => Response.json({ status: "private_code" }, { status: 400 }), "現在保存できません。時間をおいて再度お試しください。"],
    ["ok with an error status", () => Response.json({ status: "ok" }, { status: 500 }), "現在保存できません。時間をおいて再度お試しください。"],
    ["a JSON array", () => Response.json(["ok"]), "現在保存できません。時間をおいて再度お試しください。"],
  ])("maps %s from the upload route to a fixed message", async (_, response, message) => {
    upload.mockImplementation(async () => response()); render(<PhotoManager initial={[]} />); await add();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText(/private/)).not.toBeInTheDocument(); expect(refreshPhotos).not.toHaveBeenCalled();
  });
  describe("UI-014 client downscale", () => {
    const bitmap = { width: 3000, height: 2000, close: vi.fn() };
    let canvasType = "image/webp";
    beforeEach(() => {
      canvasType = "image/webp";
      vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
        callback(new Blob(["shrunk"], { type: type === "image/webp" ? canvasType : type }));
      });
    });
    afterEach(() => vi.unstubAllGlobals());
    const large = (size = 5_000_000, type = "image/png") => {
      const file = new File(["synthetic original"], "IMG_0001 private.png", { type }); Object.defineProperty(file, "size", { value: size }); return file;
    };
    const sent = () => upload.mock.calls[0][0].get("photo") as File;
    it("uploads the smaller WebP as photo.webp and closes the bitmap", async () => {
      const onChange = vi.fn(); render(<PhotoManager initial={[a]} onChange={onChange} />); await add(large());
      await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([a, b]));
      expect([sent().name, sent().type, await sent().text()]).toEqual(["photo.webp", "image/webp", "shrunk"]);
      expect(bitmap.close).toHaveBeenCalled();
    });
    it("uploads a JPEG fallback as photo.jpg when the browser does not encode WebP", async () => {
      canvasType = "image/png"; render(<PhotoManager initial={[]} />); await add(large());
      await waitFor(() => expect(upload).toHaveBeenCalledOnce());
      expect([sent().name, sent().type, await sent().text()]).toEqual(["photo.jpg", "image/jpeg", "shrunk"]);
    });
    it("keeps the original when the result is not smaller", async () => {
      render(<PhotoManager initial={[]} />); await add(large(3));
      await waitFor(() => expect(upload).toHaveBeenCalledOnce());
      expect([sent().name, sent().type, await sent().text()]).toEqual(["photo.png", "image/png", "synthetic original"]);
    });
    it("uploads the original unchanged when decoding fails", async () => {
      vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error("private decoder detail"));
      render(<PhotoManager initial={[]} />); await add(large(3_000_000, "image/jpeg"));
      await waitFor(() => expect(upload).toHaveBeenCalledOnce());
      expect([sent().name, sent().type, await sent().text()]).toEqual(["photo.jpg", "image/jpeg", "synthetic original"]);
      expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    });
    it("uploads an image over 4 MiB once it shrinks below the limit", async () => {
      render(<PhotoManager initial={[]} />); await add(large(4_194_305));
      await waitFor(() => expect(upload).toHaveBeenCalledOnce());
      expect(sent().name).toBe("photo.webp");
    });
    it("refuses a shrunk part still over 4 MiB without a fetch", async () => {
      vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) => { callback(new Blob([new Uint8Array(4_194_305)], { type: "image/webp" })); });
      render(<PhotoManager initial={[]} />); await add(large(8_000_000));
      expect(await screen.findByRole("alert")).toHaveTextContent("4MB以下の画像を選んでください。");
      expect(upload).not.toHaveBeenCalled();
    });
    it("keeps too_large for an image over 4 MiB that cannot be shrunk", async () => {
      vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error("decode failed"));
      const onPendingChange = vi.fn(); render(<PhotoManager initial={[]} onPendingChange={onPendingChange} />);
      const oversized = new File([new Uint8Array(4_194_305)], "private.jpg", { type: "image/jpeg" }); await add(oversized);
      expect(await screen.findByRole("alert")).toHaveTextContent("4MB以下の画像を選んでください。");
      expect(upload).not.toHaveBeenCalled(); expect(onPendingChange).toHaveBeenLastCalledWith(false);
    });
    it("holds the existing busy state while shrinking", async () => {
      let decode!: (value: typeof bitmap) => void;
      vi.mocked(createImageBitmap).mockReturnValueOnce(new Promise((resolve) => { decode = resolve; }) as never);
      const onPendingChange = vi.fn(); render(<PhotoManager initial={[a]} onPendingChange={onPendingChange} />); await add(large());
      await waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce());
      expect(screen.getByRole("region", { name: "登録する写真" })).toHaveAttribute("aria-busy", "true");
      expect(screen.getByLabelText("写真を追加")).toBeDisabled(); expect(onPendingChange).toHaveBeenLastCalledWith(true);
      expect(upload).not.toHaveBeenCalled();
      await act(async () => { decode(bitmap); });
      await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    });
  });
  it("rejects an unsupported type locally", async () => {
    render(<PhotoManager initial={[]} />); await add(new File(["synthetic"], "synthetic.txt", { type: "text/plain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("JPEG、PNG、WebPの画像を選んでください。"); expect(upload).not.toHaveBeenCalled();
  });
  it("disables adding at six and re-enables after removal", async () => {
    render(<PhotoManager initial={[a, b, "c", "d", "e", "f"]} />);
    expect(screen.getByLabelText("写真を追加")).toBeDisabled();
    await userEvent.setup({ delay: null }).click(within(rows()[5]).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(screen.getByLabelText("写真を追加")).not.toBeDisabled());
    expect(upload).not.toHaveBeenCalled();
  });
  it("locks all controls and runs one action at a time, then allows another", async () => {
    let finish!: (value: { status: string }) => void;
    actions.removePhoto.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onPendingChange = vi.fn(); render(<PhotoManager initial={[a, b]} onPendingChange={onPendingChange} />);
    const remove = within(rows()[0]).getByRole("button", { name: "削除" });
    fireEvent.click(remove); fireEvent.click(remove);
    fireEvent.click(within(rows()[1]).getByRole("button", { name: "前へ" }));
    await waitFor(() => expect(actions.removePhoto).toHaveBeenCalledOnce());
    expect(actions.reorderPhotos).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "登録する写真" })).toHaveAttribute("aria-busy", "true");
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.getByLabelText("写真を追加")).toBeDisabled(); expect(onPendingChange).toHaveBeenLastCalledWith(true);
    await act(async () => { finish({ status: "ok" }); });
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    await add(); await waitFor(() => expect(upload).toHaveBeenCalledOnce());
  });
  it("locks upload against a second selection and maps thrown errors safely", async () => {
    let reject!: (reason: Error) => void;
    upload.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    render(<PhotoManager initial={[]} />); const input = screen.getByLabelText("写真を追加");
    fireEvent.change(input, { target: { files: [photo()] } }); fireEvent.change(input, { target: { files: [photo()] } });
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    await act(async () => { reject(new Error("private provider detail")); });
    expect(await screen.findByRole("alert")).toHaveTextContent("現在保存できません。時間をおいて再度お試しください。");
    expect(screen.queryByText("private provider detail")).not.toBeInTheDocument(); expect(input).not.toBeDisabled();
  });
});
