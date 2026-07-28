// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

function expandHome(value: string): string {
  if (value === "~") return NodeOS.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(NodeOS.homedir(), value.slice(2));
  }
  return value;
}

function normalizeWorkspacePath(value: string): string {
  const resolved = NodePath.resolve(expandHome(value.trim()));
  try {
    return NodeFS.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveWatchmanProjectRoot(
  raw: string | undefined = process.env.WATCHMAN_PROJECT_ROOT,
): string | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  return normalizeWorkspacePath(raw);
}

export function isWatchmanWorkspaceRoot(
  workspaceRoot: string | undefined,
  watchmanProjectRoot: string | undefined = process.env.WATCHMAN_PROJECT_ROOT,
): boolean {
  const projectRoot = resolveWatchmanProjectRoot(watchmanProjectRoot);
  return (
    typeof workspaceRoot === "string" &&
    projectRoot !== undefined &&
    normalizeWorkspacePath(workspaceRoot) === projectRoot
  );
}

/**
 * Developer conversations may use the canonical Watchman checkout or one of
 * that checkout's real Git worktrees. A matching agent marker in an unrelated
 * project is not enough to receive physical-control tools.
 */
export function isWatchmanProjectWorkspace(
  workspaceRoot: string | undefined,
  watchmanProjectRoot: string | undefined = process.env.WATCHMAN_PROJECT_ROOT,
): boolean {
  const projectRoot = resolveWatchmanProjectRoot(watchmanProjectRoot);
  if (typeof workspaceRoot !== "string" || projectRoot === undefined) return false;

  const workspace = normalizeWorkspacePath(workspaceRoot);
  if (workspace === projectRoot) return true;

  try {
    const dotGit = NodeFS.readFileSync(NodePath.join(workspace, ".git"), "utf8").trim();
    if (!dotGit.startsWith("gitdir:")) return false;
    const gitDir = normalizeWorkspacePath(
      NodePath.resolve(workspace, dotGit.slice("gitdir:".length).trim()),
    );
    const worktreesRoot = normalizeWorkspacePath(NodePath.join(projectRoot, ".git", "worktrees"));
    return (
      gitDir.startsWith(`${worktreesRoot}${NodePath.sep}`) && NodeFS.statSync(gitDir).isDirectory()
    );
  } catch {
    return false;
  }
}
