type Host = "opencode" | "claude-code";

type Role = { host?: Host | undefined; model?: string | undefined };

type Selection = { operator?: Role | undefined; crew?: Role | undefined };

type Source =
  | "session-override"
  | "project-configuration"
  | "operator-host"
  | "host-default"
  | "unnamed";

type Field<Value> = { value: Value | null; source: Source };

type Resolved = {
  operator: { host: Field<Host>; model: Field<string> };
  crew: { host: Field<Host>; model: Field<string> };
};

function field<Value>(
  override: Value | undefined,
  configured: Value | undefined,
  fallback: Field<Value>,
): Field<Value> {
  if (override !== undefined) {
    return { value: override, source: "session-override" };
  }
  if (configured !== undefined) {
    return { value: configured, source: "project-configuration" };
  }

  return fallback;
}

export const AgentSelection = {
  /**
   * Resolves each field on its own from the session override, the project configuration, and the
   * host default. An omitted model stays with the selected host default, never the Operator model.
   */
  resolve(input: { overrides: Selection; configuration: Selection }): Resolved {
    const unnamed: Field<Host> = { value: null, source: "unnamed" };
    const hostDefault: Field<string> = { value: null, source: "host-default" };

    const operatorHost = field(
      input.overrides.operator?.host,
      input.configuration.operator?.host,
      unnamed,
    );
    const crewHost = field(
      input.overrides.crew?.host,
      input.configuration.crew?.host,
      operatorHost.value === null
        ? unnamed
        : { value: operatorHost.value, source: "operator-host" },
    );

    return {
      operator: {
        host: operatorHost,
        model: field(
          input.overrides.operator?.model,
          input.configuration.operator?.model,
          hostDefault,
        ),
      },
      crew: {
        host: crewHost,
        model: field(input.overrides.crew?.model, input.configuration.crew?.model, hostDefault),
      },
    };
  },

  /** Lists the hosts a launch under this selection would need to find installed. */
  requiredHosts(selection: Resolved): Host[] {
    const hosts = [selection.operator.host.value, selection.crew.host.value];
    return [...new Set(hosts.filter((host) => host !== null))].toSorted();
  },
};
