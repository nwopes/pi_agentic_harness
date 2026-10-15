#!/usr/bin/env node
// check-site.mjs: a zero-dependency quality check for static websites built with the website skill.
//
//   node check-site.mjs <folder-or-html-file>
//
// Scans every .html file (skipping node_modules, .git and hidden folders), plus the local CSS each page links
// and its <style> blocks. Prints "ERROR" (must fix) and "WARN" (should fix) lines with the file and what to do,
// then a summary. Exit code 1 if there is any ERROR, 0 otherwise, 2 for a usage problem.
// The checks are deliberately simple text checks: they catch common mistakes, they do not replace looking at the page.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target || !existsSync(target)) {
  console.error("usage: node check-site.mjs <folder-or-html-file>");
  process.exit(2);
}
const root = resolve(target);
// The skill's own example page is allowed to contain the example brand.
const skillAssets = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const STARTER_BRAND = /\bTidyflow\b|tidyflow\.example/i;

function htmlFiles(path) {
  if (statSync(path).isFile()) return extname(path).toLowerCase() === ".html" ? [path] : [];
  const out = [];
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(path, name);
    if (statSync(full).isDirectory()) out.push(...htmlFiles(full));
    else if (extname(name).toLowerCase() === ".html") out.push(full);
  }
  return out;
}

const files = htmlFiles(root);
if (!files.length) {
  console.error(`No .html files found in ${root}`);
  process.exit(2);
}

