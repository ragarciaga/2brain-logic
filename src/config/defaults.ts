import type { VaultConfig } from "./vault-config.js";

/**
 * The config a vault gets when `.2brain/config.yaml` is absent or leaves a section out. The file
 * vault-template/.2brain/config.yaml spells out the same values and a test keeps them equal.
 */
export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  version: 1,
  vault: {
    archive_folder: "archive",
    inbox_folder: "inbox",
  },
  properties: {
    type: "type",
    area: "area",
    date: "date",
    source: "source",
    source_id: "source_id",
  },
  areas: ["personal", "work"],
  sources: [],
  types: {
    meeting: { value: "meeting", folder: "{area}/meetings", immutable_body: true },
    analysis: { value: "analysis", folder: "{area}/meetings" },
    project: { value: "project", folder: "{area}/projects" },
    resource: { value: "resource", folder: "{area}/resources" },
    email: { value: "email", folder: "{area}/resources" },
    topic: { value: "topic", folder: "topics" },
    person: { value: "person", folder: "people" },
    recipe: { value: "recipe", folder: "recipes" },
    idea: { value: "idea", folder: "inbox" },
    daily: { value: "daily", folder: "daily" },
    review: { value: "review", folder: "reviews" },
    session: { value: "session", folder: "{area}/sessions" },
  },
};
