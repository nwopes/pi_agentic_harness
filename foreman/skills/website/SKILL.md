---
name: website
description: Build a clean, modern, responsive website, landing page or web UI step by step, using a ready-made design system (5 tested themes, base CSS, component patterns, icons) and a checker script. Use when asked to create, build, redesign or restyle a website, landing page, homepage, portfolio, product, restaurant, event or marketing page, or a small static multi-page site.
---

# Build a website that looks professionally designed

This skill lets you build a site that looks like a senior designer and front-end engineer made it, without asking anyone for help. **Do not improvise the design.** Everything that makes a site look good is already decided here: the palette, typography, spacing, components and states. Your job is to choose, copy, fill in and check.

Work through Steps 0–10 in order. Every step ends with **Done when**; don't move on until that is true.

`SKILL_DIR` means the folder that contains this file. All paths below are relative to it.

| File | What it is |
|---|---|
| `assets/base.css` | The design system: reset, tokens, layout, buttons, cards, nav, hero, all sections, forms, footer, motion |
| `assets/starter.html` | A complete, good-looking landing page using base.css. Your starting point. |
| `assets/script.js` | Mobile menu toggle, current year, reveal-on-scroll (respects reduced motion) |
| `assets/icons.md` | 24 inline SVG line icons |
| `references/themes.md` | 5 complete colour and font themes with verified contrast, plus how to pick one |
| `references/components.md` | Copy-paste HTML for every section type |
| `scripts/check-site.mjs` | Quality checker: `node SKILL_DIR/scripts/check-site.mjs <site folder>` |

## Golden rules

1. **Never invent colours.** Use one theme from `references/themes.md`, unchanged, except the brand-colour rule there.
2. **Use tokens, not raw values.** Write `var(--color-muted)`, `var(--space-6)` and `var(--radius-lg)`, never `#777`, `13px` or `7px`.
3. **One accent colour.** It goes on primary buttons, links, icons and small highlights only. Large areas use bg, surface and surface-2.
4. **Generous whitespace.** Never shrink the section or card padding from base.css. When unsure, add space, not remove it.
5. **Left-align reading text.** Centre only the hero (centred variant), section headers and the CTA band.
6. **Real, specific words.** Never write lorem ipsum, "Feature 1" or "Your text here".
7. **Every link and button goes somewhere real:** a section `#id`, a page that exists, or `mailto:`.
8. **Mobile first.** Nothing may scroll sideways on a 375px-wide phone.
9. **Accessible by default.** Landmarks, one `<h1>`, alt text, labels, visible focus.
10. **Finish with the checker** at 0 errors, then the self-review.

---

## Step 0: Read the brief and decide the stack

Write down (in your notes or reply) a five-line plan:

```
Site type:        (SaaS / portfolio / restaurant / event / docs / blog / other: …)
Primary action:   (the ONE thing a visitor should do: sign up, book, buy, call, contact, download)
Brand & content:  (name, colours, real facts from the brief: prices, address, hours, people, quotes)
Pages & sections: (filled in at Step 3)
Files:            (where the site goes and which stack, from the table below)
```

| Situation | What to do |
|---|---|
| The task names files, folders or a framework | Follow it exactly. |
| An existing React, Vue, Svelte, Next or Vite project, no Tailwind | Keep it. Put base.css with your theme tokens into the global stylesheet (e.g. `src/index.css` or `app/globals.css`). Use the same class names (`className="card"` in React). Make one component per section. |
| An existing project that uses Tailwind | Keep Tailwind. Put the theme's `:root { … }` token block in the global CSS and use the tokens in utilities (`bg-[var(--color-surface)]`, `text-[var(--color-muted)]`, `rounded-[var(--radius-lg)]`). Copy layout and spacing values from base.css. Don't add a second palette. |
| Nothing exists yet | A plain static site: `index.html`, `styles.css` and `script.js` in the target folder (the project root unless told otherwise). No build step, frameworks or CDN JavaScript libraries. |

**Done when:** you have written the plan, and you know the site type, primary action and file locations.

