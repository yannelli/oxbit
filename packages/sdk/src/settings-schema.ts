import schema from "./settings.schema.json" with { type: "json" };

export const settingsSchema = schema;
export const SETTINGS_SCHEMA_URI = schema.$id;
