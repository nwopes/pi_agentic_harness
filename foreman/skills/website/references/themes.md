# Themes

Pick **one** theme with the table below. Then paste its `:root` block over the THEME TOKENS block at the top of `styles.css`, and put its font `<link>` tags in `<head>`. Never invent a palette, and never mix two themes.

## Pick a theme

| The site is for… | Theme |
|---|---|
| SaaS, app, productivity tool, B2B product, fintech, startup product page | **Clean SaaS** (light) |
| Developer tool, API, AI product, security, gaming, music or night events, anything the brief calls "dark" | **Midnight tech** (dark) |
| Restaurant, café, bakery, hotel, local shop, books, magazine, blog, non-profit, crafts | **Warm editorial** (light, serif headings) |
| Launch, campaign, conference or event, agency, creative studio, bold or loud brand | **Bold startup** (light, heavy type) |
| Personal portfolio, consultant, architect, wellness, therapist, docs, "minimal" or "clean" in the brief | **Calm minimal** (light, quiet) |

**If the brief names brand colours:**
1. Keep the closest theme and replace only `--color-accent`, `--color-accent-hover`, `--color-accent-strong`, `--color-link`, `--color-focus` and the accent parts of the gradients.
2. Check that white (or `--color-accent-contrast`) on the new accent has a contrast ratio of at least 4.5:1. If it doesn't, use a darker shade of the brand colour for buttons and links, and keep the bright one for decorative shapes only.
3. Use a contrast calculator, or the formula in WCAG 2.x, and write the ratio in a CSS comment.

**What every token is for:**

| Token | Use |
|---|---|
| `--color-bg` | Page background |
| `--color-surface` | Cards and panels |
| `--color-surface-2` | Alternate section background (`.section--alt`) and footer |
| `--color-text` | Headings and body text |
| `--color-muted` | Secondary text: leads, captions, card text |
| `--color-border` | Dividers and card borders (decorative) |
| `--color-border-strong` | Form-field borders and the secondary button outline (meets 3:1 for UI parts) |
| `--color-accent` | Primary buttons, links, icons, the active state. **The only strong colour on the page.** |
| `--color-accent-hover` | Hover state of accent things |
| `--color-accent-contrast` | Text on accent backgrounds (primary button, CTA band) |
| `--color-accent-soft` | Tinted backgrounds: badges, icon tiles |
| `--color-accent-strong` | Text on `--color-accent-soft` (badges, eyebrows) |
| `--color-accent-2` | Decorative second colour for gradients and the brand mark only. **Never text.** |
| `--color-highlight` | Marker highlight behind heading words (`.highlight`) |

Contrast ratios below were computed with the WCAG 2.x relative-luminance formula. AA needs at least 4.5:1 for body text and 3:1 for large text and UI borders. Every text pair listed passes AA.

---

## 1. Clean SaaS (light)

Crisp white, indigo accent, a soft glow behind the hero. The safe default for most products.

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet" />
```

```css
:root {
  color-scheme: light;
  --color-bg: #ffffff;
  --color-surface: #ffffff;
  --color-surface-2: #f5f7fb;
  --color-text: #0f172a;
  --color-muted: #475569;
  --color-border: #e2e8f0;
  --color-border-strong: #7b8598;
  --color-accent: #4f46e5;
  --color-accent-hover: #4338ca;
  --color-accent-contrast: #ffffff;
  --color-accent-soft: #eef2ff;
  --color-accent-strong: #3730a3;
  --color-accent-2: #0ea5e9;
  --color-highlight: #e0e7ff;
  --color-link: #4f46e5;
  --color-focus: #4f46e5;
  --font-heading: "Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --font-body: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --gradient-hero: radial-gradient(60% 55% at 50% 0%, rgba(79, 70, 229, 0.14) 0%, rgba(79, 70, 229, 0) 70%),
    radial-gradient(35% 40% at 92% 8%, rgba(14, 165, 233, 0.12) 0%, rgba(14, 165, 233, 0) 70%);
  --gradient-media: linear-gradient(135deg, #eef2ff 0%, #e0f2fe 100%);
  --gradient-cta: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%);
  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.06);
  --shadow-md: 0 4px 12px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.06);
  --shadow-lg: 0 24px 48px -16px rgba(15, 23, 42, 0.22);
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 20px;
}
```

Verified contrast:

| Pair | Ratio |
|---|---|
| text / bg | 17.85 |
| text / surface-2 | 16.65 |
| muted / bg | 7.58 |
| muted / surface-2 | 7.07 |
| accent-contrast / accent (button) | 6.29 |
| accent-contrast / accent-hover | 7.90 |
| accent (link) / bg | 6.29 |
| accent (link) / surface-2 | 5.86 |
| accent-strong / accent-soft (badge) | 8.88 |
| border-strong / bg (input border) | 3.72 |
| border-strong / surface-2 | 3.47 |

## 2. Midnight tech (dark)

Deep navy, violet accent with dark text on it, glowing gradients. For developer, AI and other "dark mode" brands.

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
```