## Step 1: Pick ONE theme

1. Open `references/themes.md` and pick the theme from its table: the site type decides it.
2. If the brief names brand colours, follow the "If the brief names brand colours" rule in that file.
3. Write the theme's name into your plan.

**Done when:** you have that theme's `:root { … }` block and its font `<link>` tags.

## Step 2: Set up the files

**Plain static site:**

1. Copy `SKILL_DIR/assets/base.css` to `<site>/styles.css`.
2. Copy `SKILL_DIR/assets/script.js` to `<site>/script.js`.
3. Copy `SKILL_DIR/assets/starter.html` to `<site>/index.html`.
4. In `index.html`, change `<link rel="stylesheet" href="base.css" />` to `href="styles.css"`.
5. In `styles.css`, replace everything from `/* === THEME TOKENS` down to `/* === END THEME TOKENS === */` with your theme's `:root { … }` block. Keep the two marker comments.
6. In `index.html`, replace the Google Fonts `<link … fonts.googleapis.com/css2…>` line with your theme's font tags. Keep the two `preconnect` lines.

**Existing framework project:** do the same with its global stylesheet and its root HTML or layout file. Put `script.js` in the public or static folder, or port the toggle logic into the nav component.

Then run the checker: `node SKILL_DIR/scripts/check-site.mjs <site>`. Right now it should report **exactly one error**, "the starter example (Tidyflow) is still in the page". Any other error means a setup step went wrong; fix it now.

**Done when:** the checker shows only the starter-example error.

## Step 3: Plan the sections

Choose the row for your site type, then adjust it to the brief. If the brief lists sections or pages, the brief wins. Pattern names refer to `references/components.md`.

