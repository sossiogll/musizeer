import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { DownloadCollectionButton } from "@/components/DownloadCollectionButton";
import { I18nProvider } from "@/i18n";
import { connectivityMock } from "@/test/connectivity-mock";
import { FOLDERS_READY, foldersMissing } from "@/test/roots";
import { viewerStatus } from "@/test/viewer";
import type { AuthConfig, ViewerMode } from "@/types";
import { useDownloadGate, useFolderStatus } from "./useFolderStatus";
import { useTrackDownload } from "./useTrackDownload";
import { makeTrack } from "@/test/fixtures";

let status: AuthConfig;
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ authConfig: status }) }));
vi.mock("@/lib/connectivity", async () => (await import("@/test/connectivity-mock")).connectivityModule());
vi.mock("@/components/ui/dropdown-menu", async () => (await import("@/test/dropdown-mock")).dropdownModule());
vi.mock("@/contexts/QueueContext", () => ({ useQueueActions: () => vi.fn(), useLiveState: () => undefined }));
const mockDownloadAlbum = vi.fn();
const mockDownloadTrack = vi.fn();
vi.mock("@/lib/api-client", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")),
  downloadAlbum: (...a: unknown[]) => mockDownloadAlbum(...a),
  downloadTrack: (...a: unknown[]) => mockDownloadTrack(...a),
  getMyRequests: async () => ({ items: [], total: 0, page: 1, limit: 200, pages: 1 }),
  getDownloadStates: async () => [],
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider>{children}</I18nProvider>
  </QueryClientProvider>
);

const as = (mode: ViewerMode, folders: Parameters<typeof viewerStatus>[2]) => {
  status = viewerStatus(mode, undefined, folders);
};

beforeEach(() => {
  connectivityMock.reset();
  mockDownloadAlbum.mockReset();
  mockDownloadTrack.mockReset();
});

describe("useFolderStatus", () => {
  it("is blocked, with the missing folders, when the status says so", () => {
    as("admin", foldersMissing({ admin: true, library: true }));
    const { result } = renderHook(() => useFolderStatus(), { wrapper });

    expect(result.current.blocked).toBe(true);
    expect(result.current.missing.map((m) => m.name)).toEqual(["working_folder", "library_folder"]);
  });

  it.each([["ready", FOLDERS_READY], ["unknown", undefined], ["a guest", null]])("is not blocked when the status is %s", (_name, folders) => {
    as("user", folders);
    expect(renderHook(() => useFolderStatus(), { wrapper }).result.current.blocked).toBe(false);
  });
});

describe("useDownloadGate", () => {
  it("lets downloads through when the folders are set", () => {
    as("user", FOLDERS_READY);
    expect(renderHook(() => useDownloadGate(), { wrapper }).result.current).toEqual({ disabled: false, reason: undefined });
  });

  it("tells an administrator which folder is missing", () => {
    as("admin", foldersMissing({ admin: true }));
    expect(renderHook(() => useDownloadGate(), { wrapper }).result.current).toEqual({
      disabled: true,
      reason: "Downloads are blocked: the working folder is not set.",
    });
  });

  it("tells a user to ask an administrator", () => {
    as("user", foldersMissing());
    expect(renderHook(() => useDownloadGate(), { wrapper }).result.current.reason).toBe("Downloads are not set up yet. Ask an administrator to set the folders.");
  });

  it("an unreachable server comes first", () => {
    connectivityMock.set({ online: false });
    as("user", foldersMissing());
    expect(renderHook(() => useDownloadGate(), { wrapper }).result.current.reason).toBe("Needs the server: not available while it is unreachable");
  });
});

describe("the download actions wait for the folders", () => {
  it("a collection button is disabled with the reason as its tooltip, and sends nothing", async () => {
    as("user", foldersMissing());
    render(<DownloadCollectionButton kind="album" provider="prov" id="al1" name="The Album" label="Download all" favoriteLabel="Download all and add to favorites" />, { wrapper });

    const button = await screen.findByRole("button", { name: "Download all and add to favorites" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Downloads are not set up yet. Ask an administrator to set the folders.");
    fireEvent.click(button);
    expect(mockDownloadAlbum).not.toHaveBeenCalled();
  });

  it("a track's download carries the reason to its slot, menu and player", () => {
    as("admin", foldersMissing({ admin: true, library: true }));
    const { result } = renderHook(() => useTrackDownload(makeTrack()), { wrapper });

    expect(result.current.disabledReason).toBe("Downloads are blocked: the working folder is not set.");
  });

  it("with the folders set the same button is enabled", async () => {
    as("user", FOLDERS_READY);
    render(<DownloadCollectionButton kind="album" provider="prov" id="al1" name="The Album" label="Download all" favoriteLabel="Download all and add to favorites" />, { wrapper });

    expect(await screen.findByRole("button", { name: "Download all and add to favorites" })).toBeEnabled();
  });
});