```css
:root {
  color-scheme: dark;
  --color-bg: #0b1020;
  --color-surface: #121a2e;
  --color-surface-2: #0e1527;
  --color-text: #e7eaf3;
  --color-muted: #a3acc4;
  --color-border: #263250;
  --color-border-strong: #5b6a91;
  --color-accent: #a78bfa;
  --color-accent-hover: #c4b5fd;
  --color-accent-contrast: #0b1020;
  --color-accent-soft: #221c45;
  --color-accent-strong: #c4b5fd;
  --color-accent-2: #22d3ee;
  --color-highlight: #3b2f7a;
  --color-link: #a78bfa;
  --color-focus: #c4b5fd;
  --font-heading: "Space Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --font-body: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --gradient-hero: radial-gradient(55% 50% at 50% 0%, rgba(167, 139, 250, 0.22) 0%, rgba(167, 139, 250, 0) 70%),
    radial-gradient(35% 40% at 90% 10%, rgba(34, 211, 238, 0.14) 0%, rgba(34, 211, 238, 0) 70%);
  --gradient-media: linear-gradient(135deg, #1b1f45 0%, #10263a 100%);
  --gradient-cta: linear-gradient(135deg, #a78bfa 0%, #c4b5fd 100%);
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-md: 0 6px 16px rgba(0, 0, 0, 0.45);
  --shadow-lg: 0 30px 60px -20px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(167, 139, 250, 0.08);
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 18px;
}
```

Verified contrast:

| Pair | Ratio |
|---|---|
| text / bg | 15.74 |
| text / surface | 14.40 |
| muted / bg | 8.34 |
| muted / surface | 7.63 |
| accent-contrast / accent (button) | 6.96 |
| accent-contrast / accent-hover | 10.26 |
| accent (link) / bg | 6.96 |
| accent (link) / surface | 6.36 |
| accent-strong / accent-soft (badge) | 8.62 |
| text / highlight (marked word) | 9.32 |
| border-strong / surface (input border) | 3.23 |

## 3. Warm editorial (light, serif headings)

