import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderPage } from "@/test/render";
import { root } from "@/test/roots";
import type { ConfigSchemaResponse, SettingDef } from "@/lib/api-client";
import { SettingControl } from "./SettingControl";
import { SettingsArea } from "./SettingsArea";

const mockPatch = vi.fn();
let values: Record<string, unknown>;
const workingFolder: SettingDef = {
  key: "workspace_dir",
  type: "folder",
  group: "files",
  area: "library",
  label: "Cartella di lavoro",
  label_key: "settings.labels.workspace_dir",
  description: "",
  description_key: "settings.descriptions.workspace_dir",
  suggested_path: ".musizeer-work",
  admin_only: true,
  options: null,
  minimum: null,
  maximum: null,
  step: null,
  secret: false,
};
const schema: ConfigSchemaResponse = {
  settings: [workingFolder],
  taxonomy: { areas: [], groups: [{ key: "files", label_key: "settings.groups.files", label: "Files", description_key: "x", description: "", area: "library" }] },
};

vi.mock("@/lib/connectivity", async () => (await import("@/test/connectivity-mock")).connectivityModule());
vi.mock("@/lib/api-client", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")),
  getSettingsSchema: async () => schema,
  getSettingsValues: async () => values,
  getProviders: async () => ({ metadata: [], download: [], lyrics: [], storage: [], sync: [], identification: [] }),
  getRoots: async () => ({ roots: [root({ id: "r1", label: "Downloads", path: "/downloads" })], folders: [] }),
  patchSettings: (...a: unknown[]) => mockPatch(...a),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  values = { workspace_dir: null };
  mockPatch.mockReset().mockResolvedValue({ workspace_dir: { root_id: "r1", path: ".musizeer-work" } });
});

describe("a `folder` setting in the generated settings", () => {
  it("renders the folder control, labelled in the viewer's language, and saves the value as {root_id, path}", async () => {
    renderPage(() => <SettingsArea area="library" />, { path: "/", otherPaths: ["/admin/roots"] });

    expect(await screen.findByText("Working folder")).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("Root folder"), { target: { value: "r1" } });
    expect(screen.getByLabelText("Path inside it")).toHaveAttribute("placeholder", ".musizeer-work");
    fireEvent.change(screen.getByLabelText("Path inside it"), { target: { value: ".musizeer-work" } });
    expect(screen.getByText("/downloads/.musizeer-work")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ workspace_dir: { root_id: "r1", path: ".musizeer-work" } }));
  });

  it("clearing the folder saves it as unset", async () => {
    values = { workspace_dir: { root_id: "r1", path: "Work" } };
    renderPage(() => <SettingsArea area="library" />, { path: "/", otherPaths: ["/admin/roots"] });

    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith({ workspace_dir: null }));
  });

  it("SettingControl renders it for any setting of that type, a provider's too", async () => {
    const onChange = vi.fn();
    const providerFolder: SettingDef = { ...workingFolder, key: "provider.demo_storage.root_dir", label_key: undefined, label: "Library folder", suggested_path: null };
    renderPage(() => <SettingControl def={providerFolder} value={{ root_id: "r1", path: "" }} onChange={onChange} />, { path: "/" });

    expect(await screen.findByRole("group", { name: "Library folder" })).toBeInTheDocument();
    expect(screen.getByLabelText("Root folder")).toHaveValue("r1");
  });
});
