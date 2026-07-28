import type { RuntimeMode } from "@t3tools/contracts";
import type { Agent, PermissionRuleset } from "@opencode-ai/sdk/v2";

import { buildOpenCodePermissionRules } from "./opencodeRuntime.ts";

export const WATCHMAN_CONTROL_AGENT = "watchman-control";
export const WATCHMAN_DEVELOPER_AGENT = "watchman-developer";

export type WatchmanOpenCodeMode = "control" | "developer";

export function watchmanOpenCodeMode(agent: string | undefined): WatchmanOpenCodeMode | undefined {
  switch (agent) {
    case WATCHMAN_CONTROL_AGENT:
      return "control";
    case WATCHMAN_DEVELOPER_AGENT:
      return "developer";
    default:
      return undefined;
  }
}

export function isWatchmanOpenCodeAgent(agent: string | undefined): boolean {
  return watchmanOpenCodeMode(agent) !== undefined;
}

const wildcardMatch = (input: string, pattern: string): boolean => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*")
    .replace(/\?/gu, ".");
  return new RegExp(`^${escaped}$`, "su").test(input);
};

function terminalToolDeny(agent: Agent, permission: string): boolean {
  const rule = agent.permission.findLast((candidate) =>
    wildcardMatch(permission, candidate.permission),
  );
  return rule?.pattern === "*" && rule.action === "deny";
}

function terminalPermissionDeny(agent: Agent, permission: string): boolean {
  const rule = agent.permission.findLast(
    (candidate) =>
      wildcardMatch(permission, candidate.permission) && wildcardMatch("*", candidate.pattern),
  );
  return rule?.action === "deny";
}

/**
 * Watchman sessions deliberately carry no T3 session wildcard because it
 * would override the project agent. Refuse to start if the selected project
 * profile is missing, or if Control is not visibly fail-closed.
 */
export function watchmanAgentProfileIssue(
  agents: ReadonlyArray<Agent>,
  requestedAgent: string | undefined,
): string | undefined {
  if (!isWatchmanOpenCodeAgent(requestedAgent)) return undefined;
  const agent = agents.find((candidate) => candidate.name === requestedAgent);
  if (!agent) {
    return `Required OpenCode agent '${requestedAgent}' is not available in this workspace.`;
  }
  if (requestedAgent === WATCHMAN_DEVELOPER_AGENT) return undefined;
  if (
    !terminalToolDeny(agent, "bash") ||
    !terminalToolDeny(agent, "edit") ||
    !terminalToolDeny(agent, "watchman-unknown-tool") ||
    !terminalPermissionDeny(agent, "external_directory") ||
    !terminalPermissionDeny(agent, "doom_loop")
  ) {
    return "The Watchman Control OpenCode profile is not fail-closed for mutation.";
  }
  return undefined;
}

/**
 * Watchman agents own their permissions in project-local OpenCode agent
 * definitions. A session-level wildcard would be merged after those rules
 * and override Control's code-mutation denials.
 */
export function buildOpenCodeSessionPermissionRules(
  runtimeMode: RuntimeMode,
  agent: string | undefined,
): PermissionRuleset {
  return isWatchmanOpenCodeAgent(agent) ? [] : buildOpenCodePermissionRules(runtimeMode);
}

export function crossesWatchmanModeBoundary(
  activeAgent: string | undefined,
  requestedAgent: string | undefined,
): boolean {
  const activeMode = watchmanOpenCodeMode(activeAgent);
  const requestedMode = watchmanOpenCodeMode(requestedAgent);
  return activeMode !== undefined && requestedMode !== undefined && activeMode !== requestedMode;
}
