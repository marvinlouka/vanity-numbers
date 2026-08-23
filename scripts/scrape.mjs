/* =====================================================================
   Vanity Numbers scraper — runs on Node 20+ (no dependencies)
   Writes data.json in the repo root.

   WHY THIS EXISTS
   Running this in a browser required same-origin fetches against
   tossabledigits.com, which meant a live Chrome tab, a live session, and
   a token sitting in a file. Node has no CORS, so this runs anywhere —
   including a free GitHub Actions runner on a schedule.

   QUIRKS OF THE SOURCE SITE (learned the hard way)
   1. Every search is capped at 20 result rows.
   2. The "Filter by Region" dropdown counts are NOT reliable totals —
      they are derived from an already-capped result set, so they can be
      far lower than reality (Alabama reported 25 zeros; there are 125+).
   3. The &region=XX filter is SILENTLY IGNORED when a query has no hits
      in that region. The response then contains rows from anywhere,
      including Canada. Never trust the region you asked for — always
      bucket a number by the state code parsed out of its own location.
   4. Because of the 20-row cap, coverage is widened by re-running each
      pattern with a leading and trailing digit ("088888", "888880", ...)
      and de-duplicating by phone number.

   WHAT IT SEARCHES
   5-in-a-row (9), 6-in-a-row (10), four-zeros (1), AAA-BBBB (90) and
   7-in-a-row (10). AAA-BBBB is by far the largest set but also the cheapest:
   ~74 of the 90 return nothing, and a miss costs exactly one request because
   there are no region hints to follow up on.
   ===================================================================== */

import { writeFile } from "node:fs/promises";

const BASE = "https://www.tossabledigits.com/findnumber.php";

const NAME = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",
  CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",
  HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",
  LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",
  MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",
  NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",
  OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",PR:"Puerto Rico",RI:"Rhode Island",
  SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",
  VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"
};
const US = new Set(Object.keys(NAME));

const PATTERNS_5 = ["11111","22222","33333","44444","55555","66666","77777","88888","99999"];
const PATTERNS_6 = ["111111","222222","333333","444444","555555","666666","777777","888888","999999","000000"];

/* AAA-BBBB — three of one digit followed by four of another, e.g. 888-5555.
   Every ordered pair of DISTINCT digits: 90 patterns. The A === B case is
   seven-in-a-row, which is covered by PATTERNS_7 below so the two sets stay
   disjoint and nothing is double-counted.

   Most of these return nothing — 0xx and 1xx can't be a NANP exchange, so
   the entire 000-* and 111-* families are dead. They're queried anyway
   because a cheap empty response is better than an assumption that silently
   goes stale if the site's inventory shifts. */
const PATTERNS_AB = [];
for (let a = 0; a <= 9; a++) {
  for (let b = 0; b <= 9; b++) {
    if (a !== b) PATTERNS_AB.push(String(a).repeat(3) + String(b).repeat(4));
  }
}

const PATTERNS_7 = Array.from({ length: 10 }, (_, d) => String(d).repeat(7));

/* 8885555 -> "888-5555". Only for display; queries always use raw digits. */
const dash = p => (p.length === 7 ? `${p.slice(0, 3)}-${p.slice(3)}` : p);

const CONCURRENCY = 3;
const TIMEOUT_MS  = 20000;
const RETRIES     = 3;

let fetched = 0, failed = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function getHtml(query, region) {
  let url = `${BASE}?query=${encodeURIComponent(query)}&subftr=vanity&doSearch=Search`;
  if (region) url += `&region=${region}`;

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": "vanity-numbers-bot (github.com/marvinlouka/vanity-numbers)" }
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fetched++;
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === RETRIES - 1) { failed++; return null; }
      await sleep(1000 * (attempt + 1));
    }
  }
}

const stripTags = s => s.replace(/<[^>]*>/g, "");
const decode = s => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/* Mirrors the DOM approach that was verified in the browser: split into
   rows, pull the cells in order, find the cell holding a phone number and
   take the cell after it. Deliberately does NOT assume the number and
   location tags are adjacent in the raw markup. */
