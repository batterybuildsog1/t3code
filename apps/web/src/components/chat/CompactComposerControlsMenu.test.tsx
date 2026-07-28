import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";

describe("CompactComposerControlsMenu", () => {
  it("shows the Watchman mode without opening the menu", () => {
    const markup = renderToStaticMarkup(
      <CompactComposerControlsMenu
        activePlan={false}
        interactionMode="default"
        label="Developer"
        planSidebarLabel="Plan"
        planSidebarOpen={false}
        runtimeMode="full-access"
        showInteractionModeToggle={false}
        onToggleInteractionMode={() => undefined}
        onTogglePlanSidebar={() => undefined}
        onRuntimeModeChange={() => undefined}
      />,
    );

    expect(markup).toContain("Developer");
    expect(markup).toContain("More composer controls, Developer mode");
  });
});
