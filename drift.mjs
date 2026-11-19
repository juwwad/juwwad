#!/usr/bin/env node
// drift.mjs — turns a GitHub contribution grid into an animated SVG of a car
// drifting across it and lighting up the cells (GTA VI neon vibe).
// Zero dependencies. Node 18+.
//
//   GITHUB_TOKEN=xxx node drift.mjs --user juwwad --out dist/drift.svg
//   node drift.mjs --demo --out demo.svg            (fake data, no token)
//   node drift.mjs --demo --frame 0.4 --out f.svg   (static snapshot, debug)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------- config ----------
const CFG = {
  cell: 16, // px per grid cell
  dot: 12, // px size of the painted square
  radius: 3, // corner radius
  padX: 70, // canvas padding (car enters/exits here)
  padY: 34,
  duration: 14, // seconds per loop
  moveFrac: 0.88, // fraction of the loop the car is driving; rest = hold
  amp: 3.0, // swing of the S-curves, in cells
  wavelength: 11, // cells per full S
  topAt: 1.5, // x (cells) where the first crest hits the top row
  paintRadius: 1.9, // cells lit around the car's path
  lag: 3, // fallback: a cell is lit once the car is this far past it
  slipDeg: 34, // max drift angle
  bg: "#0f0d1a",
  empty: "#16131f",
  levels: ["#241f3a", "#7c4dff", "#b44cf0", "#ff3f9a", "#ffa526"], // 0..4
  car: { body: "#2f7bff", cabin: "#14307a", glass: "#8fc4ff" },
};

// ---------- args ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const k = a.slice(2);
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) args[k] = true;
  else (args[k] = v), i++;
}

// ---------- data ----------
async function fetchCells(user, token) {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{weeks{contributionDays{contributionCount contributionLevel weekday date}}}}}}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "drift-contrib",
    },
    body: JSON.stringify({ query, variables: { login: user } }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const { data, errors } = await res.json();
  if (errors?.[0]) throw new Error(errors[0].message);
  if (!data?.user) throw new Error(`user "${user}" not found`);
  const L = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
  return data.user.contributionsCollection.contributionCalendar.weeks.flatMap((w, x) =>
    w.contributionDays.map((d) => ({ x, y: d.weekday, level: L[d.contributionLevel] ?? 0 })),
  );
}

function demoCells() {
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const cells = [];
  for (let x = 0; x < 53; x++)
    for (let y = 0; y < 7; y++) {
      if (x === 52 && y > 3) continue; // current week is partial, like the real thing
      const r = rnd();
      cells.push({ x, y, level: r < 0.45 ? 0 : r < 0.7 ? 1 : r < 0.85 ? 2 : r < 0.95 ? 3 : 4 });
    }
  return cells;
}

// ---------- model ----------
const rad = (d) => (d * Math.PI) / 180;
const f2 = (n) => +n.toFixed(2);

