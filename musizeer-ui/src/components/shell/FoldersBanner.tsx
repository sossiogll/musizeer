import { Link } from "@tanstack/react-router";
import { FolderX } from "lucide-react";
import { useCan } from "@/hooks/useCapabilities";
import { MISSING_FOLDER_TEXT, useFolderStatus } from "@/hooks/useFolderStatus";
import { useI18n } from "@/i18n";

/**
 * Shown for as long as a folder the downloads need is not set (ADR-0008), the way Lidarr warns when it has no root folder.
 * An administrator is told which folder is missing, why when the server says (`detail`), and gets the link to set it; any
 * other viewer only learns that downloads are not available until an administrator sets the folders. The state is the
 * server's (`folders` of the viewer status): nothing is guessed here.
 */
export function FoldersBanner() {
  const { blocked, missing } = useFolderStatus();
  const admin = useCan("admin");
  const { t } = useI18n();
  if (!blocked) return null;

  return (
    <div role="status" className="flex items-start gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm">
      <FolderX aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      {admin ? (
        <ul className="min-w-0 flex-1 space-y-1.5">
          {missing.map(({ name, folder }) => (
            <li key={name} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="font-medium">{t(MISSING_FOLDER_TEXT[name])}</span>
              {folder.detail && <span className="text-muted-foreground">{folder.detail}</span>}
              <Link
                to="/admin/roots"
                search={folder.setting ? { folder: folder.setting } : {}}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {t("folders.banner.set")}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="min-w-0 flex-1">{t("folders.banner.user")}</p>
      )}
    </div>
  );
}
