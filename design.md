# Design — DE.25 by Harshali

A locked design system for this site. Every page redesign reads this file
before emitting code. Do not regenerate per page — extend or amend this file
when the system needs to grow.

Produced by a `hallmark redesign` pass after an audit found the previous
build reading as a generic Shopify/WordPress bakery template: a full-viewport
centred hero, a wordmark-left/links/cart-right nav (the "AI nav"), a
Collection-list category grid, twin-pill-button product cards, and pill
buttons on every single clickable surface. See the audit for the full
citation list. This system replaces all of it while keeping every working
feature (cart, checkout, order tracking, My Orders phone lookup, admin
dashboard, AI Food Guide) untouched.

## Genre

**Editorial.** DE.25 is a small dessert brand with real photography, a
shop in Ghansoli (Navi Mumbai, open Wed–Sun 7:30–11:30 PM) and online
ordering for delivery. Portrait photos (the shop, the truffle loaf) use the
split hero — framed at their own ratio over a blurred copy — never a
full-bleed crop. Editorial suits a craft food brand better than
modern-minimal (too corporate-SaaS) or playful (too consumer-app); it also
lets the site read as considered rather than templated without needing an
accent colour to do the work.

## Macrostructure family

- **Marketing sections (home page only)** — **08 · Photographic.** Full-bleed
  real product photography per fold, small corner captions instead of
  centred display headlines, typographic link CTAs tucked under captions,
  no card-grid marketing blocks. Chosen because DE.25 has real photography
  for every product and no invented imagery is needed — Photographic is
  explicitly *unsuitable* without real photos, which is exactly the
  guardrail that keeps this from turning into another stock-image template.
- **Commerce sections (all 5 pages)** — **F6 Product card grid** component
  archetype (not a full macrostructure — it's the functional ordering UI and
  keeps its own voice). Knobs: card ratio 4/3 landscape, density 3-up
  desktop / 1-up mobile, micro-action = a single price-labelled "Add" action
  plus a typographic "View" link (replacing the old twin identical pill
  buttons).
- **Category pages** (cakes/pastries/savouries/sips) keep their existing
  left-biased hero + spotlight + locked product grid structure (already
  non-centred from an earlier pass) but adopt this system's nav, footer,
  type, and button voice.

## Nav

**N6 · Newspaper masthead.** Full-width band: a small tracked caption line
above ("Cakes · Pastries · Savouries · Sips"), the "DE.25" wordmark centred
and large below it, a link row beneath that, a double hairline rule closing
the band. Cart / My Orders / mobile-menu controls sit as small icon buttons
pinned to the top-right corner of the band — they do not sit in the same
row as the centred links, so the masthead reads as an editorial banner
first and a toolbar second.

*Differs from the previous build*: the previous nav was the canonical "AI
nav" (wordmark hard-left, inline links, CTA hard-right, sticky translucent
bar) — the single most-recognised template nav shape. N6 is structurally
unrelated to it.

Knobs: issue line above wordmark · wordmark size responsive 2xl→3xl ·
link row inline, wraps to two rows only below 480px · icon controls
top-right, outside the centred column.

## Footer

**Ft1 · Mast-headed**, extended with the site's real closing facts (not a
4-column link index — DE.25 has no such sitemap). Wordmark + one specific
closing line, the Instagram link, and — once confirmed — delivery-area /
hours notes restated compactly. No social-icon row, no "Resources" column.

## Theme — intentional no-accent deviation

Hallmark's default palette recipe calls for one accent hue. This project
deliberately has none: no DE.25 logo asset with colour exists, and the
owner's brand direction (documented in the previous build) is monochrome +
warm neutrals only. Rather than invent a hue with no basis in the real
brand, this system keeps that constraint and uses **ink weight and fill**
as the accent mechanism instead of colour — a legitimate editorial-luxury
move (the existing black-pill CTAs already do this; this system extends it
consistently). Every value below is a direct OKLCH conversion of the
existing hex tokens — same brand, same warmth, now on OKLCH per Hallmark's
token discipline.

```css
--color-paper:      oklch(98.5% 0.004 91);   /* was --warm-white #fbfaf7 */
--color-paper-2:    oklch(95.3% 0.010 82);   /* was --ivory      #f3efe8 */
--color-paper-3:    oklch(91.5% 0.018 81);   /* was --cream      #e9e2d6 */
--color-rule:       oklch(87.5% 0.022 83);   /* was --line       #ddd5c6 */
--color-ink:        oklch(19.3% 0.011 81);   /* was --ink        #17140f */
--color-ink-2:      oklch(15.5% 0.003 68);   /* was --black      #0d0c0b */
--color-ink-soft:   oklch(43.1% 0.028 94);   /* was --ink-soft   #55503f */
--color-muted:      oklch(51.9% 0.021 86);   /* was --muted      #6e685b, kept — already clears 4.5:1 AA per the prior axe-core pass */
--color-focus:      var(--color-ink-2);       /* focus ring — see a11y note below */
```