function buildModel(cells, C) {
  const W = Math.max(...cells.map((c) => c.x)) + 1;
  const width = W * C.cell + 2 * C.padX;
  const height = 7 * C.cell + 2 * C.padY;
  const px = (cx, cy) => [C.padX + cx * C.cell, C.padY + cy * C.cell];

  const x0 = -5.6, x1 = W + 5.6, N = 1200;
  const k = (2 * Math.PI) / C.wavelength;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const cx = x0 + (x1 - x0) * u;
    const cy = 3.5 - C.amp * Math.cos(k * (cx - C.topAt));
    const slope = C.amp * k * Math.sin(k * (cx - C.topAt)); // dy/dx
    const [X, Y] = px(cx, cy);
    pts.push({ u, cx, cy, X, Y, theta: Math.atan(slope) });
  }
  // curvature proxy = d(theta)/du, normalised; drives the drift angle
  let maxC = 0;
  for (let i = 1; i < N; i++) {
    pts[i].curv = (pts[i + 1].theta - pts[i - 1].theta) / (2 / N);
    maxC = Math.max(maxC, Math.abs(pts[i].curv));
  }
  pts[0].curv = pts[1].curv; pts[N].curv = pts[N - 1].curv;
  for (const p of pts) {
    const n = p.curv / maxC;
    p.slip = Math.sign(n) * Math.pow(Math.abs(n), 0.7); // -1..1
    p.heading = p.theta + rad(C.slipDeg) * p.slip;
  }

  // when does each cell light up? first time the car passes within paintRadius,
  // or (fallback) when the car is `lag` cells past it, whichever is first
  const R2 = (C.paintRadius * C.cell) ** 2;
  const lit = cells.map((c) => {
    const [cx, cy] = px(c.x + 0.5, c.y + 0.5);
    let u = null;
    for (const p of pts) {
      const dx = p.X - cx, dy = p.Y - cy;
      if (dx * dx + dy * dy < R2) { u = p.u; break; }
    }
    const uFall = (c.x + 0.5 + C.lag - x0) / (x1 - x0);
    u = u === null ? uFall : Math.min(u, uFall);
    return { ...c, px: cx - C.dot / 2, py: cy - C.dot / 2, t: Math.max(0.002, u * C.moveFrac) };
  });

  // tyre smoke while sliding
  const puffs = [];
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 4; i < N - 4; i += 6) {
    const p = pts[i];
    if (Math.abs(p.slip) < 0.5) continue;
    const bx = p.X - 13 * Math.cos(p.heading) + (rnd() - 0.5) * 8;
    const by = p.Y - 13 * Math.sin(p.heading) + (rnd() - 0.5) * 8;
    puffs.push({ x: bx, y: by, r: 9 + rnd() * 5, t: p.u * C.moveFrac, life: 0.075 });
  }

  // car keyframes (every 4th sample)
  const car = [];
  for (let i = 0; i <= N; i += 4) {
    const p = pts[i];
    car.push({ t: p.u * C.moveFrac, x: p.X, y: p.Y, a: (p.heading * 180) / Math.PI });
  }
  return { W, width, height, lit, puffs, car };
}

// ---------- svg pieces ----------
function carShape(C) {
  const c = C.car;
  return `
<ellipse rx="27" ry="15" fill="url(#glow)"/>
<path d="M16,-5 L58,-15 L58,15 L16,5Z" fill="url(#beam)"/>
<rect x="-17" y="-8" width="34" height="16" rx="6" fill="${c.body}"/>
<rect x="-14" y="-1" width="28" height="2" fill="#ffffff" opacity=".28"/>
<rect x="-6" y="-6.5" width="13" height="13" rx="3" fill="${c.cabin}"/>
<path d="M7,-6 L12,-4.5 L12,4.5 L7,6Z" fill="${c.glass}" opacity=".9"/>
<rect x="14.5" y="-7" width="3" height="3.5" rx="1" fill="#fff7c2"/>
<rect x="14.5" y="3.5" width="3" height="3.5" rx="1" fill="#fff7c2"/>
<rect x="-17.5" y="-7" width="2.5" height="3.5" rx="1" fill="#ff3355"/>
<rect x="-17.5" y="3.5" width="2.5" height="3.5" rx="1" fill="#ff3355"/>`;
}

function defs() {
  return `<defs>
<radialGradient id="sm"><stop offset="0" stop-color="#efe9ff" stop-opacity=".85"/><stop offset="1" stop-color="#efe9ff" stop-opacity="0"/></radialGradient>
<radialGradient id="glow"><stop offset="0" stop-color="#4d8dff" stop-opacity=".55"/><stop offset="1" stop-color="#4d8dff" stop-opacity="0"/></radialGradient>
<linearGradient id="beam" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#fff7c2" stop-opacity=".35"/><stop offset="1" stop-color="#fff7c2" stop-opacity="0"/></linearGradient>
</defs>`;
}

const pct = (t) => +(t * 100).toFixed(2);

