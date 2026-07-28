import type { ModelSelection } from "@t3tools/contracts";

export const WATCHMAN_CONTROL_AGENT = "watchman-control";
export const WATCHMAN_DEVELOPER_AGENT = "watchman-developer";
export const WATCHMAN_CONTROL_PROVIDER_INSTANCE_ID = "opencode";
export const WATCHMAN_DEVELOPER_UNLOCK_KEY = "watchman:developer-unlocked";

type UnlockStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): UnlockStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function selectedWatchmanAgent(
  modelSelection: Pick<ModelSelection, "options">,
): string | undefined {
  const value = modelSelection.options?.find((option) => option.id === "agent")?.value;
  return typeof value === "string" ? value : undefined;
}

export function resolveWatchmanNewConversationModelSelection(input: {
  projectDefault: ModelSelection | null | undefined;
  carried: ModelSelection | null | undefined;
}): ModelSelection | null {
  const defaultAgent = input.projectDefault
    ? selectedWatchmanAgent(input.projectDefault)
    : undefined;
  if (defaultAgent !== WATCHMAN_CONTROL_AGENT && defaultAgent !== WATCHMAN_DEVELOPER_AGENT) {
    return input.carried ?? null;
  }
  const carriedAgent = input.carried ? selectedWatchmanAgent(input.carried) : undefined;
  return carriedAgent === WATCHMAN_CONTROL_AGENT || carriedAgent === WATCHMAN_DEVELOPER_AGENT
    ? input.carried!
    : input.projectDefault!;
}

/**
 * This is a remembered household mode switch, not an authentication boundary.
 * Control's real boundary remains the fail-closed OpenCode/MCP permissions.
 */
export function ensureWatchmanDeveloperModeUnlocked(
  agent: string | undefined,
  input: {
    storage?: UnlockStorage | null;
    requestPasscode?: () => string | null;
  } = {},
): boolean {
  if (agent !== WATCHMAN_DEVELOPER_AGENT) {
    return true;
  }
  const storage = input.storage === undefined ? browserStorage() : input.storage;
  try {
    if (storage?.getItem(WATCHMAN_DEVELOPER_UNLOCK_KEY) === "true") {
      return true;
    }
  } catch {
    // A disabled storage backend simply means the passcode is not remembered.
  }
  const requestPasscode =
    input.requestPasscode ?? (() => globalThis.prompt("Enter the Watchman Developer passcode"));
  if (requestPasscode() !== "24759") {
    return false;
  }
  try {
    storage?.setItem(WATCHMAN_DEVELOPER_UNLOCK_KEY, "true");
  } catch {
    // The current selection is still allowed; the device will ask again later.
  }
  return true;
}

export function ensureWatchmanDeveloperSelectionUnlocked(
  modelSelection: Pick<ModelSelection, "options">,
): boolean {
  return ensureWatchmanDeveloperModeUnlocked(selectedWatchmanAgent(modelSelection));
}
