# Components

Copy-paste patterns built on `assets/base.css`. Every pattern below is already styled, responsive and accessible; change the words, keep the structure and class names. `assets/starter.html` shows most of them together on one page.

**Rules for all patterns:**

- **Sections:**
  - Every section is a `<section class="section">` with a `.container` inside.
  - Alternate the background: give every second section `section--alt`, so sections read as separate bands.
  - Give each section an `id` (for nav links) and `aria-labelledby` pointing at its heading's `id`.
- **Headings:** one `<h1>` per page, in the hero. Section titles are `<h2>`, and titles inside cards or steps are `<h3>`. Never skip a level.
- **Icons:** copy them from `assets/icons.md`.
- **Content:** every link needs a real target: a section `#id`, a page that exists, or `mailto:`. Replace all example words.

Contents: page shell, header and nav, hero (split / centred), logo strip, feature grid, how it works (steps), split section, stats, testimonials, pricing, FAQ, CTA band, contact form, footer.

---

## Page shell

Use it for every page. The order inside `<head>` matters: the `js` class line must come before the CSS.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Brand: what the page offers in a few words</title>
    <meta name="description" content="One sentence that says who it is for and what they get." />
    <script>document.documentElement.classList.add("js")</script>
    <!-- the theme's font <link> tags from references/themes.md go here -->
    <link rel="stylesheet" href="styles.css" />
    <script src="script.js" defer></script>
  </head>
  <body id="top">
    <a class="skip-link" href="#main">Skip to content</a>
    <!-- header -->
    <main id="main">
      <!-- sections -->
    </main>
    <!-- footer -->
  </body>
</html>
```

## Header and nav (mobile toggle included)

Use it on every page.
- At 48em (768px) and wider, the links show inline.
- On phones, the toggle opens a stacked menu, using `script.js`.
- Keep 3–5 links and one primary button.

```html
<header class="site-header">
  <nav class="container nav" aria-label="Main">
    <a class="brand" href="#top"><span class="brand__mark" aria-hidden="true"></span>Brand</a>
    <button class="nav__toggle" type="button" aria-expanded="false" aria-controls="nav-menu" aria-label="Open menu">
      <svg class="icon-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      <svg class="icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
    <div class="nav__menu" id="nav-menu">
      <ul class="nav__links">
        <li><a href="#features">Features</a></li>
        <li><a href="#pricing">Pricing</a></li>
        <li><a href="#faq">FAQ</a></li>
      </ul>
      <div class="nav__actions">
        <a class="btn btn--primary btn--sm" href="#cta">Get started</a>
      </div>
    </div>
  </nav>
</header>
```

Notes:
- The brand mark is a gradient square. If the brief has a logo file, use `<img src="logo.svg" alt="Brand" width="120" height="32">` instead of the mark and name.
- On multi-page sites, set `aria-current="page"` on the current page's link.

## Hero: split (text left, product mock right)

Use it for products, apps and services: anything with a "thing" to show.

```html
<section class="hero hero--split" aria-labelledby="hero-title">
  <div class="container hero__inner">
    <div>
      <span class="badge">New: short news or category</span>
      <h1 id="hero-title">Outcome the visitor wants, in <span class="highlight">few words</span></h1>
      <p class="lead">One or two sentences: who it is for, what it does, why it is different.</p>
      <div class="hero__actions">
        <a class="btn btn--primary btn--lg" href="#cta">Primary action</a>
        <a class="btn btn--secondary btn--lg" href="#how">Secondary action</a>
      </div>
      <p class="hero__note">Reassurance: free trial, no card, cancel anytime.</p>
    </div>
    <div class="mock" role="img" aria-label="Describe what the preview shows">
      <div class="mock__bar"><span></span><span></span><span></span></div>
      <div class="mock__body">
        <div class="mock__row"><span class="mock__dot"></span><span class="mock__line"></span></div>
        <div class="mock__row"><span class="mock__dot"></span><span class="mock__line mock__line--short"></span></div>
        <div class="mock__chart"><span style="height: 40%"></span><span style="height: 75%"></span><span style="height: 55%"></span><span style="height: 90%"></span></div>
      </div>
    </div>
  </div>