Cream paper, terracotta accent, serif headlines. Feels crafted and human.

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600;700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet" />
```

```css
:root {
  color-scheme: light;
  --color-bg: #fbf7f1;
  --color-surface: #ffffff;
  --color-surface-2: #f4ece0;
  --color-text: #1f1a14;
  --color-muted: #5b5045;
  --color-border: #e6dac8;
  --color-border-strong: #9c8a74;
  --color-accent: #b3401c;
  --color-accent-hover: #96351a;
  --color-accent-contrast: #ffffff;
  --color-accent-soft: #f9e7dd;
  --color-accent-strong: #8a2f15;
  --color-accent-2: #d9a441;
  --color-highlight: #f6dcb8;
  --color-link: #b3401c;
  --color-focus: #b3401c;
  --font-heading: "Fraunces", ui-serif, Georgia, "Times New Roman", serif;
  --font-body: "Source Sans 3", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --gradient-hero: radial-gradient(60% 55% at 15% 0%, rgba(217, 164, 65, 0.18) 0%, rgba(217, 164, 65, 0) 70%),
    radial-gradient(40% 45% at 95% 20%, rgba(179, 64, 28, 0.10) 0%, rgba(179, 64, 28, 0) 70%);
  --gradient-media: linear-gradient(135deg, #f6dcb8 0%, #f9e7dd 100%);
  --gradient-cta: linear-gradient(135deg, #b3401c 0%, #96351a 100%);
  --shadow-sm: 0 1px 2px rgba(31, 26, 20, 0.06);
  --shadow-md: 0 6px 16px rgba(31, 26, 20, 0.08);
  --shadow-lg: 0 24px 48px -18px rgba(31, 26, 20, 0.25);
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
}
```

Verified contrast:

| Pair | Ratio |
|---|---|
| text / bg | 16.18 |
| text / surface-2 | 14.74 |
| muted / bg | 7.35 |
| muted / surface-2 | 6.69 |
| accent-contrast / accent (button) | 5.73 |
| accent-contrast / accent-hover | 7.44 |
| accent (link) / bg | 5.37 |
| accent (link) / surface-2 | 4.89 |
| accent-strong / accent-soft (badge) | 7.01 |
| text / highlight (marked word) | 13.03 |
| border-strong / surface (input border) | 3.33 |

Editorial tip: use `h1` and `h2` in Fraunces at weight 600–700, and keep `letter-spacing` at `-0.01em` (serifs need less tightening). Add `h1, h2 { letter-spacing: -0.01em; }` under PAGE-SPECIFIC STYLES.

## 4. Bold startup (light, heavy type)

Pure white, near-black text, deep violet accent, a yellow marker highlight and very large headlines. Energetic without being messy.

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@600;700;800&display=swap" rel="stylesheet" />
```

```css
:root {
  color-scheme: light;
  --color-bg: #ffffff;
  --color-surface: #ffffff;
  --color-surface-2: #f4f4f5;
  --color-text: #09090b;
  --color-muted: #52525b;
  --color-border: #e4e4e7;
  --color-border-strong: #8b8b94;
  --color-accent: #6d28d9;
  --color-accent-hover: #5b21b6;
  --color-accent-contrast: #ffffff;
  --color-accent-soft: #f3e8ff;
  --color-accent-strong: #5b21b6;
  --color-accent-2: #f59e0b;
  --color-highlight: #fde047;
  --color-link: #6d28d9;
  --color-focus: #6d28d9;
  --font-heading: "Sora", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --font-body: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --gradient-hero: radial-gradient(50% 50% at 85% 10%, rgba(109, 40, 217, 0.16) 0%, rgba(109, 40, 217, 0) 70%),
    radial-gradient(40% 40% at 10% 30%, rgba(245, 158, 11, 0.14) 0%, rgba(245, 158, 11, 0) 70%);
  --gradient-media: linear-gradient(135deg, #f3e8ff 0%, #fef3c7 100%);
  --gradient-cta: linear-gradient(135deg, #6d28d9 0%, #5b21b6 100%);
  --shadow-sm: 0 1px 2px rgba(9, 9, 11, 0.08);
  --shadow-md: 0 6px 16px rgba(9, 9, 11, 0.1);
  --shadow-lg: 0 28px 56px -20px rgba(9, 9, 11, 0.3);
  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 24px;
}
```

Verified contrast:

| Pair | Ratio |
|---|---|
| text / bg | 19.90 |
| text / surface-2 | 18.10 |
| muted / bg | 7.73 |
| muted / surface-2 | 7.03 |
| accent-contrast / accent (button) | 7.10 |
| accent-contrast / accent-hover | 8.98 |
| accent (link) / bg | 7.10 |
| accent (link) / surface-2 | 6.46 |
| accent-strong / accent-soft (badge) | 7.61 |
| text / highlight (marked word) | 15.09 |
| border-strong / bg (input border) | 3.38 |

Bold tip: wrap one or two words of the `h1` in `<span class="highlight">`. Add `.hero h1 { font-weight: 800; }` under PAGE-SPECIFIC STYLES.

## 5. Calm minimal (light, quiet)

Warm off-white, stone greys, deep teal accent, generous whitespace and one typeface. For people and practices that want to feel trustworthy and calm.

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
```

```css
:root {
  color-scheme: light;
  --color-bg: #fafaf9;
  --color-surface: #ffffff;
  --color-surface-2: #f5f5f4;
  --color-text: #1c1917;
  --color-muted: #57534e;
  --color-border: #e7e5e4;
  --color-border-strong: #8c857f;
  --color-accent: #0f766e;
  --color-accent-hover: #115e59;
  --color-accent-contrast: #ffffff;
  --color-accent-soft: #e6f4f1;
  --color-accent-strong: #115e59;
  --color-accent-2: #84cc16;
  --color-highlight: #ccebe5;
  --color-link: #0f766e;
  --color-focus: #0f766e;
  --font-heading: "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --font-body: "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --gradient-hero: radial-gradient(60% 50% at 50% 0%, rgba(15, 118, 110, 0.08) 0%, rgba(15, 118, 110, 0) 70%);
  --gradient-media: linear-gradient(135deg, #e6f4f1 0%, #f5f5f4 100%);
  --gradient-cta: linear-gradient(135deg, #0f766e 0%, #115e59 100%);
  --shadow-sm: 0 1px 2px rgba(28, 25, 23, 0.05);
  --shadow-md: 0 4px 12px rgba(28, 25, 23, 0.06);
  --shadow-lg: 0 20px 40px -18px rgba(28, 25, 23, 0.18);
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
}
```

Verified contrast:

| Pair | Ratio |
|---|---|
| text / bg | 16.74 |
| text / surface-2 | 16.03 |
| muted / bg | 7.30 |
| muted / surface-2 | 6.99 |
| accent-contrast / accent (button) | 5.47 |
| accent-contrast / accent-hover | 7.58 |
| accent (link) / bg | 5.24 |
| accent (link) / surface-2 | 5.02 |
| accent-strong / accent-soft (badge) | 6.71 |
| text / highlight (marked word) | 13.81 |
| border-strong / bg (input border) | 3.48 |

Minimal tip: use fewer sections (5–6). Prefer `.hero--center`, and leave out heavy shadows on cards: add `.card { box-shadow: none; }`.
