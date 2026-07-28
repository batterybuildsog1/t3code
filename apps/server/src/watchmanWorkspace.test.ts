// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  isWatchmanProjectWorkspace,
  isWatchmanWorkspaceRoot,
  resolveWatchmanProjectRoot,
} from "./watchmanWorkspace.ts";

it("normalizes the configured Watchman root once", () => {
  assert.equal(resolveWatchmanProjectRoot(" /srv/watchman/ "), "/srv/watchman");
  assert.equal(isWatchmanWorkspaceRoot("/srv/watchman", "/srv/watchman/"), true);
  assert.equal(isWatchmanWorkspaceRoot("/srv/other", "/srv/watchman"), false);
  assert.equal(resolveWatchmanProjectRoot(""), undefined);
});

it("accepts only the canonical Watchman checkout and its real Git worktrees", () => {
  const temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-watchman-workspace-"));
  try {
    const root = NodePath.join(temp, "watchman");
    const worktree = NodePath.join(temp, "feature");
    const unrelated = NodePath.join(temp, "other");
    const gitDir = NodePath.join(root, ".git");
    const worktreeGitDir = NodePath.join(gitDir, "worktrees", "feature");
    NodeFS.mkdirSync(worktreeGitDir, { recursive: true });
    NodeFS.mkdirSync(worktree, { recursive: true });
    NodeFS.mkdirSync(unrelated, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

    assert.equal(isWatchmanProjectWorkspace(root, root), true);
    assert.equal(isWatchmanProjectWorkspace(worktree, root), true);
    assert.equal(isWatchmanProjectWorkspace(unrelated, root), false);
  } finally {
    NodeFS.rmSync(temp, { recursive: true, force: true });
  }
});