</section>
```

Notes:
- **The headline** is 4–10 words, about the visitor's outcome rather than your features. Highlight 1–3 words at most.
- **A real photo** (if the brief provides one) replaces the mock: `<div class="media-frame"><img src="hero.jpg" alt="…" width="1200" height="900"></div>`.
- **For a restaurant or local business,** use the media-frame with a provided photo or an SVG illustration, not the product mock.

## Hero: centred

Use it for personal sites, events, minimal brands, and pages without a product image.

```html
<section class="hero hero--center" aria-labelledby="hero-title">
  <div class="container hero__inner">
    <span class="badge">Kind of thing / date / location</span>
    <h1 id="hero-title">The one-line promise</h1>
    <p class="lead">Supporting sentence with the key detail people need to decide.</p>
    <div class="hero__actions">
      <a class="btn btn--primary btn--lg" href="#cta">Primary action</a>
      <a class="btn btn--ghost btn--lg" href="#about">Learn more</a>
    </div>
  </div>
</section>
```

## Logo strip

Use it right after the hero, when the brief mentions clients, partners or press.
- **Use the names the brief gives.** Never use real company names or logos unless the brief provides them.
- **For a made-up demo,** use clearly invented names.

```html
<section class="section--tight" aria-label="Customers">
  <div class="container">
    <p class="logos-title">Trusted by teams at</p>
    <ul class="logos">
      <li>Northpeak</li>
      <li>Harbor Labs</li>
      <li>Quarry &amp; Co</li>
      <li>Fieldnote</li>
    </ul>
  </div>
</section>
```

## Feature grid

Use 3 or 6 cards (never 4, 5 or 7 with `grid--3`; use `grid--2` for 2 or 4).

```html
<section class="section section--alt" id="features" aria-labelledby="features-title">
  <div class="container">
    <div class="section-head section-head--center">
      <span class="eyebrow">Features</span>
      <h2 id="features-title">Section headline that sums up the benefits</h2>
      <p class="lead">One sentence that frames the cards below.</p>
    </div>
    <div class="grid grid--3">
      <article class="card card--hover reveal">
        <div class="icon-tile"><!-- icon from assets/icons.md --></div>
        <h3>Benefit-led card title</h3>
        <p>One or two sentences, 15–30 words, explaining the benefit concretely.</p>
      </article>
      <!-- repeat: 3 or 6 cards in total -->
    </div>
  </div>
</section>
```

Card titles are 2–5 words. All cards in a grid have the same structure and roughly the same text length.

## How it works (numbered steps)

Use it when there is a process: sign-up, booking, onboarding or ordering. Always 3 steps; the numbers are generated by CSS.

```html
<section class="section" id="how" aria-labelledby="how-title">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">How it works</span>
      <h2 id="how-title">From first click to result in three steps</h2>
    </div>
    <ol class="steps">
      <li class="step reveal"><h3>Verb-first step</h3><p>What happens, in one sentence.</p></li>
      <li class="step reveal"><h3>Verb-first step</h3><p>What happens, in one sentence.</p></li>
      <li class="step reveal"><h3>Verb-first step</h3><p>What happens, in one sentence.</p></li>
    </ol>
  </div>
