import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AxiosError, type AxiosResponse } from "axios";
import { connectivityMock } from "@/test/connectivity-mock";
import { renderPage } from "@/test/render";
import { checkReport, folder, libraryFolder, root } from "@/test/roots";
import type { FolderSetting, RootFolder } from "@/types";
import { AdminRootsPage } from "./roots";

vi.mock("@/lib/connectivity", async () => (await import("@/test/connectivity-mock")).connectivityModule());

let roots: RootFolder[];
let folders: FolderSetting[];
const mockAdd = vi.fn();
const mockEdit = vi.fn();
const mockDelete = vi.fn();
const mockCheck = vi.fn();
const mockPatch = vi.fn();
const mockBrowse = vi.fn();
const mockToast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@/lib/api-client", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")),
  getRoots: async () => ({ roots, folders }),
  getSettingsSchema: async () => ({
    settings: [{ key: "workspace_dir", label: "Cartella di lavoro", label_key: "settings.labels.workspace_dir", type: "folder" }],
    taxonomy: { areas: [], groups: [] },
  }),
  addRoot: (...a: unknown[]) => mockAdd(...a),
  editRoot: (...a: unknown[]) => mockEdit(...a),
  deleteRoot: (...a: unknown[]) => mockDelete(...a),
  checkRoot: (...a: unknown[]) => mockCheck(...a),
  patchSettings: (...a: unknown[]) => mockPatch(...a),
  browseRoots: (...a: unknown[]) => mockBrowse(...a),
}));

const render = (url = "/admin/roots") =>
  renderPage(AdminRootsPage, { path: "/admin/roots", url, validateSearch: (s) => (typeof s.folder === "string" ? { folder: s.folder } : {}) });

function refused(status: number, code: string, message: string, extra: object = {}): AxiosError {
  const response = { status, statusText: "", headers: {}, config: {} as never, data: { detail: { error_code: code, error_message: message, ...extra } } } as AxiosResponse;
  return new AxiosError("refused", "ERR_BAD_REQUEST", undefined, undefined, response);
}

beforeEach(() => {
  connectivityMock.reset();
  roots = [
    root({ id: "r1", label: "Downloads", path: "/downloads", used_by: [{ key: "workspace_dir", label: "Cartella di lavoro", group: "files" }] }),
    root({ id: "r2", label: "Library", path: "/library", state: "refused", reason: "not writable" }),
    root({ id: "r3", label: "Spare", path: "/spare", state: "unchecked" }),
  ];
  folders = [
    folder({ root_id: "r1", path: ".musizeer-work", resolved: "/downloads/.musizeer-work", state: "set", detail: "" }),
    libraryFolder(),
  ];
  mockAdd.mockReset().mockResolvedValue(root({ id: "r4" }));
  mockEdit.mockReset().mockResolvedValue(root());
  mockDelete.mockReset().mockResolvedValue({ ok: true });
  mockCheck.mockReset().mockResolvedValue(checkReport({ root: roots[0] }));
  mockPatch.mockReset().mockResolvedValue({});
  mockBrowse.mockReset().mockResolvedValue({
    path: null, parent: null, volume: null, truncated: false, directories: [{ name: "/spare", path: "/spare", free_bytes: 1024 ** 3 }],
  });
  Object.values(mockToast).forEach((m) => m.mockReset());
});