No `--color-accent` token exists on this project by design. Interactive
emphasis (active nav link, focus ring, primary CTA) uses `--color-ink-2`
(near-black) fill/underline instead of a hue.

## Typography

- **Display: Fraunces** (kept — already a first-rate, licensed-free
  editorial face; the previous build's investment in its metrics for
  headings stays valid).
- **Body: IBM Plex Sans**, replacing Inter. Inter is Hallmark's most banned
  default body face; DE.25 had it paired with a display face already (so it
  didn't hit the "Inter-everywhere" *critical* gate) but it's still the
  single most on-distribution body sans in existence. IBM Plex Sans is
  editorial-approved, free, and swaps in as a `<link>` change only.
- **Outlier: JetBrains Mono**, used in exactly two roles per the 2+1 rule:
  the order token (`#T81`-style) and price figures (`font-variant-numeric:
  tabular-nums`). A monospace price/ticket register suits a food-order
  system — it reads like a receipt, which is the honest metaphor for what
  it is — and never appears anywhere else on the page.

```css
--font-display: 'Fraunces', Georgia, serif;
--font-body:    'IBM Plex Sans', system-ui, -apple-system, sans-serif;
--font-outlier: 'JetBrains Mono', ui-monospace, monospace;   /* order token + prices ONLY */
```

## Spacing / motion / microinteractions

Unchanged from the previous build — both were already compliant:

- 4pt-derived named scale (`--space-3xs` … `--space-3xl`), used everywhere,
  no raw px in new code.
- Single named easing `--ease-cinematic: cubic-bezier(0.22, 1, 0.36, 1)`
  (exponential ease-out) and three durations already in place; IntersectionObserver
  reveal-once (no scroll listeners), `prefers-reduced-motion` fully respected.
- Silent success, focus rings appear instantly (no transition on
  `:focus-visible`), 44×44px minimum hit targets — all already true and
  preserved.

## CTA voice — the pill-ubiquity fix

The previous build used a fully-rounded pill for *every* clickable surface
(hero CTAs, cart button, filter chips, product actions, form submit). That
uniformity is itself a commerce-template tell. This system differentiates
three CTA families:

1. **Primary commerce actions** (Add to cart, Place order, Find my orders,
   checkout submit) — keep the filled pill. This is the one place a pill
   earns its place: it is the site's single "this completes a transaction"
   shape, and it is now used *only* for that.
2. **Secondary / navigational actions** (View details, category "Explore",
   gallery captions, ghost-link chevrons) — a typographic underline link,
   no border, no fill. Matches the Photographic macrostructure's caption
   CTA voice.
3. **Filter / toggle controls** (menu category chips) — a sharp-cornered
   (4px radius) tab-underline control instead of a pill, so filters read as
   *navigation* rather than *purchase*.

## Per-page allowances

- Home page: full Photographic marketing sections (hero, story, gallery,
  reviews, hours, delivery area, contact) + the commerce grid.
- Category pages: hero + spotlight + commerce grid only — no About/Gallery/
  Reviews/Hours/Location duplication. Those live once, on the home page,
  and the nav's "Menu" link plus footer anchor there.
- No page invents a review, a rating, a certification, an address, an
  opening hour, or a phone number that DE.25 has not confirmed. Every one
  of those fields below is either real (product data, Instagram handle) or
  an honestly labelled placeholder, matching this project's existing
  "never invent" convention (see README § WHAT'S REAL vs WHAT'S A DEMO
  PLACEHOLDER).

## What pages MUST share

- The wordmark treatment (Fraunces, masthead nav).
- Ink-weight-as-accent — no page introduces a hue.
- The three-tier CTA voice above.
- Fraunces + IBM Plex Sans + JetBrains Mono (outlier, ≤2 slots) — no page
  adds a fourth family.
- Section-head voice: no eyebrow numerals, no tag-left/heading-right split
  heads (gate 54) — a plain heading, left- or corner-biased per section.

## What pages MAY differ on

- Hero treatment within the Photographic family (corner caption position,
  image crop) per page's lead photo.
- Whether a section head is left-biased or corner-biased — chosen per
  section, not uniform down the page (the "centred everything" fix means
  varying this deliberately, not replacing one default with another).

## Accessibility carry-overs (unchanged, already correct)

- `:focus-visible` — 2px solid `--color-ink-2`, 3px offset, instant (no
  transition).
- Contrast: `--color-muted` already re-measured to clear 4.5:1 AA against
  paper in the previous axe-core pass; the OKLCH conversion above preserves
  the exact same sRGB value, so that finding still holds.
- `overflow-x: clip` on `html, body` (kept) — required for the Photographic
  macrostructure's full-bleed photo bands, which must never cause
  horizontal scroll.
