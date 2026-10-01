# Badge placement: overlay (CSS anchor positioning) vs. in-flow

Design note, 2026-10-01. The prototype lives in commit `e5f7639` on branch `pi-subagents/proto-cba060c-9a8c-s0-t0` (`placeOverlay()` behind `const OVERLAY`); it was not merged. Rerun it from there before revisiting this question.
Measured on Chromium 151 (the Playwright test browser) with the real DOM fixtures.

## Recommendation: no-go as a replacement; optional hybrid only as a *first try*

The overlay removes the reflow heuristics, but on the layouts the extension exists for (product cards, price rows,
"price + qualifier" lines) there is almost never free space beside a price. In-flow placement works *because* it may add
space — grow a line, append a row after the card — and then proves nothing else moved. An overlay can only cover or
abstain. Of the three real-site shapes in `dom-regression` (Amazon detail row, Apple-style narrow selector, Yahoo image
capsule) the overlay places **none**; in-flow places all three.

Where the overlay wins (block paragraphs, padded cards, prices inside tight `overflow:hidden` rows) in-flow also mostly
succeeds, so a hybrid "overlay first, in-flow second" keeps all ~210 lines of flow heuristics and adds ~130. That is not
the simplification that motivated the experiment. The honest conclusion: the heuristics are the price of the product
behaviour, not accidental complexity.

## What the overlay removes from placement.js

`position:absolute` + `position-anchor` means the badge is not a line box, flex/grid item or block: `flowSnapshot`,
`preservesFlow`, `grewIntoFreeSpace`, `startsLine`, the scrollbar-delta compare, the "did the price box change size"
compare and the walk-up-three-ancestors fallback all go. The browser tracks the anchor through scroll, resize, zoom,
transforms and container queries without JS (verified: sibling anchor, ancestor anchor, anchor inside `<a>`, inside and
outside scroll containers, inside open shadow roots, under `transform`, under non-positioned `overflow:hidden`).

`layoutKey` and the resize/visibility re-check in `content.js` stay: the free-space decision is still a snapshot.

## What it must still solve (and how the prototype does it)

| Concern | Prototype | Verdict |
|---|---|---|
| Covering neighbouring content | Rect overlap against text line boxes + leaf/painted boxes of a bounded scope (`occupied`). Not `elementsFromPoint`: that returns nothing outside the viewport, and scans run on a tall page. | Works, but is the new heuristic surface: what counts as "painted", scope size, 1px slack. |
| Scroll / sticky / transform containers | Anchor positioning follows the anchor. `position-visibility: anchors-visible` hides the badge when the price scrolls out of a scroller. | Solved by the platform. |
| `overflow:hidden` ancestors | An absolute box is clipped only from its containing block upward (`clear()`); a static clipper between does not clip it. | Correct per spec, but means the badge *escapes* the price's row and lands on whatever is beside the row. On the fixture that is free space; on a real grid it is the next card. |
| Shadow DOM hosts | Badge is a sibling of the price inside the same root; anchor names resolve inside the root. | Works. One shadow test fails only because it reads `badge.parentElement` and the badge is now a root-level child. |
| Price inside `<a>` / button | Button badge mounts after the control, anchored to the price inside it. Span label path kept but never needed. | Works; but a details button that floats *over* a product link's padding steals clicks there. |
| Keyboard / a11y | Badge still DOM-adjacent (next sibling of price or its control): roving tabindex, arrow keys, dialog focus return unchanged. | Works. |
| Theme sampling | `backgroundTheme` walks the badge's DOM parents = the price's container. Covering a *different* painted box (e.g. a dark neighbour) would sample the wrong background. | Acceptable only because `occupied` forbids covering painted boxes. |
| Zoom / resize / virtual lists | Offsets are stored as `calc(anchor(...) + Npx)` from the price's text box; a reflow that moves the text within its element goes stale until `layoutKey` re-queues it. | Weaker than in-flow, where the badge moves with the text by construction. |
| Thousands of prices | One `anchor-name` per price element, one absolute box per badge. Chromium handles this; no measurable cost in fixtures. | Fine. |
| Chrome < 125 | Not handled (manifest says 120). Would need `getBoundingClientRect` + scroll/resize listeners for every badge, i.e. the whole thing again in JS. | Raise `minimum_chrome_version` to 125 or keep in-flow. |

## Test results under `OVERLAY = true` (`npm test`, Chromium 151)

57 / 64 pass. All 7 failures are DOM fixtures (each runs light + dark):

**In-flow assumptions in the tests (not regressions):**
- `fixed-height clipped row uses a safe adjacent flow position`: asserts the badge is *outside* `#clipped-row`; the overlay sits inside it, visually beside the price in free space.
- `no safe position means no invisible badge or expanded capsule`: asserts *no* badge; the overlay escapes the four nested clippers into free space.
- `prices with no room beside them in a tight flex/grid card get no tag`: the card has `padding-bottom:40px`; the overlay uses it. An overlay *win*.
- `badge in shadow root receives the extension stylesheet`: reads `getComputedStyle(badge.parentElement)`; parent is the ShadowRoot now.
- `a badge beside its price on the same line keeps its gap`: reads `margin-inline-start`; overlays use a `calc()` offset instead.
- `existing badge moves outside newly narrow prose`, `updated amount reuses a safe badge outside original copy`: assert the badge leaves the paragraph; the overlay stays anchored.

**Real losses (dense layouts: something tight to the right and below the price):**
- `Amazon detail JP¥ price has visible adjacent annotation` ("JP¥6,650 含税")
- `narrow price and its qualifier stay together with conversion outside` ("USD 219 from", 112px column)
- `narrow multi-price option keeps original lines and source order`
- `flex controls are not squeezed by new flex-item badges` (price + button in a 21px flex row)
- `Yahoo-style overlay price gets a visible label outside the image and capsule` (all four spots hit the image or the next block)
- generality: `a price deep inside a product-card link gets a plain label inside the link` and the four details/label tests that depend on it
- knock-on `null.isConnected` / `null.dataset` errors in later checks that assume those badges exist.

## If pursued anyway

1. Raise `minimum_chrome_version` to 125.
2. Hybrid: `placeBadge` tries `placeOverlay`, then the in-flow path. Keeps every existing test green except the two "must be outside / must be absent" ones, which would need rewording. Net: +130 lines, −0.
3. Product decision needed on *covering*: a translucent chip allowed to overlap non-text boxes (image padding, card background) would recover the Yahoo and grid cases, at the cost of occasionally sitting on an image.
