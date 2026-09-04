import { useMemo } from "react";
import { useParams } from "@tanstack/react-router";

import { useComposerDraftStore } from "../composerDraftStore";
import { useProjects, useThreadShell } from "../state/entities";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { watchmanSurfaceForModelSelection, type WatchmanSurface } from "../watchmanDeveloperMode";

/**
 * Derives the active household/developer surface from the model selection the
 * composer will actually send. This intentionally adds no second mode store.
 */
export function useActiveWatchmanSurface(): WatchmanSurface {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const threadShell = useThreadShell(routeThreadRef);
  const projects = useProjects();
  const draftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const composerModelSelection = useComposerDraftStore((store) => {
    if (!routeTarget) return null;
    const draft = store.getComposerDraft(
      routeTarget.kind === "server" ? routeTarget.threadRef : routeTarget.draftId,
    );
    const activeProvider = draft?.activeProvider;
    return activeProvider ? (draft.modelSelectionByProvider[activeProvider] ?? null) : null;
  });
  const draftProjectDefault = useMemo(() => {
    if (!draftSession) return null;
    return (
      projects.find(
        (project) =>
          project.environmentId === draftSession.environmentId &&
          project.id === draftSession.projectId,
      )?.defaultModelSelection ?? null
    );
  }, [draftSession, projects]);

  return watchmanSurfaceForModelSelection(
    composerModelSelection ?? threadShell?.modelSelection ?? draftProjectDefault,
  );
}
