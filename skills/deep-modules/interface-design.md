# Design a module's interface

Measure each rule against the caller.
The interface is deeper only when the caller has less to know, so moving exports to a new file or grouping functions under one name adds no depth.

Design a new interface twice, and a contested one too.
The `codebase-design` skill, topic `DESIGN-IT-TWICE.md`, compares two or three shapes on depth, locality and seam placement.

## Keep a module only when its deletion would spread complexity to its callers

Imagine you delete the module.
When the same logic would come back in its call sites, the module earns its place.
When nothing would come back, the module is a pass-through, so delete it.
The test measures what the module hides, not how many callers it has, so a feature with one route can pass it.

Apply the same test to each member of the interface object, and to each server function.
A same-process pass-through goes: `Invoices.remove` that calls `Store.delete` with the same arguments hides nothing, so give it more work, such as the cache refresh every caller does next, or remove it.
A method that is the feature's public operation over a transport, such as an RPC or an HTTP call, stays even when it is one line.
It names one call the feature allows, and the depth sits in the transport those methods share.
The transport is a capability, and its interface is general: a request method that any feature's operation calls.

## Ship the finished use case, not the steps

A caller that calls `load`, then `validate`, then `save` knows the module's order of operations.
Make that sequence one method, and keep the order inside.
A UI member is a finished screen part for the same reason, never a set of parts with the wiring left to the route, because a caller that assembles parts holds the module's state switches.

## Pull decisions down into the module

The module owns the base URL, the credentials, the retry policy, the cache key and the default page size.
A parameter that every caller sets to the same value belongs inside the module as the default.
A configuration option pushes a decision onto every caller, so add one only when two real callers need different values.

## Give each piece of knowledge one owner

When two modules both know a wire format, a cookie name or a query key shape, a change to it must touch both, and the two drift.
Pick the owner, and let the other module ask it.
For example, a write seeds the query cache through the read's own key, `invoices.detail({invoiceId}).queryKey`, so the key shape lives in one member.

## Split by knowledge, not by order of operations

Files named after the steps of one job, such as fetch, parse and render, all know the same format.
They belong to one module, or to one sub-module.
Draw a line where one side can change without the other side knowing.

## Define errors out of the interface where you can

Each error a caller must handle is part of the interface.
Remove the ones the module can absorb.
An end-session call on a session that is gone succeeds, and a list with no items returns an empty list.
Return the errors that remain as data in the result type, such as a `{ok: false, status}` branch, so the caller sees them in the signature.
An error thrown across a network boundary reaches the caller as an opaque transport failure.

## Name the module once

The folder, the interface object and every named part of the module elsewhere, such as a slice of a query-options builder, carry one name: `invoices`, `Invoices`, `$.invoices`.
A reader who searches for that one word finds every part of the module.
A folder named `billing-api` behind an `Invoices` object and a `$.billing` slice needs a second search.

## Review a module against its callers

Review is done when each of these holds for every member of every interface object, and for every server function:

- The member passes the deletion test above.
- Each caller uses it in one call, with no sequence of calls that the module could own.
- No caller passes a value that every other caller passes too.
- No caller reads a file of the module other than an entry file.
- The member's comment, when it has one, states a business rule, a trap or a contract, in one line.
