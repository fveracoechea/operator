# Charts

`@tanstack/charts` draws a chart from a definition: rows, marks, scales and behavior, rendered by `Chart` from `@tanstack/charts/react`.
Nothing with a scale or an axis is hand-rolled out of boxes.
The package ships twelve skills of its own and they own the grammar.
This file owns what the package cannot know: how a chart in one of the team's apps is painted, formatted, memoised and tested.
In cerebro the decision is ADR-0014, the paint module is `@/lib/chart/paint`, the motion is `@/lib/chart/animation`, the formatter is `@/lib/format/figure`, the legend is `ChartLegend` in `src/components/chart/`, and the tokens are in `src/styles.css`.

## Load the package skill for the grammar, and this file for the paint

Load `@tanstack/charts#design-a-chart` the way `SKILL.md` says, the project's `intent` script when `package.json` has one and otherwise the runner the lockfile picks, before naming a chart type, even when the request names one.
Load `#configure-scales-guides-color` and `#prepare-chart-data` for the definition, `#ship-accessible-charts` before the pull request, and `#migrate-to-tanstack-charts` when a chart on another library is being replaced.
None of the twelve covers color, so the rules below are the team's and not the package's.

## Paint a series from the token layer or not at all

A definition carries no `theme` and no color literal, and no `var()` string is written at a call site.
The app's stylesheet aliases its popover tokens onto the library's tooltip variables, and a chart inherits them by being mounted.
Series color has no such bridge: the library's default palette is six slots deep and neither of the design system's chart sets is, so a bridge would reach past the last slot for a color nobody chose.
Every chart names its paint, so a chart that shows the library's own hexes is a break a reviewer can see.
The app's chart paint module is the one place a color string may exist, each entry is a `var(--token)` reference, and it is the only TypeScript that names a series token.
The app hard-codes no series value of its own; the sets are mystique's chart tokens.

A chart takes its whole paint from one of the module's three entry points, plus the neutral for a folded tail (next section).
The ranked ramp and the categorical set never meet in one chart, because a rank drawn in category colors reads as unrelated things, and unrelated things drawn in one ramp read as a rank:

- Parts of one measure, such as a share, a spend mix or a funnel, take the ranked ramp, largest first: `rankedPaint(names)`.
- Series that are different things take the categorical set by position: `categoricalPaint(names)`. Its slots after the first are the `warning`, `success` and `info` tones, so a series there reads as at-risk, healthy or informational. Order the series so that each reading is true.
- When every series carries its own meaning, the chart names each tone instead: `tonePaint(pairs)`. The tones follow the rule a badge follows: greenish is `success`, amber is `warning`, reddish is `destructive`, blue is `info`, and the same concept has one tone app-wide.

```ts
// Incorrect. A hex and a numbered palette both sit outside the token layer.
color: {domain: ['Savings', 'Risk'], range: ['#9333ea', 'var(--color-red-600)']}

// Correct. The paint module pairs the series with its tone.
color: tonePaint([['Savings', 'success'], ['Risk', 'destructive']])
```

`currentColor` is not a color literal; it is how text and guides follow the container.

## Name the series ahead of the data, and let the legend read the same pairing

The definition's `color` is a fixed `{domain, range}` from the paint module, built from the names the card knows before it has rows, so a category keeps its paint through a filter or a reorder.
Neither set grows a slot to fit: `rankedPaint` and `categoricalPaint` refuse more names than their set has, so a chart with more folds its tail into one "Other" series painted with the module's neutral, `chartPaint.neutral`, or draws fewer.
The HTML legend beside the chart takes that same pairing, so a swatch and a mark cannot disagree.
The library's own `colorLegend` is for a chart with no card around it.

```tsx
// Incorrect. The palette follows data order, so a filter recolors the survivors.
color: {range: chartPaint.categorical}

// Correct. Three kinds named once; the filtered rows keep their paint.
// The order is chosen: 'Notice required' takes the warning slot, and 'Free to lapse', which needs no action, takes success.
const paint = categoricalPaint(['Auto-renews', 'Notice required', 'Free to lapse'])
defineChart({marks: [barY(rows, {x: 'window', y: 'amount', z: 'kind', color: 'kind', layout: group()})], scales, color: paint})
<ChartLegend paint={paint} />
```

