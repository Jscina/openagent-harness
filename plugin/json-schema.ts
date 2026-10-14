// ─── JSON Schema builders ─────────────────────────────────────────────────────
//
// Tiny helpers for the plain JSON Schema objects v2 `ctx.tool` accepts as a
// tool `input` (see V2_API_NOTES.md). Objects are closed
// (`additionalProperties: false`); a property is required unless wrapped in
// `optional()`.

export type JsonSchema = Record<string, unknown>;

const OPTIONAL = Symbol("optional");
type Optional = JsonSchema & { [OPTIONAL]: true };

export const str = (): JsonSchema => ({ type: "string" });
export const num = (): JsonSchema => ({ type: "number" });
export const bool = (): JsonSchema => ({ type: "boolean" });
export const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });
export const enumOf = (...values: string[]): JsonSchema => ({
  type: "string",
  enum: values,
});

/** Mark an object property as optional (the marker is stripped by `obj`). */
export const optional = (schema: JsonSchema): JsonSchema =>
  ({ ...schema, [OPTIONAL]: true }) as Optional;

/** Closed object schema; every property is required unless `optional()`. */
export function obj(props: Record<string, JsonSchema>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(props)) {
    if ((schema as Optional)[OPTIONAL]) {
      const { [OPTIONAL]: _omit, ...rest } = schema as Optional;
      properties[key] = rest;
    } else {
      properties[key] = schema;
      required.push(key);
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
    additionalProperties: false,
  };
}
