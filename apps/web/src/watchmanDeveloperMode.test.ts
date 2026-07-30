import { describe, expect, it, vi } from "vite-plus/test";

import {
  isWatchmanDeveloperModeUnlocked,
  resolveWatchmanNewConversationModelSelection,
  selectedWatchmanAgent,
  tryUnlockWatchmanDeveloperMode,
  WATCHMAN_DEVELOPER_UNLOCK_KEY,
} from "./watchmanDeveloperMode";

function makeStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
  };
}

describe("Watchman Developer mode unlock", () => {
  it("does not gate Control or ordinary OpenCode agents", () => {
    expect(isWatchmanDeveloperModeUnlocked("watchman-control", { storage: null })).toBe(true);
  });

  it("rejects a wrong passcode without remembering it", () => {
    const storage = makeStorage();
    expect(tryUnlockWatchmanDeveloperMode("wrong", { storage })).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(isWatchmanDeveloperModeUnlocked("watchman-developer", { storage })).toBe(false);
  });

  it("remembers the correct passcode on the device", () => {
    const storage = makeStorage();
    expect(tryUnlockWatchmanDeveloperMode("24759", { storage })).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(WATCHMAN_DEVELOPER_UNLOCK_KEY, "true");
    expect(isWatchmanDeveloperModeUnlocked("watchman-developer", { storage })).toBe(true);
  });

  it("reads the selected OpenCode agent from native model options", () => {
    expect(
      selectedWatchmanAgent({
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "agent", value: "watchman-developer" },
        ],
      }),
    ).toBe("watchman-developer");
  });

  it("uses the Watchman project default instead of unrelated sticky provider state", () => {
    const projectDefault = {
      instanceId: "opencode" as never,
      model: "xai/grok-4.5",
      options: [{ id: "agent", value: "watchman-control" as const }],
    };
    expect(
      resolveWatchmanNewConversationModelSelection({
        projectDefault,
        carried: {
          instanceId: "codex" as never,
          model: "gpt-5.6-codex",
        },
      }),
    ).toEqual(projectDefault);
  });

  it("carries an explicit Watchman Developer selection into a new conversation", () => {
    const carried = {
      instanceId: "codex" as never,
      model: "gpt-5.6-codex",
      options: [{ id: "agent", value: "watchman-developer" as const }],
    };
    expect(
      resolveWatchmanNewConversationModelSelection({
        projectDefault: {
          instanceId: "opencode" as never,
          model: "xai/grok-4.5",
          options: [{ id: "agent", value: "watchman-control" as const }],
        },
        carried,
      }),
    ).toEqual(carried);
  });
});
