import {
  AuthAdministrativeScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthWatchmanVoiceScope,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sessionScopesForAccess } from "./auth.ts";

describe("auth session access", () => {
  it("issues only orchestration scopes for a headless agent client", () => {
    expect(sessionScopesForAccess("orchestration")).toEqual([
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
    ]);
    expect(sessionScopesForAccess("voice")).toEqual([AuthWatchmanVoiceScope]);
  });

  it("keeps administrative access as the explicit management default", () => {
    expect(sessionScopesForAccess("administrative")).toEqual(AuthAdministrativeScopes);
  });
});
