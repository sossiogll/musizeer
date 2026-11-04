import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage } from "@/test/render";
import { FOLDERS_READY, foldersMissing } from "@/test/roots";
import { viewerStatus } from "@/test/viewer";
import type { AuthConfig, ViewerMode } from "@/types";
import { FoldersBanner } from "./FoldersBanner";

let status: AuthConfig;
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ authConfig: status }) }));

const show = (mode: ViewerMode, folders: Parameters<typeof viewerStatus>[2]) => {
  status = viewerStatus(mode, undefined, folders);
  return renderPage(FoldersBanner, { path: "/", otherPaths: ["/admin/roots"] });
};

describe("FoldersBanner", () => {
  it("tells an administrator which folder is missing and why, with the link to set it", async () => {
    const { router } = show("admin", foldersMissing({ admin: true, library: true }));

    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Downloads are blocked: the working folder is not set.");
    expect(banner).toHaveTextContent("The working folder is not set");
    expect(banner).toHaveTextContent("Nothing can be stored: the library folder is not set.");
    expect(banner).toHaveTextContent("The root folder Library is refused: not writable");
    const links = screen.getAllByRole("link", { name: "Set it" });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/admin/roots?folder=workspace_dir");
    expect(links[1]).toHaveAttribute("href", "/admin/roots?folder=provider.demo_storage.root_dir");
    expect(router).toBeDefined();
  });

  it("tells anyone else that downloads wait for an administrator, with no link", async () => {
    show("user", foldersMissing());

    expect(await screen.findByRole("status")).toHaveTextContent("Downloads are not available until an administrator sets the folders.");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it.each([
    ["folders ready", FOLDERS_READY],
    ["a status that says nothing", undefined],
    ["a guest, whose status has none", null],
  ])("shows nothing for %s", async (_name, folders) => {
    const { router } = show("admin", folders);

    await waitFor(() => expect(router.state.status).toBe("idle"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
