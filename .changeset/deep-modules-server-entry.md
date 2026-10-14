---
"@fveracoechea/operator": patch
---

The `deep-modules` skill no longer offers `main.client.ts` as an entry file, as in Jarvis.
TanStack Start renders every route component on the server, so a module has `main.ts` and, for server-only code, `main.server.ts`.
The entry-file lint pattern no longer allows `main.client`.
