// @vitest-environment happy-dom

import { describe, it } from "vitest";

// These tests target the scene-first UI which has not been implemented yet.
// Convert from it.todo back to it() once ProviderSettingsView renders
// data-scene selectors (Chunk 3 of the scene-first plan).

describe("ProviderSettingsView", () => {
  it.todo("renders scene selectors first without mutating provider config on mount");

  it.todo("opens add-provider sheet from the select action without changing current scene value");

  it.todo("adds provider models back into the scene options without auto-switching the scene");
});