</section>
```

## Split section (text beside media)

Use it to explain one big idea with proof points. Add `split--reverse` on every second split to put the media on the left.

```html
<section class="section section--alt" aria-labelledby="idea-title">
  <div class="container split">
    <div>
      <span class="eyebrow">Short label</span>
      <h2 id="idea-title">The big idea in one line</h2>
      <p class="lead">Two sentences of explanation.</p>
      <ul class="checklist mt-8">
        <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>Concrete proof point</li>
        <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>Concrete proof point</li>
        <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>Concrete proof point</li>
      </ul>
    </div>
    <div class="split__media">
      <div class="media-frame" role="img" aria-label="What the illustration shows">
        <svg viewBox="0 0 400 300" fill="none" aria-hidden="true" focusable="false">
          <rect class="svg-surface" x="40" y="40" width="320" height="220" rx="18" />
          <rect class="svg-accent" x="70" y="75" width="150" height="14" rx="7" />
          <rect class="svg-soft" x="70" y="115" width="260" height="34" rx="10" />
          <rect class="svg-soft" x="70" y="160" width="260" height="34" rx="10" />
          <rect class="svg-surface-2" x="70" y="205" width="200" height="34" rx="10" />
        </svg>
      </div>
    </div>
  </div>
</section>
```

Illustrations are simple shapes coloured with the `svg-*` classes (`svg-surface`, `svg-surface-2`, `svg-accent`, `svg-accent-2`, `svg-soft`, `svg-line`). Don't write `fill="var(--…)"` attributes; they are unreliable. With a real image, use `<img src="…" alt="…">` inside `.media-frame`.

## Stats

Use it **only with numbers from the brief.** Never invent statistics and present them as facts. Without real numbers, use facts about the offer instead ("24/7 support", "3 locations", "Est. 2015", if the brief says so), or leave this section out.

```html
<section class="section section--tight" aria-label="Key facts">
  <div class="container">
    <dl class="stats">
      <div><dt class="stat__label">Label for the number</dt><dd class="stat__value">42</dd></div>
      <div><dt class="stat__label">Label</dt><dd class="stat__value">3</dd></div>
    </dl>
  </div>
</section>
```

`<dl>` keeps each label with its value for screen readers, and base.css shows the big value above its label. Use 2 or 4 items.

## Testimonials

Use the brief's real quotes. For a demo or concept site with no quotes, write short, believable quotes from invented people with invented companies, and never name real people or real companies. Three quotes in a `grid--3`; each 1–2 sentences, specific about a result.

```html
<section class="section" aria-labelledby="quotes-title">
  <div class="container">
    <div class="section-head section-head--center">
      <span class="eyebrow">Testimonials</span>
      <h2 id="quotes-title">What customers say</h2>
    </div>
    <div class="grid grid--3">
      <figure class="card quote reveal">
        <blockquote><p>A specific result in the customer's words.</p></blockquote>
        <figcaption><span class="avatar" aria-hidden="true">AB</span><span><span class="quote__name">First Last</span><br /><span class="quote__role">Role, Company</span></span></figcaption>
      </figure>
      <!-- 2 more -->
    </div>
  </div>
</section>
```

## Pricing

Use 3 plans. Put the recommended plan in the middle with `plan--featured` and a badge. Prices come from the brief; for a concept site, use plausible round prices.

```html
<section class="section section--alt" id="pricing" aria-labelledby="pricing-title">
  <div class="container">
    <div class="section-head section-head--center">
      <span class="eyebrow">Pricing</span>
      <h2 id="pricing-title">Simple, honest pricing</h2>
    </div>
    <div class="grid grid--3">
      <article class="card plan">
        <h3>Plan name</h3>
        <p class="plan__price">$0 <span>/ month</span></p>
        <p>Who this plan is for.</p>
        <ul class="checklist"><li><!-- check icon -->Included item</li></ul>
        <a class="btn btn--secondary btn--block" href="#cta">Action</a>
      </article>
      <article class="card plan plan--featured">
        <span class="badge plan__badge">Most popular</span>
        <h3>Plan name</h3>
        <p class="plan__price">$12 <span>/ month</span></p>
        <p>Who this plan is for.</p>
        <ul class="checklist"><li><!-- check icon -->Included item</li></ul>
        <a class="btn btn--primary btn--block" href="#cta">Action</a>
      </article>
      <!-- third plan like the first -->
    </div>
  </div>