describe("Root folders table", () => {
  it("shows each root with its verdict, why it was refused and which folders use it", async () => {
    render();

    const table = await screen.findByRole("table", { name: "Root folders" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("/downloads")).toBeInTheDocument();
    expect(within(rows[0]).getByText("OK")).toBeInTheDocument();
    expect(await within(rows[0]).findByText("Working folder")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Refused")).toBeInTheDocument();
    expect(within(rows[1]).getByText("not writable")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Not checked")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Not used")).toBeInTheDocument();
  });

  it("says when there is no root folder", async () => {
    roots = [];
    render();

    expect(await screen.findByText(/No root folder yet/)).toBeInTheDocument();
  });

  it("Check runs the report and shows the free space and the verdict", async () => {
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Check Downloads" }));

    expect(await screen.findByText("Checked: writable, on a mounted volume.")).toBeInTheDocument();
    expect(screen.getByText("500 GB")).toBeInTheDocument();
    expect(mockCheck).toHaveBeenCalledWith("r1");
  });

  it("a working folder's root the application cannot see is a problem, not OK", async () => {
    mockCheck.mockResolvedValue(checkReport({
      root: roots[0], ok: false, state: "error", application: { exists: false, writable: false },
      checks: [
        { code: "gateway_ok", level: "ok", params: {} },
        { code: "application_required_missing", level: "error", params: {} },
      ],
    }));
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Check Downloads" }));

    const message = await screen.findByText(/working folder needs it/);
    expect(message).toHaveAttribute("data-level", "error");
    const row = message.closest("tr") as HTMLElement;
    expect(within(row).getByText("Problem")).toBeInTheDocument();
    expect(within(row).queryByText("OK")).not.toBeInTheDocument();
  });

  it("a provider-only root the application cannot see stays OK with an info note", async () => {
    mockCheck.mockResolvedValue(checkReport({
      root: roots[0], ok: true, state: "info", application: { exists: false, writable: false },
      checks: [
        { code: "gateway_ok", level: "ok", params: {} },
        { code: "application_not_needed", level: "info", params: {} },
      ],
    }));
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Check Downloads" }));

    const note = await screen.findByText("Not mounted in the application: not needed, only the provider uses it.");
    expect(note).toHaveAttribute("data-level", "info");
    expect(within(note.closest("tr") as HTMLElement).getByText("OK")).toBeInTheDocument();
  });

  it("a warning shows the warning badge", async () => {
    mockCheck.mockResolvedValue(checkReport({
      root: roots[0], state: "warning",
      checks: [{ code: "application_unused_missing", level: "warning", params: {} }],
    }));
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Check Downloads" }));

    const note = await screen.findByText(/Nothing uses this root yet/);
    expect(note).toHaveAttribute("data-level", "warning");
    expect(within(note.closest("tr") as HTMLElement).getByText("Warning")).toBeInTheDocument();
  });

  it("a root in use cannot be deleted, and the reason is on the button", async () => {
    render();

    const inUse = await screen.findByRole("button", { name: "Delete Downloads" });
    expect(inUse).toBeDisabled();
    await waitFor(() => expect(inUse).toHaveAttribute("title", "In use by Working folder: change those folders first"));
  });

  it("deleting a root that is not in use asks first", async () => {
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Delete Spare" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("r3"));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("Root folder deleted"));
  });

  it("everything that changes something is disabled while the server is unreachable", async () => {
    connectivityMock.set({ online: false });
    render();

    expect(await screen.findByRole("button", { name: "Add root folder" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Check Spare" })).toBeDisabled();
  });
});

describe("Add root folder", () => {
  it("picks a folder from the mounted volumes and adds it; the label is optional", async () => {
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Add root folder" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.click(await within(dialog).findByRole("button", { name: /^\/spare/ }));
    expect(within(dialog).getByLabelText("Path")).toHaveValue("/spare");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith({ path: "/spare", label: null }));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("Root folder added"));
  });

  it("a typed path and a label are sent as they are", async () => {
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Add root folder" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Path"), { target: { value: " /music " } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Music" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith({ path: "/music", label: "Music" }));
  });

  it("a root the gateway refuses is saved and the reason is shown", async () => {
    mockAdd.mockResolvedValue(root({ id: "r4", state: "refused", reason: "not on a mounted volume" }));
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Add root folder" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Path"), { target: { value: "/etc" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(mockToast.warning).toHaveBeenCalledWith("The gateway refused this root folder: not on a mounted volume"));
  });

  it("words the server's refusal in the dialog", async () => {
    mockAdd.mockRejectedValue(refused(409, "root_path_in_use", "Another root folder has this path"));
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Add root folder" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Path"), { target: { value: "/library" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    expect(await within(dialog).findByText("Another root folder already has that path.")).toBeInTheDocument();
  });
});

describe("Edit root folder", () => {
  it("renaming a root sends only the label", async () => {
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Edit Spare" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Backup" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockEdit).toHaveBeenCalledWith("r3", { label: "Backup" }, false));
  });

  it("moving a root in use asks first, listing what moves, and only then confirms", async () => {
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Edit Downloads" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Path"), { target: { value: "/mnt/downloads" } });
    expect(within(dialog).getByText(/1 folder is inside this root folder/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText("Move Downloads?")).toBeInTheDocument();
    expect(within(dialog).getByText("Working folder")).toBeInTheDocument();
    expect(mockEdit).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move it" }));

    await waitFor(() => expect(mockEdit).toHaveBeenCalledWith("r1", { path: "/mnt/downloads" }, true));
  });
});

describe("Folders table", () => {
  it("lists every folder setting with what it resolves to and why it is not set", async () => {
    render();

    const table = await screen.findByRole("table", { name: "Folders" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(await within(rows[0]).findByText("Working folder")).toBeInTheDocument();
    expect(within(rows[0]).getByText("/downloads/.musizeer-work")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Set")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Library folder")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Not set")).toBeInTheDocument();
  });

  it("edits a folder with the folder control and saves the setting", async () => {
    folders = [folder()];
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Edit Working folder" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(await within(dialog).findByLabelText("Root folder"), { target: { value: "r1" } });
    fireEvent.change(within(dialog).getByLabelText("Path inside it"), { target: { value: ".musizeer-work" } });
    expect(within(dialog).getByText("/downloads/.musizeer-work")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ workspace_dir: { root_id: "r1", path: ".musizeer-work" } }));
  });

  it("words the server's refusal of the value", async () => {
    folders = [folder()];
    mockPatch.mockRejectedValue(refused(422, "folder_root_refused", "refused"));
    render();

    fireEvent.click(await screen.findByRole("button", { name: "Edit Working folder" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(await within(dialog).findByLabelText("Root folder"), { target: { value: "r1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText(/refused by the gateway/)).toBeInTheDocument();
  });

  it("?folder= opens the dialog of that folder (where the warning leads)", async () => {
    folders = [folder()];
    render("/admin/roots?folder=workspace_dir");

    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("Working folder", { selector: "h2" })).toBeInTheDocument();
    expect(await within(dialog).findByLabelText("Root folder")).toBeInTheDocument();
  });

  it("with no root folder the dialog says to add one first, and the call to action opens the Add dialog", async () => {
    roots = [];
    folders = [folder()];
    render("/admin/roots?folder=workspace_dir");

    fireEvent.click(await screen.findByRole("button", { name: "Add a root folder" }));

    expect(await screen.findByText("Add a root folder", { selector: "h2" })).toBeInTheDocument();
  });
});
