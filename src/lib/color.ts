export type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  let h = hex.trim().replace("#", "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n) || h.length < 6) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function luminance([r, g, b]: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function ensureContrast(fg: Rgb, bgs: Rgb[], ratio: number): Rgb {
  const worst = (c: Rgb) => Math.min(...bgs.map((b) => contrast(c, b)));
  if (worst(fg) >= ratio) return fg;
  const bgLum = bgs.reduce((s, b) => s + luminance(b), 0) / bgs.length;
  const target: Rgb = bgLum < 0.4 ? [255, 255, 255] : [0, 0, 0];
  for (let i = 1; i <= 100; i++) {
    const c = mixRgb(fg, target, i / 100);
    if (worst(c) >= ratio) return c;
  }
  return target;
}

export function readableOn(bg: Rgb, ratio = 4.5): Rgb {
  const light: Rgb = [255, 255, 255];
  const dark: Rgb = [17, 17, 20];
  const cl = contrast(light, bg);
  const cd = contrast(dark, bg);
  if (cl >= ratio && cl >= cd) return light;
  if (cd >= ratio) return dark;
  return cl >= cd ? light : dark;
}
