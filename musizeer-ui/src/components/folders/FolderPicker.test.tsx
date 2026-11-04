import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { AxiosError, type AxiosResponse } from "axios";
import { renderPage } from "@/test/render";
import type { RootBrowse } from "@/types";
import { FolderPicker, breadcrumbs } from "./FolderPicker";

const volume = { mount_point: "/library", fs_type: "ext4" };
const tree: Record<string, RootBrowse> = {
  "/library": {
    path: "/library", parent: null, volume, truncated: false,
    directories: [{ name: "Music", path: "/library/Music" }, { name: "Podcasts", path: "/library/Podcasts" }],
  },
  "/library/Music": { path: "/library/Music", parent: "/library", volume, truncated: false, directories: [] },
};
const mockBrowse = vi.fn();
vi.mock("@/lib/connectivity", async () => (await import("@/test/connectivity-mock")).connectivityModule());
vi.mock("@/lib/api-client", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")),
  browseRoots: (...a: unknown[]) => mockBrowse(...a),
}));

function refused(code: string, message: string, status = 422): AxiosError {
  const response = { status, statusText: "", headers: {}, config: {} as never, data: { detail: { error_code: code, error_message: message } } } as AxiosResponse;
  return new AxiosError("refused", "ERR_BAD_REQUEST", undefined, undefined, response);
}

function Harness({ onValue }: { onValue?: (v: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <FolderPicker
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

beforeEach(() => {
  mockBrowse.mockReset().mockImplementation(async (path: string | null) => {
    if (path === null) {
      return { path: null, parent: null, volume: null, truncated: false, directories: [{ name: "/library", path: "/library", fs_type: "ext4", free_bytes: 2 * 1024 ** 3 }] };
    }
    if (tree[path]) return tree[path];
    throw refused("gateway_refused", "is not on a mounted volume");
  });
});

describe("breadcrumbs", () => {
  it("starts at the volume and walks down to the folder", () => {
    expect(breadcrumbs(tree["/library/Music"]).map((c) => [c.name, c.path])).toEqual([["/library", "/library"], ["Music", "/library/Music"]]);
  });

  it("has none at the list of volumes", () => {
    expect(breadcrumbs({ path: null, parent: null, volume: null, truncated: false, directories: [] })).toEqual([]);
  });
});

describe("FolderPicker", () => {
  it("lists the mounted volumes first, with their free space", async () => {
    renderPage(() => <Harness />, { path: "/" });

    const list = await screen.findByRole("list", { name: "Volumes" });
    expect(within(list).getByText("/library")).toBeInTheDocument();
    expect(within(list).getByText("2 GB free")).toBeInTheDocument();
    expect(mockBrowse).toHaveBeenCalledWith(null);
  });

  it("opening a volume and a folder chooses it, and the breadcrumb leads back", async () => {
    const onValue = vi.fn();
    renderPage(() => <Harness onValue={onValue} />, { path: "/" });

    fireEvent.click(await screen.findByRole("button", { name: /^\/library/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Music" }));

    expect(onValue).toHaveBeenLastCalledWith("/library/Music");
    expect(screen.getByLabelText("Path")).toHaveValue("/library/Music");
    expect(await screen.findByText("No folder inside.")).toBeInTheDocument();

    const crumbs = screen.getByRole("navigation", { name: "Folder location" });
    expect(within(crumbs).getByText("Music")).toHaveAttribute("aria-current", "location");
    fireEvent.click(within(crumbs).getByRole("button", { name: "/library" }));
    expect(await screen.findByRole("button", { name: "Podcasts" })).toBeInTheDocument();

    fireEvent.click(within(crumbs).getByRole("button", { name: "Volumes" }));
    expect(await screen.findByRole("list", { name: "Volumes" })).toBeInTheDocument();
  });

  it("a typed path is opened with Browse", async () => {
    renderPage(() => <Harness />, { path: "/" });

    fireEvent.change(await screen.findByLabelText("Path"), { target: { value: "/library" } });
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    expect(await screen.findByRole("button", { name: "Podcasts" })).toBeInTheDocument();
  });

  it("words a path the gateway refuses", async () => {
    renderPage(() => <Harness />, { path: "/" });

    fireEvent.change(await screen.findByLabelText("Path"), { target: { value: "/etc" } });
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The folder picker cannot open that path: it has to be a folder inside a mounted volume.");
    expect(alert).toHaveTextContent("is not on a mounted volume");
  });
});
