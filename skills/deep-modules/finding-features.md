# Find the feature that owns a change

The step itself, name the noun and search `src/` for it, is in [SKILL.md](SKILL.md).
This file is what you consult while you do it.

## Tell a feature from a backend service

A backend service, such as `billing-api`, serves several features.
Its transport, session and error mapping are a capability.
Each feature's operations belong to that feature.

A change can touch two features.
Name both, and give each part of the change to its owner.

## A feature can live in five places with no module

In a billing app the noun `invoice` can appear in five places, none of them a module named for it:

| Place                                             | What it knows about invoices                       |
| ------------------------------------------------- | -------------------------------------------------- |
| `modules/billing-api/main.server.ts`              | the list, send and void calls to the backend       |
| `modules/query-options/billing.ts`                | the reads, and which keys a send or void refreshes |
| `modules/selectors/billing.ts`                    | `overdueInvoices`, `invoiceTotal`                  |
| `routes/dashboard/-overview/overdue-invoices.tsx` | the rows, the menu, the skeleton                   |
| `modules/customers/ui/balance-card.tsx`           | the open invoices shown on a customer              |

A change to what an invoice is touches all five, and no single file tells a reader where they are.
That is an `invoices` module the code base never named.

## Read these signs as a missing module

- The noun appears in a route folder, a layer module and a backend module.
- A module is named after a technical role, such as `query-options`, `selectors`, `api`, `hooks` or `utils`. That is a layer.
- A module is named after a backend service, and its methods cover several nouns.
- A type such as `Invoice` is declared, or narrowed, in a file that no invoices module owns.
- One module holds the cache rules for data that another module fetches.
- Two screens show the same noun, and each one imports it from a different place.
- A route's `-` folder holds files that read data or hold rules about a domain noun.

## Give a feature its module even when one route uses it

A feature module with one caller passes the deletion test in [interface-design.md](interface-design.md) when its reads, rules and UI would otherwise move into a route folder and two layer modules.

A page's `-` folder keeps the pieces of that page's own layout, such as the grid that arranges the sections.
Code that knows a domain noun goes in the feature's module from its first line, not after a second route asks for it.

## Split a module named after a backend or a layer by feature

- The transport, the session and the error mapping stay as a capability module that every feature uses.
- Each feature module owns its operations, its reads, its transforms, its cache rules and its UI.
- A repo that keeps one aggregator, such as a `$` query-options builder, lets the aggregator import each feature's part from the feature's entry file. The logic stays in the feature.
- The aggregator is for route loaders and other modules. The feature's own UI reads its data through a relative path, so the aggregator depends on the feature in one direction only, and no cycle forms between the two modules.

## Follow the repo's ADR where it keeps a layer module

A repo can record a layer module as a decision, such as one query-options module that holds a slice for each feature.
Where an ADR says so, put the new code where the ADR says, and keep everything else in the feature's module.
Name the conflict in your proposal, so the team can amend the ADR (the `adr` skill).

## Put new code in the feature's module, and propose the move for old code

When the repo already spreads a feature across routes and layers, write the new code in the feature's module and create the module when it does not exist yet.
When the new code needs an operation that still lives in the old place, call it there, and add it to the move.
Every place from the search is either in this change or on the move list.
Give the move list to the user as a proposed move, a follow-up ticket or a note in the pull request.
