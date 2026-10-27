# Design systems and UI

## Tokens and components

- Consistency beats local preference, and the reason is accessibility. A token inherits verified contrast, and a one-off class inherits nothing.
- A one-off class is a second design system that nothing measures. File the gap upstream and keep it as the smallest className. Never fake the component.
- Semantic tokens carry meaning. Categorical labels get a separate color family. The test is whether a screen reader user would also need the information.
- A `dark:` class is a smell. Every token already has a light and a dark value, so the class is redundant, structural, or a missing token.
- Read the compiled result, not the class. Modifiers compose in ways the class name does not show.
- Wire a token only when a real call site paints it. A custom property is not an API.
- Restriction lives in the API. Closed unions start small, typography components refuse className, and a required `as` turns an outline mistake into a compile error.
- A rare tool carries discovery friction. Negative space is a component, not a prop beside `gap` on every element.
- Geometry belongs to the component. A control that needs a different shape is a different control, which is a design conversation.
- Design tools own values only while a designer maintains them. When code leads, code owns the palette, and hand-off becomes a conversation, not a pipeline.
- Tuning a value by eye at the call site produces a third style that matches neither the old nor the target design.

## Accessibility

- Measure accessibility per WCAG criterion, never per token. The promise is AA as a target with documented exceptions.
- Color is never the only signal. Meaning lives in text, an icon, or ARIA.

## Screens and charts

- Show each fact once. A repeated date, page number, or section makes the reader ask which copy is right.
- Fix crowding with layout, not by hiding data.
- The visual regression golden diff is the design review. A tolerance threshold hides real changes.
- Charts are declared and painted only through the token layer. More categories than slots means fewer categories drawn.
- Calm UI: foreground text over semantic color, one spacing rhythm, one heading scale, real data or nothing.
