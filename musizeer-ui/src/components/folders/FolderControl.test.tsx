import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderPage } from "@/test/render";
import { root } from "@/test/roots";
import type { RootFolder } from "@/types";
import { FolderControl } from "./FolderControl";

let roots: RootFolder[];
vi.mock("@/lib/connectivity", async () => (await import("@/test/connectivity-mock")).connectivityModule());
vi.mock("@/lib/api-client", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")),
  getRoots: async () => ({ roots, folders: [] }),
  browseRoots: (...a: unknown[]) => mockBrowse(...a),
}));

const mockBrowse = vi.fn();
const volume = { mount_point: "/downloads", fs_type: "ext4" };
const listing = (path: string, names: string[]) => ({
  path, parent: null, volume, truncated: false, directories: names.map((name) => ({ name, path: `${path}/${name}` })),
});

const onChange = vi.fn();
const onAddRoot = vi.fn();

function renderControl(props: Partial<React.ComponentProps<typeof FolderControl>> = {}) {
  return renderPage(
    () => <FolderControl value={null} onChange={onChange} label="Working folder" suggestedPath=".musizeer-work" {...props} />,
    { path: "/", otherPaths: ["/admin/roots"] },
  );
}

beforeEach(() => {
  roots = [root({ id: "r1", label: "Downloads", path: "/downloads" }), root({ id: "r2", label: "Library", path: "/library" })];
  onChange.mockReset();
  onAddRoot.mockReset();
});

describe("FolderControl", () => {
  it("with no root folder, says to add one first and links to the page", async () => {
    roots = [];
    renderControl();

    expect(await screen.findByText(/Add a root folder first/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a root folder" })).toHaveAttribute("href", "/admin/roots");
  });

  it("on the Root folders page the same call to action is a button", async () => {
    roots = [];
    renderControl({ onAddRoot });

    fireEvent.click(await screen.findByRole("button", { name: "Add a root folder" }));
    expect(onAddRoot).toHaveBeenCalled();
  });

  it("unset: no root is chosen, the path waits and shows the suggestion only as a placeholder", async () => {
    renderControl();

    const group = await screen.findByRole("group", { name: "Working folder" });
    expect(group).toBeInTheDocument();
    expect(screen.getByLabelText("Root folder")).toHaveValue("");
    const path = screen.getByLabelText("Path inside it");
    expect(path).toBeDisabled();
    expect(path).toHaveAttribute("placeholder", ".musizeer-work");
    expect(path).toHaveValue("");
    expect(screen.getByText("Not set: choose a root folder.")).toBeInTheDocument();
  });

  it("choosing a root sets it with an empty path: nothing is guessed", async () => {
    renderControl();

    fireEvent.change(await screen.findByLabelText("Root folder"), { target: { value: "r2" } });
    expect(onChange).toHaveBeenCalledWith({ root_id: "r2", path: "" });
  });

  it("shows the folder a value resolves to and follows the typing", async () => {
    renderControl({ value: { root_id: "r1", path: "Work" } });

    expect(await screen.findByText("/downloads/Work")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Path inside it"), { target: { value: "Work/tmp" } });
    expect(onChange).toHaveBeenCalledWith({ root_id: "r1", path: "Work/tmp" });
  });

  it("the empty path is the root itself", async () => {
    renderControl({ value: { root_id: "r2", path: "" } });

    expect(await screen.findByText("/library")).toBeInTheDocument();
  });

  it("says why a path cannot be used, and does not preview it", async () => {
    renderControl({ value: { root_id: "r1", path: "../x" } });

    expect(await screen.findByText(/cannot go up with/)).toBeInTheDocument();
    expect(screen.queryByText("Resolves to")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Path inside it")).toHaveAttribute("aria-invalid", "true");
  });

  it("offers the suggestion and applies it only when asked", async () => {
    renderControl({ value: { root_id: "r1", path: "" } });

    fireEvent.click(await screen.findByRole("button", { name: "Use .musizeer-work" }));
    expect(onChange).toHaveBeenCalledWith({ root_id: "r1", path: ".musizeer-work" });
  });

  it("clearing leaves the folder unset", async () => {
    renderControl({ value: { root_id: "r1", path: "Work" } });

    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  describe("Browse, scoped to the selected root", () => {
    beforeEach(() => {
      mockBrowse.mockReset().mockImplementation(async (path: string | null) => {
        if (path === "/downloads") return listing("/downloads", ["Music"]);
        if (path === "/downloads/Music") return listing("/downloads/Music", ["Rock"]);
        throw new Error(`outside the root: ${path}`);
      });
    });

    it("has no Browse until a root is chosen", async () => {
      renderControl();

      await screen.findByRole("group", { name: "Working folder" });
      expect(screen.queryByRole("button", { name: "Browse…" })).not.toBeInTheDocument();
    });

    it("opens at the root's path and picking a folder fills the path relative to the root", async () => {
      renderControl({ value: { root_id: "r1", path: "" } });

      fireEvent.click(await screen.findByRole("button", { name: "Browse…" }));
      fireEvent.click(await screen.findByRole("button", { name: "Music" }));
      expect(onChange).toHaveBeenLastCalledWith({ root_id: "r1", path: "Music" });

      fireEvent.click(await screen.findByRole("button", { name: "Rock" }));
      expect(onChange).toHaveBeenLastCalledWith({ root_id: "r1", path: "Music/Rock" });
      expect(mockBrowse).toHaveBeenCalledWith("/downloads");
    });

    it("cannot leave the root: no volumes, no typed path, nothing above the root to go back to", async () => {
      renderControl({ value: { root_id: "r1", path: "" } });

      fireEvent.click(await screen.findByRole("button", { name: "Browse…" }));
      fireEvent.click(await screen.findByRole("button", { name: "Music" }));
      await screen.findByRole("button", { name: "Rock" });

      const crumbs = screen.getByRole("navigation", { name: "Folder location" });
      expect(within(crumbs).queryByRole("button", { name: "Volumes" })).not.toBeInTheDocument();
      expect(within(crumbs).getAllByRole("button").map((b) => b.textContent)).toEqual(["/downloads"]);
      expect(screen.queryByLabelText("Path", { exact: true })).not.toBeInTheDocument();
      fireEvent.click(within(crumbs).getByRole("button", { name: "/downloads" }));
      expect(await screen.findByRole("button", { name: "Music" })).toBeInTheDocument();
      // Only ever the root and what is inside it was asked of the gateway.
      for (const [asked] of mockBrowse.mock.calls) expect(String(asked).startsWith("/downloads")).toBe(true);
    });
  });

  it("warns about a root folder the gateway refused", async () => {
    roots = [root({ id: "r1", label: "Downloads", path: "/downloads", state: "refused", reason: "not writable" })];
    renderControl({ value: { root_id: "r1", path: "" } });

    expect(await screen.findByText("This root folder is refused and cannot be used: not writable")).toBeInTheDocument();
  });
});
