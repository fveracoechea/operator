# Split a module into sub-modules

A sub-module is a folder inside a module that follows the module rules one level down.
It makes the module deeper.
The app sees the parent's object, and the rest of the parent sees the sub-module's object.
Each file then knows less, and the folder tree names the parts of the module.

## Give each sub-module one entry file that exports one object

In a chat module, a turn is one message sent and the answer it streams back.
The turn is a sub-module of chat:

```text
modules/chat/
  main.ts                Chat, the object routes import
  $functions.ts
  schemas.ts
  conversations.server.ts
  ui/
    main.ts              ChatUI
    panel.tsx
    chat-panel-provider.tsx
  turn/
    main.ts              Turn, the object the rest of chat imports
    turn.ts              POSTs the message, folds the frames into an answer
    turn-stream.ts       reads the event stream
    errors.ts
    turn-stream.test.ts
```

```ts
// chat/turn/main.ts
import {toAssistantFailure} from './errors'
import {runTurn} from './turn'

export type {TurnStep} from './turn'

/** One turn of a thread. `run` POSTs the message and reports the answer as it streams. */
export const Turn = {
  run: runTurn,
  /** A failed request phrased for the user, whatever threw. */
  failure: toAssistantFailure,
}
```

```ts
// chat/ui/chat-panel-provider.tsx
import {Turn} from '../turn/main'
```

The sub-module follows the module rules:

- `main.ts` exports one PascalCase object named after the folder, `turn/` as `Turn`, plus the types a caller names, such as `TurnStep`. A server-only sub-module uses `main.server.ts`.
- Every other file in the folder is private. The rest of `chat/` imports `../turn/main`, never `../turn/turn-stream`.
- Its files carry the same suffixes as a module's files, such as `.server.ts` and `.test.ts`.
- Imports point downward. `chat/` imports `turn/`, and `turn/` never imports `chat/main.ts`. It may parse against the parent's `schemas.ts`, reach a sibling sub-module through its `main`, and reach another module through its entry files.
- `ui/` is a sub-module too: `ui/main.ts` exports the `UI` object, and every `.tsx` behind it is private.

## Keep a sub-module private to its parent

A route reaches the turn through `Chat`, such as `<Chat.UI.Panel />`, and never learns that `Turn` exists.
When a caller outside the module needs the sub-module's behaviour, put a finished member on the parent's object.
The lint pattern in [entry-file-lint.md](entry-file-lint.md) rejects `@/modules/chat/turn/main` from outside the module.

## Add a sub-module when a group of files hides something

Without `turn/`, the panel provider imports the stream reader and the frame parsing, and learns the order: POST, read each frame, fold it into the answer, map the failure.
With it, the provider calls `Turn.run`, and a change to the stream format stays inside `turn/`.
That is the deletion test in [interface-design.md](interface-design.md), one level down: delete `turn/`, and its logic spreads across the files of `chat/`.

A folder that only sorts files by kind, such as `hooks/` or `utils/`, hides nothing and fails the test.

## Test a sub-module through its object

A sub-module's tests sit beside the files they cover, such as `turn/turn-stream.test.ts`, and a test of the whole turn calls `Turn`.
A test of `Chat` runs `Turn` real, because a sub-module is one of the module's own files ([module-tests.md](module-tests.md)).
