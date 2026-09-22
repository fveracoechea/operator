# Design

A diff is judged by where the functionality landed, before it is judged line by line.
A change can obey every line rule and still put the use case in the wrong module.
This axis reads placement.

A documented project rule always overrides this baseline.
The `code-review` skill treats a repo standard the same way.
Read the project's documented design rules, and any opinions document the agent's own context names.
Where one of them endorses what a section here would flag, the section is silent.

Invoke `codebase-design` when the agent lists it, for the vocabulary of module, interface, implementation, seam, depth, leverage and locality.
Invoke `react-composition` and `react-best-practices` when the agent lists them, for the two React sections.
Read the diff yourself when a skill is absent.

## Name the use case the change delivers, then find the module that owns it

Say in one sentence what use case the diff ships, then name the module whose interface delivers it.
A reviewer who cannot say that sentence has found the first finding, because the change has no owner.
Evidence: one use case spreads across files that no single module holds, or the commit message names a use case that no interface states.
Not a finding: a change that grows one module's implementation for a use case that module already delivers.

## Read a new helper file as a module that was not named

A new `utils`, `helpers`, `lib` or `shared` file is a module whose name nobody chose.
A function added to one of those files is the same thing.
Evidence: every caller of the new helper sits in one module, so the behaviour belongs in that module's implementation.
Not a finding: a helper with callers in three modules that share no owner yet.

## Judge a new folder by the capability it names, not the layer

A folder carries the name of the capability it delivers.
A folder named for a technical layer is the wrong axis, because one use case then splits across every layer folder and loses its locality.
Evidence: the diff adds a folder whose name is a layer, and one use case lands in two of them.
Not a finding: a layer name the framework itself requires.

## Count what the diff adds to the interface, not to the implementation

Count the exports the diff adds to a module.
Each new export is a fact every future caller must learn, so ask what it buys.
An export that buys less than it costs to learn takes depth away.
Evidence: the diff adds exports that each deliver one part of one use case, and the caller assembles them.
Not a finding: implementation that grows behind an interface that did not move.

## Refuse a caller that assembles parts to get a finished use case

A capability module ships the finished use case.
It owns the state rules and the UI together, so the caller learns one interface and gets the leverage of all of it.
A caller that wires the parts holds the module's state switches, which puts the seam in the wrong place.
Evidence: the diff adds a caller that imports a provider and its parts from one module and arranges them itself.
Not a finding: a design system component whose parts are its public interface.

## Apply the deletion test to new machinery

Imagine the new file deleted.
Complexity that reappears across callers earned its place.
Complexity that vanishes did not, so the file passes its arguments through.
Evidence: the new file forwards what it receives, or groups existing exports under one name, and no caller knows less than before.
Not a finding: a file whose deletion puts the same rule back into each of its callers.

## Compose parts instead of adding a mode

A boolean prop that selects what renders is a mode.
Three of them make eight states, and no test covers all eight.
Evidence: the diff adds a boolean prop, and the implementation branches on it to render different parts.
Not a finding: a boolean that reports one state or one attribute.

## Keep state where it already lives

The query cache is the state, and the URL keeps what the URL owns.
A copy beside either one is a second source of truth, which is how a mismatch starts.
Evidence: the diff adds state that copies the query cache or the URL, or an effect that synchronises one source to the other.
Not a finding: transient interaction state local to the interaction that owns it.

## Rank a design finding by what a later caller copies

A finding on a new interface that later callers copy is a blocker.
The diff is the cheapest moment to move it, because no caller has copied it yet.
A finding inside one implementation is a nice to have, because it stays where it is.
Not a finding: shape that the diff only touched and did not introduce.

## Write the finding as the interface you ask for

Name the module, name the interface, and give the shape of the change.
The author owns the implementation, so give the shape and stop there.
A finding reads like this: this interface exports three parts of one use case, so every caller assembles them; export the finished use case instead.
Do not post a replacement implementation, and do not ask for a rewrite of code the diff did not touch.