| Site type | Sections, in order (header first, footer last) |
|---|---|
| SaaS / app / product | hero split (mock) · logo strip · features (6 cards) · how it works · split (benefit + checklist) · testimonials · pricing · FAQ · CTA band |
| Portfolio / personal / freelancer | hero centred (name, role, one-line value) · selected work (`grid--2` of cards, each with a `media-frame`) · about (split) · services (`grid--3`) · testimonials (if the brief has quotes) · contact form · CTA band |
| Restaurant / café / local business | hero split (photo or SVG illustration) · story (split) · menu highlights (`grid--3` cards with the brief's dishes and prices) · hours and location (`grid--2`: one card listing hours, one with the address, map-pin icon and a directions link) · testimonials · CTA band (book or call) |
| Event / conference | hero centred (what, date, place, ticket button) · highlights or speakers (`grid--3`) · schedule (steps or a list in cards) · venue (split) · tickets (pricing) · FAQ · CTA band |
| Docs / developer tool / open source | hero centred (one-line value and an install command in a `<pre>`) · features (`grid--3`) · quick start (steps) · code example (split) · FAQ · CTA band (docs or repository) |
| Blog / writer | hero centred (intro) · latest posts (`grid--3` cards: date, title, 1-line excerpt, "Read" link) · about (split) · newsletter (form with one email field) |

**Rules:**
- A landing page has 6–10 sections between header and footer.
- Alternate `section--alt` on every second section.
- Every section gets an `id`, and every nav link must match one.
- Stats only with numbers the brief gives (see Step 5).
- **Multi-page sites:** the same header and footer on every page, and one `<h1>` per page. Read "Multi-page sites" in `references/components.md`.

**Done when:** you have an ordered list of sections with their ids, and the nav links are chosen from them.

## Step 4: Build section by section

Work from top to bottom in `index.html`. For each section:

1. **Copy** the matching pattern from `references/components.md`. Delete the starter's sections you don't need, but keep the header, the CTA band and the footer.
2. **Replace every word, link and email** with content for this brief. Keep the class names and structure.
3. **Check, before moving on:**
   - the section has an `id`, and its heading has the `id` that `aria-labelledby` points to;
   - the headings go h2, then h3;
   - all links point to something real;
   - images have alt text.

**Layout rules:**
- **Grids:** `grid--3` holds 3 or 6 items, and `grid--2` holds 2 or 4. Never leave a lonely item on the last row.
- **Cards:** every card in a grid has the same structure: icon (optional, but all or none), `h3`, then `p`.
- **Reveal animation:** add `reveal` to cards, steps and quotes. It's optional and already handles reduced motion.
- **Custom CSS** goes only below `/* === PAGE-SPECIFIC STYLES … === */` at the end of styles.css, and uses tokens only. Name classes after what they are (`.menu-item__price`), not how they look (`.red-text`).

**Code blocks** (docs and developer sites): add this under PAGE-SPECIFIC STYLES:

```css
pre {
  overflow-x: auto;
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-2);
  font-size: var(--step--1);
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
```

**Hours or menu lists** (local business): use a `<dl>` inside a `.card`. Put each row in a `<div>` styled `display: flex; justify-content: space-between; padding-block: var(--space-2); border-bottom: 1px solid var(--color-border);`.

**Done when:** every planned section exists with real content and no starter text remains. "Tidyflow" must not appear anywhere.

## Step 5: Write the copy

Words decide whether a beautiful layout feels real. Follow these rules exactly.

| Element | Rule | Good | Bad |
|---|---|---|---|
| Hero `h1` | 4–10 words: the visitor's outcome, not your feature list | "Plan the week in ten minutes, not two meetings" | "Welcome to our website" |
| Lead | 1–2 sentences, at most 30 words: who it's for, what it does, why it's different | "Fresh sourdough and seasonal pastries, baked every morning two streets from your door." | "We are passionate about quality and excellence." |
| Section `h2` | Says the benefit of the section | "Everything you need to run a calm kitchen" | "Features" (that goes in the eyebrow) |
| Card title | 2–5 words, benefit-led | "Bookings without phone tag" | "Feature 1" |
| Card text | 15–30 words, concrete | "Guests pick a time online and get a reminder the day before, so no-shows drop and the phone stays quiet." | "Our booking system is great and easy." |
| Button | Verb + object, the same wording for the primary action everywhere | "Book a table", "Start free trial" | "Submit", "Click here", "Learn more" everywhere |

**Truth rules (never break these):**

- **Use the brief's facts** (names, prices, address, hours, quotes, numbers) exactly.
- **Don't invent anything that would read as a fact about the real world:**
  - no real people or real companies endorsing the product;
  - no awards or certifications;
  - no measured-looking statistics ("98% of users…").
- **Demo or concept site with no data:**
  - invent clearly fictional names and companies;
  - use plausible round prices;
  - use non-numeric proof ("Set up in one sitting") instead of statistics.
- **Fictional emails and links** use `example.com` or a `.example` domain (`hello@brand.example`).
- **Never leave in:** lorem ipsum, TODO, TBD, "Your text here" or `[insert …]`.

**Tone:**
- Clean SaaS and Bold startup: confident and short.
- Warm editorial: warm and sensory.
- Calm minimal: plain and reassuring.
- Midnight tech: precise and technical.

**Done when:** reading the page aloud, every sentence is specific to this brief and could not sit on any other site.

## Step 6: Visuals without stock photos

- **Images from the brief:**
  - Use local files only, inside `.media-frame`.
  - Add width and height attributes (e.g. `width="1200" height="900"`) and a real description in `alt`.
  - Add `loading="lazy"` for images below the hero.
- **No images:** use the product mock (`.mock`), simple SVG illustrations coloured with the `svg-*` classes, the theme gradients (`--gradient-hero`, `--gradient-media`), icon tiles, and initials avatars (`.avatar`).
- **Icons** come only from `assets/icons.md`: one style, inline SVG.
- **Never:**
  - hotlink images from other websites;
  - use placeholder-image services, or a real company's logo the brief didn't provide;
  - use emoji as icons;
  - write `fill="var(--…)"` on SVG elements; use the `svg-*` classes instead.

**Done when:** the page has no external images, and every card in a grid either has an icon or none does.

## Step 7: Polish (what makes it look expensive)

Check each item; fix any that are false.

- **Spacing:** sections use `.section` or `.section--tight` with their default padding, and cards keep `.card` padding. Headline → lead uses the built-in margins; section header → content is `var(--space-12)` (already in `.section-head`). No `margin: 0` hacks that glue things together.
- **Hierarchy:** one `h1` (step-5), section `h2` (step-3), card `h3` (step-1), body (step-0). Secondary text uses `.muted`, `.lead` or the card `p` colour. Only one thing per section is visually loud.
- **Line length:** paragraphs stay within about 65 characters per line (`.lead` and `.prose` already do this), and hero headlines within 18ch.
- **Alignment:** each section is either a centred header with a grid, or a left header with content. Never centre paragraphs longer than two lines.
- **Colour:**
  - The accent appears on primary buttons, links, icons, the badge and eyebrow, and the CTA band only.
  - At most one accent-filled button per section; use `btn--secondary` or `btn--ghost` for the rest.
- **Consistency:** one radius family (tokens), one card style, one icon style, and the same primary-action wording everywhere.
- **States:**
  - Every link, button, card link and form field has hover and focus styles. base.css provides them; give the same to anything custom, with `transition: … var(--dur) var(--ease)` (150–250ms).
  - Never write `outline: none` without a replacement focus style.
- **Rhythm:** section backgrounds alternate. Each section has an eyebrow (optional), an `h2` and an optional lead. The page ends with the CTA band, then the footer.

**Done when:** every item above is true.

## Step 8: Responsive

base.css is mobile first, with breakpoints at **40em (640px)** for 2-column grids and forms, **48em (768px)** for the inline nav and footer columns, and **60em (960px)** for 3/4-column grids, split sections and the hero split. Reason through three widths for **every custom rule you added**:

- **375px (phone):**
  - Everything is one column, and the nav shows the toggle button.
  - Buttons wrap rather than overflow.
  - No element is wider than the screen: no fixed `width` over about 340px, and images use `max-width: 100%`.
  - Body text is at least 16px. Tap targets are at least 44px high (`.btn` already is).
- **768px (tablet):** grids show 2 columns, and the nav links are inline.
- **1280px (desktop):** content sits in the centred 72rem container, grids show 3 columns, and split sections are side by side.

**Custom CSS:**
- Use `%`, `fr`, `minmax()`, `clamp()` and `max-width`, not fixed pixel widths.
- Add larger layouts with `@media (min-width: …)`, mobile first.
- Long words or URLs get `overflow-wrap: anywhere;`.

**Done when:** you have checked every custom rule at all three widths, and nothing scrolls sideways at 375px.

## Step 9: Accessibility

- **Landmarks:** `<header>`, `<nav aria-label="Main">`, `<main id="main">`, `<footer>`, plus the skip link at the top of `<body>`.
- **Headings:** exactly one `h1`, and levels never skip (h2 → h4 is wrong).
- **Images:** a meaningful `alt`. Decorative images get `alt=""`; decorative SVG gets `aria-hidden="true" focusable="false"`. Illustrations that carry meaning get `role="img"` and an `aria-label`.
- **Links and buttons** have text that makes sense alone ("Book a table", not "Click here"). Icon-only controls get an `aria-label`.
- **Forms:**
  - Every field has a visible `<label for>`.
  - Use the right `type` (`email`, `tel`) and `autocomplete`, and `required` where needed.
  - The placeholder is an example, never the label.
- **Contrast:** only use the pairs verified in `references/themes.md`.
  - Never put muted text on accent-soft, or text in `--color-accent-2`.
  - Never put text on a photo without a dark overlay.
- **Focus:** keep base.css's `:focus-visible` outline, and never remove focus styles.
- **Motion:** keep base.css's `prefers-reduced-motion` block, and don't add autoplaying video, carousels or parallax.
- **Language:** `<html lang="…">` is set to the content's language.

**Done when:** every item above is true.

## Step 10: Check, fix, review, report

1. **Run the checker:** `node SKILL_DIR/scripts/check-site.mjs <site folder>`, with this skill's absolute path and your site's folder (or one HTML file).
2. **Fix every ERROR**, then run it again. Repeat until the last line says `0 error(s)`. Fix every WARN too, unless you have a real reason; if so, state the reason in your report.
3. **If the HTML is generated by JavaScript** (React and similar): run the checker on the built output (`npm run build`, then check `dist/` or `build/`) if the project has a build script. Otherwise check the static HTML file, and verify heading, alt and label items by reading your components.
4. **If the project has its own tests, typecheck, lint or build,** run them too, and fix what you broke.
5. **Self-review.** Answer each question yes or no, and fix every no:
   - Does it follow exactly one theme, with no invented colours?
   - Is the hero `h1` about the visitor's outcome, and is there one clear primary action, repeated in the CTA band?
   - Is every section in the plan present, in order, with real content and an `id`?
   - Do all nav and footer links scroll or go to something real?
   - Do grids have 3/6 or 2/4 items, with no orphans?
   - Do sections alternate background?
   - Is the page free of external images, emoji and inline-style clutter?
   - Is it one column at 375px, with a working menu toggle and no sideways scroll?
   - Is there exactly one `h1`, no skipped headings, alt text everywhere and labels on every field?
   - Is every fact either from the brief or clearly fictional, with no invented statistics or real endorsements?
   - Does the checker show 0 errors?
6. **Report back:**
   - the files you created or changed;
   - the theme;
   - the sections, in order;
   - the checker's final summary line, pasted exactly;
   - any warnings left, and why;
   - anything from the brief you could not do. For example, a form needs a real backend to send email.

**Done when:** the checker reports 0 errors, every self-review answer is yes, and you have sent the report.

---

## Common mistakes small models make (and the fix)

| Mistake | Fix |
|---|---|
| Inventing colours or gradients "to make it pop" | Only theme tokens. The theme already has gradients. |
| Centring everything | Left-align paragraphs; centre only the hero (centred variant), section heads and the CTA band. |
| Cramped layout: tiny gaps, thin cards | Keep `.section` and `.card` padding. Never give a card padding below `var(--space-6)`. |
| Walls of text | At most 2 sentences per paragraph in marketing sections. Use lists and cards for details. |
| No mobile menu, or links that overflow on phones | Use the header pattern exactly: toggle, `nav__menu` with an `id`, and `script.js` loaded. |
| Plain browser-default buttons and links | Every call to action is an `<a>` or `<button>` with `btn btn--primary` (or `--secondary` or `--ghost`). |
| Mixed corner radii and shadows | Only `--radius-*` and `--shadow-*` tokens. |
| Emoji as icons | Use the SVG icons in `assets/icons.md`. |
| Placeholder or starter text left in | The checker catches it. Replace every word. |
| Nav link to `#pricing` but no `id="pricing"` | Match every href to a section id; the checker catches it. |
| Hotlinked or placeholder-service images | Use local files from the brief, the `.mock`, or SVG illustrations. |
| 4 or 5 cards in a 3-column grid | Use 3 or 6 cards in `grid--3`, and 2 or 4 in `grid--2`. |
| Every section on the same background | Alternate `section--alt`. |
| Several `h1`s, or `h1` → `h3` | One `h1` in the hero. Section titles are `h2` and card titles `h3`. |
| Fake statistics or famous customers | Brief facts only; otherwise clearly fictional names and no numbers posing as research. |
| Forgot `href="base.css"` → `styles.css` | The checker reports "stylesheet not found". |
| `!important` or inline `style=""` to fight base.css | Add a more specific class under PAGE-SPECIFIC STYLES. |
| Giant fixed widths (`width: 1200px`) | Use `max-width` and the `.container`. |
| Low-contrast text on gradients or tinted backgrounds | Only the verified pairs from themes.md. Text on accent uses `--color-accent-contrast`. |
| Stopping before the checker | Step 10 is required, and the report must include the checker's summary line. |
