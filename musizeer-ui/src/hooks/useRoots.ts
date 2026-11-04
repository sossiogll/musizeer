import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRoots, getSettingsSchema } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useI18n } from "@/i18n";
import type { FolderSettingRef } from "@/types";

/** The root folders and every folder setting (administrators only; the page and the folder control share this one read). */
export function useRoots() {
  return useQuery({ queryKey: queryKeys.roots, queryFn: getRoots });
}

/**
 * The name of a folder setting in the viewer's language: the dictionary entry its definition names (GET /settings/schema,
 * the same query the settings pages use), else the text the server sent. A provider's folder keeps the label its
 * provider declared; nothing here knows which providers there are.
 */
export function useFolderLabel(): (ref: Pick<FolderSettingRef, "key" | "label">) => string {
  const { tx } = useI18n();
  const { data } = useQuery({ queryKey: queryKeys.settingsSchema, queryFn: getSettingsSchema });
  const definitions = useMemo(() => new Map((data?.settings ?? []).map((def) => [def.key, def])), [data]);
  return useCallback(
    ({ key, label }) => {
      const def = definitions.get(key);
      return def?.label_key ? tx(def.label_key, def.label || label) : (def?.label ?? label);
    },
    [definitions, tx],
  );
}
