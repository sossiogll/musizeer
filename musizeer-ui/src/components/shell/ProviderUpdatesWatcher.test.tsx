import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { viewerStatus } from "@/test/viewer";
import { renderPage } from "@/test/render";
import { queryKeys } from "@/lib/query-keys";
import { ProviderUpdatesWatcher } from "./ProviderUpdatesWatcher";
import type { AuthConfig, StreamEvent } from "@/types";

let status: AuthConfig;
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ authConfig: status, user: { id: "admin-1" } }) }));
const mockToast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: mockToast }));

const mockInstalled = vi.fn();
let progressSource: { onmessage: ((e: MessageEvent) => void) | null } & Record<string, unknown> = { onmessage: null };
vi.mock("@/lib/api-client", () => ({
  getInstalledProviders: () => mockInstalled(),
  createProgressSource: () => {
    progressSource = { close: () => {}, onmessage: null, onopen: null, onerror: null, readyState: 1 };
    return progressSource;
  },
  refreshAccessToken: vi.fn(),
}));

/** The watcher, and the list of installed providers the Providers page reads. */
function Probe() {
  const installed = useQuery({ queryKey: queryKeys.installedProviders, queryFn: () => mockInstalled() });
  return (
    <>
      <ProviderUpdatesWatcher />
      <p data-testid="installed">{installed.data?.length ?? "-"}</p>
    </>
  );
}

const send = (event: StreamEvent) => act(() => progressSource.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));

beforeEach(() => {
  status = viewerStatus("admin");
  mockInstalled.mockReset().mockResolvedValue([]);
  Object.values(mockToast).forEach((fn) => fn.mockReset());
});

describe("a provider updated automatically", () => {
  it("is announced with its digests and the provider lists are read again", async () => {
    renderPage(() => <Probe />, { path: "/", queue: true });
    await waitFor(() => expect(screen.getByTestId("installed")).toHaveTextContent("0"));
    const reads = mockInstalled.mock.calls.length;

    send({ type: "provider_update", provider: { name: "words", label: "Words", from: "aaaaaaaaaaaa", to: "bbbbbbbbbbbb" } });

    expect(mockToast.info).toHaveBeenCalledWith("Words was updated automatically", { description: "aaaaaaaaaaaa → bbbbbbbbbbbb" });
    await waitFor(() => expect(mockInstalled.mock.calls.length).toBeGreaterThan(reads));
  });

  it("other events of the stream are not announced", async () => {
    renderPage(() => <Probe />, { path: "/", queue: true });
    await waitFor(() => expect(screen.getByTestId("installed")).toHaveTextContent("0"));

    send({ type: "download_request", event: "pending", pending: 1 } as StreamEvent);

    expect(mockToast.info).not.toHaveBeenCalled();
  });
});
