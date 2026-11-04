import { expect, test, type APIRequestContext } from "@playwright/test";
import { REFRESH_KEY, account, adminAccount, login } from "./support";

// Root folders, end to end (ADR-0008): while the working folder is not set the shell warns, the user's download is
// refused with `working_folder_not_set` and nothing is queued; an administrator adds a root folder from the mounted
// volumes, sets the working folder in Administration › Root folders, and the warning goes away and the refusal with it.
//
// It changes the instance's folders, so it only runs on an instance that has none set (a fresh dev stack) and puts
// everything back in the end: the working folder is cleared and the root deleted, even when the spec fails half way.

interface Tokens {
  access_token: string;
  refresh_token: string;
}

const bearer = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.access_token}` });
/** The conventional folder the compose files mount for the downloads (ADR-0009); the spec reads the volumes the gateway lists. */
const WORK_PATH = ".musizeer-e2e-work";

async function status(request: APIRequestContext, tokens: Tokens) {
  return (await request.get("/api/auth/account/status", { headers: bearer(tokens) })).json();
}

test("downloads are blocked until the administrator sets the working folder in Root folders", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = adminAccount();
  test.skip(!admin, "needs the e2e administrator: run the suite with e2e/run.sh");

  const userContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const user = await login(userContext.request);
  const root = await login(adminContext.request, admin!);
  let rootId: string | null = null;
  try {
    const before = await status(adminContext.request, root);
    test.skip(!before.folders || before.folders.ready, "the instance has its folders set already: the spec would change them");
    test.skip(!before.folders.missing.includes("working_folder"), "the working folder is set: nothing to block");

    // --- a mounted volume the gateway lists
    const volumes = await adminContext.request.get("/api/roots/browse", { headers: bearer(root) });
    test.skip(!volumes.ok(), "the gateway cannot be asked for its volumes");
    const volume = (await volumes.json()).directories[0];
    test.skip(!volume, "the gateway has no mounted volume to use");

    // --- before: the user's download is refused and nothing is queued
    const refused = await userContext.request.post("/api/download/track", {
      headers: bearer(user),
      data: { provider: "e2e", id: "e2e-root-folders" },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).detail.error_code).toBe("working_folder_not_set");

    // --- the user sees the warning; the administrator is told which folder and gets the link
    const userPage = await userContext.newPage();
    await userContext.addInitScript(([key, token]) => localStorage.setItem(key, token), [REFRESH_KEY, user.refresh_token]);
    await userPage.goto("/");
    await expect(userPage.getByRole("status").filter({ hasText: "Downloads are not available until an administrator sets the folders." })).toBeVisible();

    const adminPage = await adminContext.newPage();
    await adminContext.addInitScript(([key, token]) => localStorage.setItem(key, token), [REFRESH_KEY, root.refresh_token]);
    await adminPage.goto("/");
    await expect(adminPage.getByRole("status").filter({ hasText: "Downloads are blocked: the working folder is not set." })).toBeVisible();

    // --- add the root folder with the picker
    await adminPage.getByRole("link", { name: "Set it" }).first().click();
    await expect(adminPage).toHaveURL(/\/admin\/roots\?folder=/);
    await adminPage.getByRole("button", { name: "Add a root folder" }).click();
    const dialog = adminPage.getByRole("alertdialog");
    await dialog.getByRole("button", { name: new RegExp(`^${volume.path.replace(/\//g, "\\/")}`) }).click();
    await dialog.getByLabel("Name").fill("E2E downloads");
    await dialog.getByRole("button", { name: "Add" }).click();
    const added = (await (await adminContext.request.get("/api/roots", { headers: bearer(root) })).json()).roots.find((r: { label: string }) => r.label === "E2E downloads");
    rootId = added?.id ?? null;
    expect(rootId).not.toBeNull();
    await expect(adminPage.getByRole("table", { name: "Root folders" }).getByText("E2E downloads")).toBeVisible();

    // --- set the working folder with the folder control
    await adminPage.getByRole("button", { name: /^Edit .*(folder|Cartella)/i }).first().click();
    const folderDialog = adminPage.getByRole("alertdialog");
    await folderDialog.getByLabel("Root folder").selectOption(rootId!);
    await folderDialog.getByLabel("Path inside it").fill(WORK_PATH);
    await expect(folderDialog.getByText(`${volume.path.replace(/\/$/, "")}/${WORK_PATH}`)).toBeVisible();
    await folderDialog.getByRole("button", { name: "Save" }).click();

    // --- after: the warning is gone and the server no longer refuses for the working folder
    await expect(adminPage.getByRole("status").filter({ hasText: "the working folder is not set" })).toHaveCount(0);
    const after = await status(userContext.request, user);
    expect(after.folders.working_folder.set).toBe(true);
    const allowed = await userContext.request.post("/api/download/track", { headers: bearer(user), data: { provider: "e2e", id: "e2e-root-folders" } });
    if (allowed.status() === 409) expect((await allowed.json()).detail.error_code).not.toBe("working_folder_not_set");
  } finally {
    // Put the instance back as it was: the working folder unset, then the root gone.
    await adminContext.request.patch("/api/settings", { headers: bearer(root), data: { workspace_dir: null } });
    if (rootId) await adminContext.request.delete(`/api/roots/${rootId}`, { headers: bearer(root) });
  }
});
