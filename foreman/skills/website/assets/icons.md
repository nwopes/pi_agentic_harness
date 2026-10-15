# Icons

24 simple line icons drawn for this skill: original geometric paths on a 24×24 grid. They inherit the text colour (`currentColor`), so they follow the theme automatically.

**How to use:**
- Copy the whole `<svg>` element inline. Don't use an `<img>`, and don't link a remote file.
- Size it with CSS (`.icon-tile svg`, `.btn svg` and `.checklist svg` already do), or with `width="20" height="20"`.
- Decorative icons keep `aria-hidden="true" focusable="false"`.
- If an icon is the only content of a button or link, give that button or link an `aria-label`.
- **Use these instead of emoji.** Don't mix icon styles on one page.
- Pick by meaning: a feature about speed gets `bolt`, security gets `shield`, team gets `users`. Use each icon at most once per section.

Every icon uses this wrapper (replace `PATHS` with the paths below):

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">PATHS</svg>
```

| Name | Use for | PATHS |
|---|---|---|
| check | ticks in lists, "included" | `<path d="M5 12.5l4.5 4.5L19 7.5" />` |
| arrow-right | "Get started →", "Read more" | `<path d="M5 12h14M13 6l6 6-6 6" />` |
| menu | mobile nav toggle (open) | `<path d="M4 7h16M4 12h16M4 17h16" />` |
| close | mobile nav toggle (close), dismiss | `<path d="M6 6l12 12M18 6L6 18" />` |
| plus | add, expand | `<path d="M12 5v14M5 12h14" />` |
| chevron-down | dropdowns, "more" | `<path d="M6 9l6 6 6-6" />` |
| bolt | speed, automation, instant | `<path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z" />` |
| shield | security, privacy, safety | `<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6L12 3z" /><path d="M9 12l2 2 4-4" />` |
| chart | analytics, growth, reports | `<path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 16v-5M12 16V8M16 16v-3" />` |
| clock | time saved, hours, reminders | `<circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />` |
| globe | worldwide, languages, web | `<circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z" />` |
| users | team, community, collaboration | `<circle cx="9" cy="8.5" r="3.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M15.5 5.2a3.5 3.5 0 010 6.6" /><path d="M17.5 14.4c2 .9 3.5 3 3.5 5.6" />` |
| mail | email, newsletter, contact | `<rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="M3.5 7l8.5 6 8.5-6" />` |
| message | chat, support, feedback | `<path d="M4 5.5h16v10H9l-5 4v-14z" />` |
| map-pin | location, address, visit us | `<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0113 0c0 4.8-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.5" />` |
| code | developers, API, integrations | `<path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5" />` |
| layers | platform, stack, all-in-one | `<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8 12 3.5z" /><path d="M3.5 12.5l8.5 4.5 8.5-4.5" /><path d="M3.5 16.5L12 21l8.5-4.5" />` |
| sparkle | new, AI, magic, highlights | `<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1-5.1-1.9 5.1-1.9L12 3.5z" /><path d="M18.5 16v4M16.5 18h4" />` |
| heart | care, favourites, wellbeing | `<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0112 7.3a4.3 4.3 0 017.5 2.5C19.5 15.4 12 20 12 20z" />` |
| lock | private, secure login | `<rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 018 0v2.5" />` |
| star | ratings, favourites (add `fill="currentColor"` for a solid star) | `<path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8L12 3.8z" />` |
| calendar | bookings, events, scheduling | `<rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" />` |
| sync | sync, integrations, updates | `<path d="M20 12a8 8 0 01-14 5.3M4 12a8 8 0 0114-5.3" /><path d="M18 3v4h-4M6 21v-4h4" />` |
| sliders | settings, customisation, control | `<path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" />` |

**Full example** (a feature card icon):

```html
<div class="icon-tile">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z" /></svg>
</div>
```
