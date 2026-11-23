# deep-modules/lib-imports

Library code can import files under configured library roots and ordinary external packages.
It cannot depend on project application or tooling files, including types.
Move feature-owned behavior into its feature. Keep ownerless reusable functions in the library.

This rule uses the same project configuration, aliases, package-self resolution and literal loading syntax as
[module-imports](module-imports.md). Explicitly excluded source files do not receive findings.
Library roots take precedence over module roots, so one import produces one policy finding.
Computed targets and opaque loaders have the same documented static-analysis limits.
