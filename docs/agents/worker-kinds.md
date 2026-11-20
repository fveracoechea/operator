# Person-defined worker kinds

Device settings accept a `kinds` object beside `profiles`.
Each key names a kind, and each value declares its defaults and work phases.

```json
{
  "kinds": {
    "audit": {
      "completion": "report",
      "resources": "pane",
      "profile": null,
      "nextKind": null,
      "readsNote": false,
      "guide": "audit/SKILL.md",
      "workPhases": [{ "name": "inspect", "goal": "Inspect the assigned evidence." }]
    }
  }
}
```

The guide names an installed skill, relative to the host's skill directory.
OpenCode also checks the upstream skill directory at `$HOME/.agents/skills`.
The launch snapshot and brief hold the guide's absolute path for the selected host.
Install the guide before adding its kind.

Names use lowercase letters, digits, and hyphens, start with a letter, and contain at most 64 characters.
A kind cannot reuse a built-in name.
Completion is `report` or `pr`, and at least one work phase is required.
Each phase may use one guard from ADR-0029's closed catalog.
A `nextKind` must exist and use the same completion type.
Person-defined kinds allow plain dispatch.

`profile`, `nextKind`, and `readsNote` default to `null`, `null`, and `false`.
`skillsToRead` defaults to an empty list, and `dispatchable` defaults to `true`.
Plan assignments name the kind and may override resources and profile, but never completion.
Running launches retain their resolved snapshot after settings change.
Dispatch refuses a settings edit that changes an already registered assignment's completion type.

For writable settings, use `operator config plan --set 'kinds.audit=<definition-json>'`, then apply the inspected plan.
Use `--unset kinds.audit` to remove a definition that no remaining definition needs.
For linked or read-only settings, edit the external configuration and rebuild it.
Operator validates these settings without replacing the file or link.

Settings reads, edits, registration, and dispatch reject invalid definitions with a reason and `next`.
Dispatch also checks that the guide is installed for the selected host.
One-off dispatch uses the same settings resolution boundary when that entry point lands in #387.
