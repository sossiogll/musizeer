import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useProgressEvents } from "@/contexts/QueueContext";
import { useI18n } from "@/i18n";
import { invalidateProviders } from "@/lib/sources";
import type { StreamEvent } from "@/types";

/**
 * Mounted once by the shell: when the automatic update moved a provider to a new digest (the server sends the
 * event to the admins only), a toast says which one, from any page, and the provider lists are read again.
 */
export function ProviderUpdatesWatcher() {
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const onEvent = useCallback(
    (event: StreamEvent) => {
      if (event.type !== "provider_update") return;
      const { label, from, to } = event.provider;
      toast.info(t("sources.autoUpdatedToast", { name: label }), { description: `${from} → ${to}` });
      void invalidateProviders(queryClient);
    },
    [queryClient, t],
  );

  useProgressEvents(onEvent);
  return null;
}