let errors = 0;
let warnings = 0;
const show = (file) => relative(process.cwd(), file) || file;
const error = (file, msg) => {
  errors++;
  console.log(`ERROR  ${show(file)}: ${msg}`);
};
const warn = (file, msg) => {
  warnings++;
  console.log(`WARN   ${show(file)}: ${msg}`);
};

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : undefined;
};
const isLocal = (url) => !!url && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(url);
const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const PLACEHOLDER = /lorem ipsum|dolor sit amet|\bTODO\b|\bTBD\b|\bFIXME\b|placeholder text|your (?:text|title|content|company|name) here|\[(?:insert|add|your)[^\]]*\]|coming soon\.\.\./i;
const EMOJI = /\p{Extended_Pictographic}/u;

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const html = raw.replace(/<!--[\s\S]*?-->/g, "");
  const dir = dirname(file);
  const bodyText = stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<head[\s\S]*?<\/head>/i, " "));

  // --- document basics
  if (!/^\s*<!doctype html>/i.test(raw)) error(file, 'first line must be "<!doctype html>"');
  const htmlTag = /<html\b[^>]*>/i.exec(html)?.[0] ?? "";
  if (!attr(htmlTag, "lang")) error(file, 'add a language to the root element: <html lang="en">');
  if (!/<meta[^>]+charset\s*=/i.test(html)) error(file, 'add <meta charset="utf-8" /> as the first tag in <head>');
  const viewport = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => /name\s*=\s*["']?viewport/i.test(t));
  if (!viewport || !/width\s*=\s*device-width/i.test(attr(viewport, "content") ?? "")) {
    error(file, 'add <meta name="viewport" content="width=device-width, initial-scale=1" /> (without it phones show a zoomed-out desktop page)');
  }
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  if (!title) error(file, "add a descriptive <title> (brand + what the page offers)");
  const description = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => /name\s*=\s*["']?description/i.test(t));
  if (!description || !(attr(description, "content") ?? "").trim()) error(file, 'add <meta name="description" content="one sentence about the page" />');

  // --- headings
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ level: Number(m[1]), text: stripTags(m[2]) }));
  const h1s = headings.filter((h) => h.level === 1).length;
  if (h1s === 0) error(file, "the page needs exactly one <h1> (the main headline)");
  if (h1s > 1) error(file, `found ${h1s} <h1> elements; keep one and make the others <h2>`);
  let previous = 0;
  for (const h of headings) {
    if (previous && h.level > previous + 1) error(file, `heading level skips from h${previous} to h${h.level} at "${h.text.slice(0, 50)}"; use h${previous + 1}`);
    previous = h.level;
  }
  for (const h of headings) if (!h.text) error(file, `an <h${h.level}> is empty`);

  // --- images, links, buttons, form fields
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = attr(m[0], "src") ?? "";
    if (attr(m[0], "alt") === undefined) error(file, `<img src="${src}"> has no alt attribute (describe it, or alt="" if purely decorative)`);
    if (/^(?:https?:)?\/\//i.test(src)) warn(file, `image is hotlinked from another site (${src.slice(0, 60)}); it may break. Use a local file, inline SVG or CSS shapes`);
    else if (src && isLocal(src) && !existsSync(resolve(dir, src.split(/[?#]/)[0]))) error(file, `image file not found: ${src}`);
  }
  const ids = new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  for (const m of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const tag = /<a\b[^>]*>/i.exec(m[0])[0];
    const href = attr(tag, "href");
    const label = stripTags(m[1]) || attr(tag, "aria-label") || "";
    if (href === undefined || href.trim() === "") error(file, `link "${label.slice(0, 40)}" has no href`);
    else if (href === "#") warn(file, `link "${label.slice(0, 40)}" points to "#"; link to a real section (#id), page or mailto:`);
    else if (href.startsWith("#") && href.length > 1 && !ids.has(decodeURIComponent(href.slice(1)))) error(file, `link "${label.slice(0, 40)}" points to ${href} but no element has id="${href.slice(1)}"`);
    else if (isLocal(href) && !href.startsWith("/") && !existsSync(resolve(dir, href.split(/[?#]/)[0]))) warn(file, `link "${label.slice(0, 40)}" points to ${href}, which does not exist yet`);
    if (!label && !/<img\b[^>]*\balt\s*=\s*["'][^"']+/i.test(m[1])) error(file, `a link to ${href} has no text; add text or aria-label`);
  }
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    if (!stripTags(m[2]) && !attr(m[1], "aria-label") && !attr(m[1], "aria-labelledby") && !attr(m[1], "title")) {
      error(file, "a <button> has no text; add visible text or aria-label (icon-only buttons need a label)");
    }
  }
  const labelFor = new Set([...html.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  const wrapped = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)].map((m) => m[1]).join(" ");
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const tag = m[0];
    const type = (attr(tag, "type") ?? "text").toLowerCase();
    if (m[1].toLowerCase() === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
    const id = attr(tag, "id");
    if ((id && labelFor.has(id)) || attr(tag, "aria-label") || attr(tag, "aria-labelledby") || wrapped.includes(tag)) continue;
    error(file, `form field <${m[1]}${id ? ` id="${id}"` : ""}> has no label; add <label for="…"> (placeholder text is not a label)`);
  }

  // --- content
  const placeholder = PLACEHOLDER.exec(bodyText);
  if (placeholder) error(file, `placeholder text left in the page: "${placeholder[0]}"; write real copy`);
  const inSkillAssets = process.platform === "win32" ? resolve(file).toLowerCase().startsWith((skillAssets + sep).toLowerCase()) : resolve(file).startsWith(skillAssets + sep);
  if (STARTER_BRAND.test(raw) && !inSkillAssets) {
    error(file, 'the starter example ("Tidyflow") is still in the page; replace every starter text, link and email with the real content');
  }
  if (EMOJI.test(bodyText)) warn(file, "emoji found in the page text; use the inline SVG icons (assets/icons.md) for a consistent look");
  const inlineStyles = (html.match(/\bstyle\s*=\s*["']/gi) ?? []).length;
  if (inlineStyles > 10) warn(file, `${inlineStyles} inline style="" attributes; move them into classes in the stylesheet`);
  if (!/<main\b/i.test(html)) error(file, "wrap the page content in <main> (screen readers use it to skip navigation)");

  // --- linked files
  const css = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/rel\s*=\s*["']?stylesheet/i.test(m[0])) continue;
    const href = attr(m[0], "href");
    if (!isLocal(href)) continue;
    const path = resolve(dir, href.split(/[?#]/)[0]);
    if (!existsSync(path)) error(file, `stylesheet not found: ${href} (check the file name in <link href>)`);
    else css.push(readFileSync(path, "utf8"));
  }
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (isLocal(m[1]) && !existsSync(resolve(dir, m[1].split(/[?#]/)[0]))) error(file, `script not found: ${m[1]}`);
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css.push(m[1]);

  // --- CSS
  const allCss = css.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  if (!allCss.trim()) {
    error(file, "no CSS found; link the stylesheet with <link rel=\"stylesheet\" href=\"styles.css\" />");
    continue;
  }
  if (!/:root\s*\{[^}]*--[\w-]+\s*:/.test(allCss)) error(file, "CSS has no design tokens; put a theme's :root { --color-… } block at the top (references/themes.md)");
  if (!/:focus-visible/.test(allCss)) error(file, "CSS has no :focus-visible style; keyboard users can't see where they are");
  if (!/@media|clamp\(/.test(allCss)) error(file, "CSS has no @media query or clamp(); the page will not adapt to phones");
  if (/\b(?:transition|animation)\s*:/.test(allCss) && !/prefers-reduced-motion/.test(allCss)) {
    error(file, "CSS animates but has no @media (prefers-reduced-motion: reduce) rule; add one that turns motion off");
  }
  for (const m of allCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const width = /(?:^|[;\s])width\s*:\s*(\d+(?:\.\d+)?)px/.exec(m[2]);
    if (width && Number(width[1]) >= 600 && !/max-width\s*:/.test(m[2])) {
      warn(file, `"${m[1].trim().slice(0, 40)}" has a fixed width of ${width[1]}px; use max-width (or width: min(100%, ${width[1]}px)) so phones don't scroll sideways`);
    }
  }
  const outsideRoot = allCss.replace(/:root\s*\{[^}]*\}/g, "");
  const hexes = new Set((outsideRoot.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase()));
  if (hexes.size > 6) warn(file, `${hexes.size} different hex colours outside :root; use the theme tokens (var(--color-…)) so the palette stays consistent`);
}

console.log(`\n${files.length} page(s) checked: ${errors} error(s), ${warnings} warning(s).${errors ? " Fix every ERROR, then run the check again." : " No errors."}`);
process.exit(errors ? 1 : 0);
