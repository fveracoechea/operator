import { describe, expect, test } from "bun:test";
import { OperatorConfig } from "./main.ts";

describe("Operator configuration", () => {
  test("accepts an empty selection", () => {
    expect(OperatorConfig.parse({ operator: {}, crew: {} })).toEqual({
      ok: true,
      config: { operator: {}, crew: {} },
    });
  });

  test("accepts the generated default file", () => {
    const parsed = OperatorConfig.parse(JSON.parse(OperatorConfig.defaultFileText()));

    expect(parsed.ok).toBe(true);
  });

  test("rejects an unknown field", () => {
    expect(OperatorConfig.parse({ operatr: {} })).toEqual({
      ok: false,
      issues: ['Unrecognized key: "operatr"'],
    });
  });

  test("rejects an unknown host", () => {
    expect(OperatorConfig.parse({ operator: { host: "cursor" } })).toEqual({
      ok: false,
      issues: ['operator.host: Invalid option: expected one of "opencode"|"claude-code"'],
    });
  });

  test("names the field of every reported issue", () => {
    const parsed = OperatorConfig.parse({ crew: { model: "" } });

    expect(parsed).toEqual({
      ok: false,
      issues: ["crew.model: Too small: expected string to have >=1 characters"],
    });
  });

  test("generates an editor schema that rejects the same unknown field", () => {
    const schema = JSON.parse(OperatorConfig.jsonSchemaText());

    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.operator.properties.host.enum).toEqual(["opencode", "claude-code"]);
  });

  test("points the default file at the generated schema beside it", () => {
    expect(JSON.parse(OperatorConfig.defaultFileText()).$schema).toBe("./config.schema.json");
  });
});
