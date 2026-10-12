import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

describe("issue header action installation", () => {
  it("accepts the slot and requires the action capability", () => {
    const manifest = pluginManifestV1Schema.parse({
      id: "example.star", apiVersion: 1, version: "1.0.0", displayName: "Star", categories: ["ui"],
      description: "Personal stars", author: "Example", capabilities: ["ui.action.register"],
      entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
      ui: { slots: [{ type: "issueHeaderAction", id: "star", displayName: "Star", exportName: "Star", entityTypes: ["issue"] }] },
    });
    const validator = pluginCapabilityValidator();
    expect(validator.validateManifestCapabilities(manifest).allowed).toBe(true);
    expect(validator.checkUiSlot(manifest, "issueHeaderAction").allowed).toBe(true);
    expect(validator.validateManifestCapabilities({ ...manifest, capabilities: [] })).toMatchObject({ allowed: false, missing: ["ui.action.register"] });
  });
});
