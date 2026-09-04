import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate, useParams } from "@tanstack/react-router";
import { MessageSquareIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useThreadShells } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { watchmanSurfaceForModelSelection } from "../watchmanDeveloperMode";
import { Button } from "./ui/button";
import {
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";

const MAX_CONTROL_CONVERSATIONS = 30;

export function WatchmanControlSidebar() {
  const navigate = useNavigate();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeThreadKey =
    routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const threadShells = useThreadShells();
  const newThreadContext = useHandleNewThread();
  const { isMobile, setOpenMobile } = useSidebar();
  const controlThreads = useMemo(
    () =>
      threadShells
        .filter(
          (thread) =>
            thread.archivedAt === null &&
            watchmanSurfaceForModelSelection(thread.modelSelection) === "control",
        )
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, MAX_CONTROL_CONVERSATIONS),
    [threadShells],
  );

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const handleNewChat = useCallback(() => {
    closeMobileSidebar();
    void startNewThreadFromContext({
      ...newThreadContext,
      activeThread: newThreadContext.activeThread ?? undefined,
    });
  }, [closeMobileSidebar, newThreadContext]);

  return (
    <>
      <SidebarHeader className="shrink-0 gap-3 border-b border-sidebar-border px-3 pb-4 pt-3">
        <div className="flex h-9 items-center gap-2 md:ml-[var(--workspace-titlebar-content-left)]">
          <SidebarTrigger className="md:hidden" aria-label="Close conversations" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-tight">Watchman</div>
            <div className="text-xs text-sidebar-muted-foreground">Building control</div>
          </div>
        </div>
        <Button
          type="button"
          className="w-full justify-start gap-2"
          data-watchman-new-chat="control-sidebar"
          onClick={handleNewChat}
        >
          <PlusIcon className="size-4" />
          New chat
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="px-2 py-3">
          <div className="px-2 pb-2 text-xs font-medium text-sidebar-muted-foreground">
            Recent control chats
          </div>
          <SidebarMenu>
            {controlThreads.map((thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const threadKey = scopedThreadKey(threadRef);
              return (
                <SidebarMenuItem key={threadKey}>
                  <SidebarMenuButton
                    isActive={threadKey === activeThreadKey}
                    className="h-auto min-h-9 gap-2 py-2"
                    onClick={() => {
                      closeMobileSidebar();
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(threadRef),
                      });
                    }}
                  >
                    <MessageSquareIcon className="size-4 shrink-0" />
                    <span className="truncate">{thread.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
          {controlThreads.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
              Your control chats will appear here.
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