</section>
```

## FAQ

Use 4–6 real questions a visitor would ask before buying or booking. It works without JavaScript.

```html
<section class="section" id="faq" aria-labelledby="faq-title">
  <div class="container">
    <div class="section-head section-head--center">
      <span class="eyebrow">FAQ</span>
      <h2 id="faq-title">Questions, answered</h2>
    </div>
    <div class="faq">
      <details>
        <summary>Question phrased the way a customer would ask it?</summary>
        <p>Direct answer in 1–3 sentences.</p>
      </details>
    </div>
  </div>
</section>
```

## CTA band

Use it as the last section before the footer, every time. Repeat the hero's primary action.

```html
<section class="section" id="cta" aria-labelledby="cta-title">
  <div class="container">
    <div class="cta-band">
      <h2 id="cta-title">Short, action-oriented headline</h2>
      <p>One sentence that removes the last doubt.</p>
      <div class="hero__actions">
        <a class="btn btn--inverse btn--lg" href="mailto:hello@example.com">Primary action</a>
      </div>
    </div>
  </div>
</section>
```

On the band, use `btn--inverse`, never `btn--primary`, because it would disappear into the background.

## Contact form

Use it for contact, booking requests or waitlists.
- Every field has a visible `<label>`, and the placeholder is only an example.
- A static site cannot send email by itself. If the brief gives no form service, set `action="mailto:…"` (or the brief's endpoint) and say so in your report.

```html
<section class="section section--alt" id="contact" aria-labelledby="contact-title">
  <div class="container container--narrow">
    <div class="section-head section-head--center">
      <h2 id="contact-title">Get in touch</h2>
      <p class="lead">We reply within one working day.</p>
    </div>
    <form class="form card" action="mailto:hello@example.com" method="post" enctype="text/plain">
      <div class="form__row">
        <div class="field"><label for="name">Name</label><input id="name" name="name" autocomplete="name" required /></div>
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required /></div>
      </div>
      <div class="field"><label for="message">Message</label><textarea id="message" name="message" required></textarea></div>
      <p class="hint">We only use your email to reply.</p>
      <button class="btn btn--primary btn--lg" type="submit">Send message</button>
    </form>
  </div>
</section>
```

## Footer

Use it on every page. A brand column, plus 2–3 link columns that link to real sections or pages.

```html
<footer class="site-footer">
  <div class="container">
    <div class="footer__grid">
      <div>
        <a class="brand" href="#top"><span class="brand__mark" aria-hidden="true"></span>Brand</a>
        <p class="muted mt-4">One line describing the brand.</p>
      </div>
      <div>
        <h2 class="footer__title">Product</h2>
        <ul class="footer__links"><li><a href="#features">Features</a></li><li><a href="#pricing">Pricing</a></li></ul>
      </div>
      <div>
        <h2 class="footer__title">Help</h2>
        <ul class="footer__links"><li><a href="#faq">FAQ</a></li><li><a href="mailto:hello@example.com">Contact</a></li></ul>
      </div>
      <div>
        <h2 class="footer__title">Company</h2>
        <ul class="footer__links"><li><a href="#about">About</a></li></ul>
      </div>
    </div>
    <div class="footer__bottom">
      <p>&copy; <span data-year>2026</span> Brand. All rights reserved.</p>
      <p><a href="#top">Back to top</a></p>
    </div>
  </div>
</footer>
```

`script.js` fills `[data-year]` with the current year.

## Multi-page sites

- **Shared parts:** every page uses the same header, footer, `styles.css` and `script.js`.
- **Linking:** pages link to each other with relative paths (`about.html`). Mark the current page with `aria-current="page"`.
- **Each page** has its own `<title>`, meta description and single `<h1>`.
- **Inner pages** (about, contact, a menu page) start with a smaller hero: `<section class="hero hero--center hero--page">`. Add this once under PAGE-SPECIFIC STYLES:
  `.hero--page { padding-block: var(--space-16) var(--space-12); }`.