function parseRows(html) {
  if (!html) return [];
  const rows = [];
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(c => decode(stripTags(c[1])).replace(/\s+/g, " ").trim());
    const i = cells.findIndex(c => /^\+1[\s\d]{10,}$/.test(c));
    if (i !== -1) rows.push({ number: cells[i], location: cells[i + 1] || "" });
  }
  return rows;
}

/* Region dropdown counts. Used ONLY to discover which states are worth
   querying — never as an authoritative total (see quirk #2). */
function parseRegionHints(html) {
  const hints = {};
  if (!html) return hints;
  const sel = html.match(/<select[^>]*name=["']?region["']?[^>]*>([\s\S]*?)<\/select>/i);
  if (!sel) return hints;
  const re = /<option[^>]*value=["']([A-Z]{2})["'][^>]*>\s*([^<]*?)\s*<\/option>/gi;
  let m;
  while ((m = re.exec(sel[1]))) {
    const count = m[2].match(/\((\d+)\)\s*$/);
    if (count) hints[m[1]] = +count[1];
  }
  return hints;
}

/* Authoritative bucketing — trust the row's own location, not the filter. */
function groupByRealState(rawRows, requiredPattern) {
  const byNumber = new Map();
  for (const r of rawRows) byNumber.set(r.number, r.location);

  const buckets = {};
  for (const [number, location] of byNumber) {
    const m = location.match(/^(.*),\s*([A-Z]{2})\s*US$/);
    if (!m) continue;                                    // drops Canada / malformed
    const code = m[2];
    if (!US.has(code)) continue;

    const digits = number.replace(/\D/g, "").replace(/^1/, "");
    if (digits.length !== 10) continue;
    if (!digits.includes(requiredPattern)) continue;

    (buckets[code] ??= []).push({ number, location: `${m[1].trim()}, ${code}` });
  }

  return Object.keys(buckets)
    .sort((a, b) => NAME[a].localeCompare(NAME[b]))
    .map(code => ({
      state: NAME[code],
      count: buckets[code].length,
      numbers: buckets[code].sort((a, b) => a.number.localeCompare(b.number))
    }));
}

async function collect(pattern) {
  const topHtml = await getHtml(pattern);
  const hints = parseRegionHints(topHtml);
  const states = Object.keys(hints).filter(c => US.has(c));

  let all = parseRows(topHtml);

  const perState = await pool(states, CONCURRENCY, async code => parseRows(await getHtml(pattern, code)));
  for (const rows of perState) all = all.concat(rows);

  // A state that returned a full page of 20 is hiding more behind the cap.
  const capped = states.filter((_, i) => perState[i].length >= 20);
  if (capped.length) {
    const subQueries = [];
    for (let d = 0; d <= 9; d++) { subQueries.push(`${d}${pattern}`); subQueries.push(`${pattern}${d}`); }
    const jobs = capped.flatMap(code => subQueries.map(q => [q, code]));
    const extra = await pool(jobs, CONCURRENCY, async ([q, code]) => parseRows(await getHtml(q, code)));
    for (const rows of extra) all = all.concat(rows);
  }

  return all;
}

function validate(data) {
  const problems = [];

  const checkStates = (states, pattern, tag) => {
    const seen = new Set();
    for (const s of states) {
      const code = Object.keys(NAME).find(c => NAME[c] === s.state);
      if (s.count !== s.numbers.length) problems.push(`${tag}/${s.state}: count != numbers.length`);
      for (const r of s.numbers) {
        const digits = r.number.replace(/\D/g, "").replace(/^1/, "");
        if (digits.length !== 10)          problems.push(`${tag}/${r.number}: not 10 digits`);
        if (!digits.includes(pattern))     problems.push(`${tag}/${r.number}: pattern missing`);
        if (r.location.slice(-2) !== code) problems.push(`${tag}/${r.number}: filed under wrong state`);
        if (seen.has(r.number))            problems.push(`${tag}/${r.number}: duplicate`);
        seen.add(r.number);
      }
    }
  };

  for (const p of data.patterns_5) checkStates(p.states, p.pattern, p.pattern);
  checkStates(data.pattern_0000.states, "0000", "0000");
  for (const p of data.patterns_ab) checkStates(p.states, p.pattern, dash(p.pattern));
  for (const p of data.patterns_7) if (p.states) checkStates(p.states, p.pattern, dash(p.pattern));

  const sum5  = data.patterns_5.reduce((a, p) => a + p.count, 0);
  const sum0  = data.pattern_0000.states.reduce((a, s) => a + s.count, 0);
  const sumAB = data.patterns_ab.reduce((a, p) => a + p.count, 0);
  if (data.summary.total_5_in_a_row !== sum5)  problems.push("summary.total_5_in_a_row mismatch");
  if (data.pattern_0000.total !== sum0)        problems.push("pattern_0000.total mismatch");
  if (data.summary.total_aaa_bbbb !== sumAB)   problems.push("summary.total_aaa_bbbb mismatch");

  /* AAA-BBBB is allowed to be empty — the inventory really can dry up — but
     the pattern list itself must be complete, or a partial run could quietly
     publish a shrunken set. */
  if (data.summary.aaa_bbbb_patterns_searched !== 90)
    problems.push(`expected 90 AAA-BBBB patterns searched, got ${data.summary.aaa_bbbb_patterns_searched}`);

  // A scrape that finds nothing is far more likely to be a broken scrape
  // than a genuinely empty inventory. Never publish it over good data.
  if (sum5 === 0) problems.push("no 5-in-a-row results at all — refusing to publish");

  return problems;
}

/* Plain-text rendering: one number per line, grouped by pattern then state.
   Deliberately boring so it stays easy to read, grep and diff. */
function buildText(data) {
  const out = [];
  out.push("VANITY NUMBERS — US ONLY, NO TOLL FREE");
  out.push("Updated: " + data.date);
  out.push(`${data.summary.total_5_in_a_row} five-in-a-row · ${data.summary.total_0000} four-zeros across ${data.summary.state_count_0000} states · ${data.summary.total_aaa_bbbb} AAA-BBBB across ${data.summary.aaa_bbbb_patterns_with_results} of ${data.summary.aaa_bbbb_patterns_searched} combinations`);
  out.push("");

  out.push("=".repeat(52));
  out.push("5 IN A ROW");
  out.push("=".repeat(52));
  for (const p of data.patterns_5) {
    out.push("");
    out.push(`--- ${p.pattern} — ${p.count} numbers ---`);
    for (const s of p.states) {
      out.push("");
      out.push(`  ${s.state.toUpperCase()} (${s.count})`);
      for (const r of s.numbers) out.push(`    ${r.number}   ${r.location}`);
    }
  }

  out.push("");
  out.push("=".repeat(52));
  out.push(`4 ZEROS — ${data.pattern_0000.total} numbers across ${data.pattern_0000.state_count} states`);
  out.push("=".repeat(52));
  for (const s of data.pattern_0000.states) {
    out.push("");
    out.push(`  ${s.state.toUpperCase()} (${s.count})`);
    for (const r of s.numbers) out.push(`    ${r.number}   ${r.location}`);
  }

  out.push("");
  out.push("=".repeat(52));
  out.push("6 IN A ROW");
  out.push("=".repeat(52));
  for (const p of data.patterns_6) {
    out.push("");
    out.push(`--- ${p.pattern} — ${p.status} ---`);
    for (const s of p.states || []) {
      for (const r of s.numbers) out.push(`    ${r.number}   ${r.location}`);
    }
  }

  out.push("");
  out.push("=".repeat(52));
  out.push(`AAA-BBBB — ${data.summary.total_aaa_bbbb} numbers across ${data.patterns_ab.length} patterns`);
  out.push("=".repeat(52));
  if (!data.patterns_ab.length) {
    out.push("");
    out.push("  No results in any of the 90 combinations.");
  }
  for (const p of data.patterns_ab) {
    out.push("");
    out.push(`--- ${dash(p.pattern)} — ${p.count} numbers ---`);
    for (const s of p.states) {
      out.push("");
      out.push(`  ${s.state.toUpperCase()} (${s.count})`);
      for (const r of s.numbers) out.push(`    ${r.number}   ${r.location}`);
    }
  }

  out.push("");
  out.push("=".repeat(52));
  out.push("7 IN A ROW");
  out.push("=".repeat(52));
  for (const p of data.patterns_7) {
    out.push("");
    out.push(`--- ${dash(p.pattern)} — ${p.status} ---`);
    for (const s of p.states || []) {
      for (const r of s.numbers) out.push(`    ${r.number}   ${r.location}`);
    }
  }

  out.push("");
  return out.join("\n");
}

async function main() {
  const started = Date.now();

  const patterns_5 = [];
  for (const p of PATTERNS_5) {
    const states = groupByRealState(await collect(p), p);
    const count = states.reduce((a, s) => a + s.count, 0);
    console.log(`  ${p}: ${count} numbers across ${states.length} states`);
    if (count > 0) patterns_5.push({ pattern: p, count, states });
  }

  const zeroStates = groupByRealState(await collect("0000"), "0000");
  const total0 = zeroStates.reduce((a, s) => a + s.count, 0);
  console.log(`  0000: ${total0} numbers across ${zeroStates.length} states`);

  const patterns_6 = [];
  for (const p of PATTERNS_6) {
    const states = groupByRealState(await collect(p), p);
    const usCount = states.reduce((a, s) => a + s.count, 0);
    if (usCount > 0) {
      patterns_6.push({ pattern: p, status: `${usCount} US result${usCount === 1 ? "" : "s"}`, states });
    } else {
      const anywhere = parseRows(await getHtml(p)).length > 0;
      patterns_6.push({ pattern: p, status: anywhere ? "No US results — Canada only" : "No results" });
    }
    console.log(`  ${p}: ${patterns_6.at(-1).status}`);
  }

  /* AAA-BBBB. 90 patterns, and the overwhelming majority come back empty, so
     only the ones with US hits are kept in the output — an array of 74 "No
     results" entries would bloat data.json and the page for no benefit. The
     count of patterns searched is recorded in the summary so a partial run is
     still detectable. */
  const patterns_ab = [];
  for (const p of PATTERNS_AB) {
    const states = groupByRealState(await collect(p), p);
    const count = states.reduce((a, s) => a + s.count, 0);
    if (count > 0) {
      patterns_ab.push({ pattern: p, count, states });
      console.log(`  ${dash(p)}: ${count} numbers across ${states.length} states`);
    }
  }
  const totalAB = patterns_ab.reduce((a, p) => a + p.count, 0);
  console.log(`  AAA-BBBB: ${totalAB} numbers across ${patterns_ab.length} of 90 patterns`);

  const patterns_7 = [];
  for (const p of PATTERNS_7) {
    const states = groupByRealState(await collect(p), p);
    const usCount = states.reduce((a, s) => a + s.count, 0);
    if (usCount > 0) {
      patterns_7.push({ pattern: p, status: `${usCount} US result${usCount === 1 ? "" : "s"}`, count: usCount, states });
    } else {
      const anywhere = parseRows(await getHtml(p)).length > 0;
      patterns_7.push({ pattern: p, status: anywhere ? "No US results — Canada only" : "No results", count: 0 });
    }
    console.log(`  ${dash(p)}: ${patterns_7.at(-1).status}`);
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const total5 = patterns_5.reduce((a, p) => a + p.count, 0);

  const data = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    patterns_5,
    pattern_0000: { total: total0, state_count: zeroStates.length, states: zeroStates },
    patterns_6,
    patterns_ab,
    patterns_7,
    summary: {
      total_5_in_a_row: total5,
      patterns_with_results: patterns_5.length,
      total_0000: total0,
      state_count_0000: zeroStates.length,
      total_aaa_bbbb: totalAB,
      aaa_bbbb_patterns_searched: PATTERNS_AB.length,
      aaa_bbbb_patterns_with_results: patterns_ab.length
    }
  };

  const problems = validate(data);
  if (problems.length) {
    console.error(`\nValidation failed with ${problems.length} problem(s):`);
    problems.slice(0, 25).forEach(p => console.error("  - " + p));
    process.exit(1);
  }

  await writeFile("data.json", JSON.stringify(data, null, 1));
  await writeFile("numbers.txt", buildText(data));

  console.log(
    `\nOK  ${total5} five-in-a-row + ${total0} four-zeros + ${totalAB} AAA-BBBB` +
    `  |  ${fetched} requests, ${failed} failed` +
    `  |  ${Math.round((Date.now() - started) / 1000)}s`
  );
  if (failed > fetched * 0.1) {
    console.error("More than 10% of requests failed — data may be incomplete.");
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