// ---------- animated svg (CSS keyframes, same technique as snk) ----------
function renderAnimated(m, C) {
  const css = [];
  const vars = C.levels.map((c, i) => `--c${i}:${c}`).join(";");
  css.push(`svg{--e:${C.empty};${vars}}`);
  css.push(`.c{fill:var(--e);animation:none linear ${C.duration}s infinite}`);

  // cells, bucketed to 0.25% so keyframes are shared
  const seen = new Set();
  const rects = m.lit.map((c) => {
    const b = Math.max(0.02, Math.round(pct(c.t) * 4) / 4);
    const id = `k${String(b).replace(".", "_")}_${c.level}`;
    if (!seen.has(id)) {
      seen.add(id);
      css.push(`@keyframes ${id}{0%,${f2(b - 0.01)}%{fill:var(--e)}${b}%,100%{fill:var(--c${c.level})}}.${id}{animation-name:${id}}`);
    }
    return `<rect class="c ${id}" x="${f2(c.px)}" y="${f2(c.py)}" width="${C.dot}" height="${C.dot}" rx="${C.radius}"/>`;
  });

  // car
  const stops = m.car.map((s) => `${pct(s.t)}%{transform:translate(${f2(s.x)}px,${f2(s.y)}px) rotate(${f2(s.a)}deg)}`);
  const last = m.car[m.car.length - 1];
  const lastT = `transform:translate(${f2(last.x)}px,${f2(last.y)}px) rotate(${f2(last.a)}deg)`;
  css.push(`@keyframes car{${stops.join("")}100%{${lastT}}}.car{animation:car linear ${C.duration}s infinite}`);

  // smoke
  const puffs = m.puffs.map((p, i) => {
    const a = pct(p.t), peak = pct(p.t + p.life * 0.08), end = pct(p.t + p.life);
    css.push(
      `@keyframes p${i}{0%,${a}%{opacity:0;transform:scale(.4)}${peak}%{opacity:.5;transform:scale(.55)}${end}%,100%{opacity:0;transform:scale(2.2)}}` +
        `.p${i}{animation:p${i} linear ${C.duration}s infinite}`,
    );
    return `<g transform="translate(${f2(p.x)} ${f2(p.y)})"><circle class="s p${i}" r="${f2(p.r)}" fill="url(#sm)" opacity="0"/></g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.width} ${m.height}" width="${m.width}" height="${m.height}">
<title>Contribution grid, drifted</title>
${defs()}
<style>${css.join("\n")}</style>
<rect width="100%" height="100%" rx="10" fill="${C.bg}"/>
${rects.join("\n")}
${puffs.join("\n")}
<g class="car" style="transform:translate(${f2(m.car[0].x)}px,${f2(m.car[0].y)}px)">${carShape(C)}</g>
</svg>
`;
}

// ---------- static snapshot (debug: lets us eyeball a frame without a browser) ----------
function renderFrame(m, C, f) {
  const color = (c) => (c.t <= f ? C.levels[c.level] : C.empty);
  const rects = m.lit.map(
    (c) => `<rect x="${f2(c.px)}" y="${f2(c.py)}" width="${C.dot}" height="${C.dot}" rx="${C.radius}" fill="${color(c)}"/>`,
  );
  const puffs = m.puffs
    .map((p) => {
      const a = (f - p.t) / p.life;
      if (a < 0 || a > 1) return "";
      const op = a < 0.08 ? (a / 0.08) * 0.5 : 0.5 * (1 - (a - 0.08) / 0.92);
      const sc = 0.4 + 1.8 * a;
      return `<circle cx="${f2(p.x)}" cy="${f2(p.y)}" r="${f2(p.r * sc)}" fill="url(#sm)" opacity="${f2(op)}"/>`;
    })
    .join("");
  let s = m.car.find((q) => q.t >= f) || m.car[m.car.length - 1];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.width} ${m.height}" width="${m.width}" height="${m.height}">
${defs()}
<rect width="100%" height="100%" rx="10" fill="${C.bg}"/>
${rects.join("")}${puffs}
<g transform="translate(${f2(s.x)} ${f2(s.y)}) rotate(${f2(s.a)})">${carShape(C)}</g>
</svg>
`;
}

// ---------- main ----------
const out = args.out || "dist/drift.svg";
let cells;
if (args.demo) cells = demoCells();
else if (args.json) cells = JSON.parse(readFileSync(args.json, "utf8"));
else {
  const user = args.user || process.env.GITHUB_ACTOR;
  const token = process.env.GITHUB_TOKEN;
  if (!user || !token) {
    console.error("need --user <name> and GITHUB_TOKEN env (or use --demo)");
    process.exit(1);
  }
  cells = await fetchCells(user, token);
}
if (args.duration) CFG.duration = +args.duration;

const model = buildModel(cells, CFG);
const svg = args.frame !== undefined ? renderFrame(model, CFG, +args.frame) : renderAnimated(model, CFG);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, svg);
console.error(
  `${out}: ${cells.length} cells, ${model.puffs.length} smoke puffs, ${(svg.length / 1024).toFixed(1)} KB`,
);
