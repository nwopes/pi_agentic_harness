/**
 * Inline SVG charts for results/index.html (no CDN). Colors are CSS custom properties defined by the page,
 * so light/dark themes swap in one place. Mark specs: columns/bars <= 24px thick with a 4px rounded data end,
 * run dots r=4 with a 2px surface ring, hairline solid gridlines, values labelled on the cap / at the tip.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)));
  return ticks;
}

/** Path for a column growing up from the baseline with a 4px rounded top and square base. */
function columnPath(x: number, yTop: number, w: number, yBase: number, r = 4): string {
  const h = yBase - yTop;
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  return `M${x},${yBase} V${yTop + rr} Q${x},${yTop} ${x + rr},${yTop} H${x + w - rr} Q${x + w},${yTop} ${x + w},${yTop + rr} V${yBase} Z`;
}

/** Path for a bar growing right from the baseline with a 4px rounded end. */
function barPath(xBase: number, y: number, xEnd: number, h: number, r = 4): string {
  const w = xEnd - xBase;
  if (w <= 0) return "";
  const rr = Math.min(r, w, h / 2);
  return `M${xBase},${y} H${xEnd - rr} Q${xEnd},${y} ${xEnd},${y + rr} V${y + h - rr} Q${xEnd},${y + h} ${xEnd - rr},${y + h} H${xBase} Z`;
}

export interface ColumnCategory {
  label: string;
  colorVar: string; // e.g. "--series-1"
  mean: number | null;
  values: { label: string; value: number | null }[];
}

export function columnChart(opts: {
  ariaLabel: string;
  categories: ColumnCategory[];
  yMax?: number;
  format: (n: number) => string;
  tickFormat?: (n: number) => string;
  width?: number;
  height?: number;
}): string {
  const W = opts.width ?? 360;
  const H = opts.height ?? 250;
  const m = { top: 24, right: 12, bottom: 40, left: 44 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const allVals = opts.categories.flatMap((c) => [c.mean ?? 0, ...c.values.map((v) => v.value ?? 0)]);
  const maxVal = opts.yMax ?? Math.max(...allVals, 0);
  const ticks = niceTicks(maxVal || 1);
  const top = ticks[ticks.length - 1];
  const y = (v: number) => m.top + plotH - (v / top) * plotH;
  const band = plotW / Math.max(1, opts.categories.length);
  const colW = 24;
  const tf = opts.tickFormat ?? opts.format;
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(opts.ariaLabel)}" class="chart">`);
  for (const t of ticks) {
    parts.push(`<line x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}" class="grid"/>`);
    parts.push(`<text x="${m.left - 8}" y="${y(t) + 4}" text-anchor="end" class="tick">${esc(tf(t))}</text>`);
  }
  parts.push(`<line x1="${m.left}" x2="${W - m.right}" y1="${y(0)}" y2="${y(0)}" class="axis"/>`);
  opts.categories.forEach((c, i) => {
    const cx = m.left + band * i + band / 2;
    const x = cx - colW / 2;
    if (c.mean !== null) {
      const d = columnPath(x, y(c.mean), colW, y(0));
      parts.push(
        `<g class="mark"><title>${esc(`${c.label}: mean ${opts.format(c.mean)} over ${c.values.length} run(s)`)}</title>` +
          (d ? `<path d="${d}" style="fill:var(${c.colorVar})"/>` : "") +
          `<rect x="${cx - band / 2 + 4}" y="${m.top}" width="${band - 8}" height="${plotH}" fill="transparent"/></g>`,
      );
      parts.push(`<text x="${cx}" y="${y(c.mean) - 8}" text-anchor="middle" class="value">${esc(opts.format(c.mean))}</text>`);
    }
    c.values.forEach((v) => {
      if (v.value === null) return;
      parts.push(
        `<g class="mark"><title>${esc(`${c.label} ${v.label}: ${opts.format(v.value)}`)}</title>` +
          `<circle cx="${cx + colW / 2 + 12}" cy="${y(v.value)}" r="4" style="fill:var(${c.colorVar})" class="dot"/></g>`,
      );
    });
    parts.push(`<text x="${cx}" y="${H - m.bottom + 18}" text-anchor="middle" class="label">${esc(c.label)}</text>`);
    parts.push(`<text x="${cx}" y="${H - m.bottom + 32}" text-anchor="middle" class="sublabel">${c.values.length} run${c.values.length === 1 ? "" : "s"}</text>`);
  });
  parts.push(`</svg>`);
  return parts.join("");
}

export interface BarRow {
  label: string;
  sublabel: string;
  value: number;
  valueLabel: string;
}

export function barChartH(opts: { ariaLabel: string; rows: BarRow[]; colorVar: string; format: (n: number) => string; width?: number }): string {
  const W = opts.width ?? 360;
  const rowH = 44;
  const m = { top: 8, right: 92, bottom: 24, left: 112 };
  const H = m.top + m.bottom + rowH * Math.max(1, opts.rows.length);
  const plotW = W - m.left - m.right;
  const max = Math.max(...opts.rows.map((r) => r.value), 0);
  const ticks = niceTicks(max || 1, 3);
  const top = ticks[ticks.length - 1];
  const x = (v: number) => m.left + (v / top) * plotW;
  const barH = 20;
  const parts: string[] = [`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(opts.ariaLabel)}" class="chart">`];
  for (const t of ticks) {
    parts.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${m.top}" y2="${H - m.bottom}" class="grid"/>`);
    parts.push(`<text x="${x(t)}" y="${H - m.bottom + 16}" text-anchor="middle" class="tick">${esc(opts.format(t))}</text>`);
  }
  parts.push(`<line x1="${m.left}" x2="${m.left}" y1="${m.top}" y2="${H - m.bottom}" class="axis"/>`);
  opts.rows.forEach((r, i) => {
    const yTop = m.top + rowH * i + (rowH - barH) / 2;
    const d = barPath(m.left, yTop, x(r.value), barH);
    parts.push(
      `<g class="mark"><title>${esc(`${r.label} (${r.sublabel}): ${r.valueLabel}`)}</title>` +
        (d ? `<path d="${d}" style="fill:var(${opts.colorVar})"/>` : "") +
        `<rect x="0" y="${m.top + rowH * i}" width="${W}" height="${rowH}" fill="transparent"/></g>`,
    );
    parts.push(`<text x="${m.left - 10}" y="${yTop + 9}" text-anchor="end" class="label">${esc(r.label)}</text>`);
    parts.push(`<text x="${m.left - 10}" y="${yTop + 22}" text-anchor="end" class="sublabel">${esc(r.sublabel)}</text>`);
    parts.push(`<text x="${x(r.value) + 6}" y="${yTop + 15}" class="value">${esc(r.valueLabel)}</text>`);
  });
  parts.push(`</svg>`);
  return parts.join("");
}