## Shape every bar the same

A bar is rounded at its value end and square at its baseline, whichever way it points: a vertical bar has no radius at the bottom, a horizontal bar none at the left.
Its thickness is whatever its band leaves after the band padding, so bars on a wide chart are wider than bars on a narrow one and no thickness cap fights the band.
Every bar chart keeps the same band padding and the same group padding, so two bar charts on one page read as one family.
In cerebro `@/lib/chart/bars` holds that shape: `barShape` is spread into every `barX` or `barY` mark, `barBand` is the band scale of every bar chart, and `barGroup` is the layout of grouped bars.
A stacked proportion bar is a `rect` mark over rows that carry their own start and end, spread with `segmentShape`: `rect` is the one mark that insets along the stack axis, so the gap between segments is a real gap and the same in both themes, and only the two outer ends round.
A stroke in the card's color is not a gap; it paints an outline wherever the card is translucent, which the dark theme's card is.

```ts
// Incorrect. The stroke reads as a gap on an opaque card and as an outline on a translucent one.
barX(rows, {x: 'amount', y: 'lane', z: 'kind', layout: stack(), radius: 3})
// with .chart-segmented .ts-chart__bar > * { stroke: var(--card); stroke-width: 3px }

// Correct. Real gaps from the mark's own inset, outer ends rounded, in both themes alike.
rect(segments, {
  x1: 'start',
  x2: 'end',
  y: 'lane',
  color: 'kind',
  ...segmentShape,
})
```

## Build the definition where its identity is stable

A new definition object rebuilds the scene, and the package's examples reach for `useMemo` to prevent that.
A project on the React Compiler does not write the hook.
A definition with no component inputs lives at module scope.
A definition derived from props or state is built in the component body, and the compiler keeps it stable while its inputs are.
Give every mark an `id`, because the library keys animation and focus on it and falls back to mark position without it.

## Move on the motion tokens

Every chart's `svgAnimation` is the app's one chart animation object; in cerebro that is `chartAnimation` from `@/lib/chart/animation`.

## Give the server its inputs

Pass `initialWidth` and `height` or `aspectRatio`; the server has no container to measure and falls back to 640 by 320.
Pass an `ariaLabel` that names the metric, the entities and the period, because `"Chart"` is the label the accessibility skill grades as a critical mistake.
SVG is the default renderer and stays so; Canvas is an opt-in per chart, justified at the call site by mark count.

## Format a figure once

The card headline, the axis `ticks.format` and the tooltip `format` read the same value through the app's figure formatter, with its unit and currency; in cerebro that is `compactCurrency` and `wholeCount` from `@/lib/format/figure`.
The tooltip `format` callback hands a typed point, so the formatter takes the datum's own field and no coercion sits beside a chart.

## Test the scene, not the pixels

Render the definition with `createChartScene` and `renderChartSvg` under the unit runner and assert on the points and the paint attributes.
No browser, no snapshot image, and no assertion that an element merely exists.
A route test that reads bars out of the mounted SVG selects `.ts-chart__bar > [fill]` (`.ts-chart__rect` for a proportion bar), because a bar rounded at one end is a `path` and a square one is a `rect`.
The selector lives in one helper per test file, so a bump that moves a class name is a fix in that helper.
A unit test on a bar's shape walks the scene's nodes for `rect` kinds and asserts on `cornerRadii`, `x` and `width`, not on the SVG string.
In cerebro `src/lib/chart/paint.test.ts` is the shape to copy, and `/dev-only/charts` (dev server only) draws the card prototypes and every paint path on the hub surface for a look in both themes.

## Pin the exact version

From 1.0 the package keeps a compatibility contract: a minor adds, a major breaks, and a deprecation lives through its major with a migration path.
The pin stays exact, because the team upgrades on a schedule and the contract leaves out the DOM class names, the scene nesting and the generated keys that the tests read.
Add it with an exact version, read the changelog on each bump, and run the chart tests before moving the pin.
Its skills reach the `intent` allowlist through the package, so a bump can add or rename one; list them again after moving the pin.
