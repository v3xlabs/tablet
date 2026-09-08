import { blocksFromChange, emptyEditLog, recordEdit } from "../src/context/recent-edits";
import { endOf, lineMatching } from "./faults";

export type AuthoredCase = {
  caseId: string;
  category: string;
  variant: "near" | "far" | "away";
  language: string;
  targetPath: string;
  cursor: { line: number; character: number; };
  files: Record<string, string[]>;
  expected: Record<string, string[]>;
  candidatePaths: string[];
  recentEdits: { path: string; line: number; before: string; after: string; }[];
  diagnostics: { line: number; character: number; severity: string; source: string | undefined; message: string; }[];
  allowFormat: boolean;
  previousFiles: Record<string, string[]>;
};

const swap = (lines: string[], from: string, to: string): string[] => {
  const line = lineMatching(lines, from);

  return lines.map((held, index) => (index === line ? held.replace(from, () => to) : held));
};

const columnOf = (lines: string[], line: number, needle: string): number => Math.max(0, (lines[line] ?? "").indexOf(needle));

const errorAt = (lines: string[], anchor: string, needle: string, source: string, message: string): AuthoredCase["diagnostics"][number] => {
  const line = lineMatching(lines, anchor);

  return { line, character: columnOf(lines, line, needle), severity: "error", source, message };
};

/**
 * The burst is a list of full-file snapshots, one per edit step, replayed through the same
 * functions the extension uses live, so the log carries whatever coalescing they produce.
 */
const replay = (path: string, snapshots: string[][]): AuthoredCase["recentEdits"] => {
  let log = emptyEditLog(8);

  for (let index = 1; index < snapshots.length; index++) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];

    if (previous === undefined || current === undefined) continue;

    const blocks = blocksFromChange(previous, current, 2);

    if (blocks !== undefined) log = recordEdit(log, { path, line: blocks.line, before: blocks.before, after: blocks.after });
  }

  return log.edits;
};

// burst-rename: `total` renamed at its definition (typed in two keystroke steps) and at the
// first of its three call sites; the other two call sites are still stale
const cartStart = [
  "export type Item = {",
  "  name: string;",
  "  price: number;",
  "  quantity: number;",
  "};",
  "",
  "export type Cart = {",
  "  items: Item[];",
  "  discount: number;",
  "};",
  "",
  "export const total = (items: Item[]): number => {",
  "  let sum = 0;",
  "",
  "  for (const item of items) {",
  "    sum += item.price * item.quantity;",
  "  }",
  "",
  "  return sum;",
  "};",
  "",
  "export const discounted = (cart: Cart): number => {",
  "  const base = total(cart.items);",
  "",
  "  return base - base * cart.discount;",
  "};",
  "",
  "export const isFreeShipping = (cart: Cart): boolean => {",
  "  return total(cart.items) >= 50;",
  "};",
  "",
  "export const heaviest = (cart: Cart): Item | undefined => {",
  "  let best: Item | undefined;",
  "",
  "  for (const item of cart.items) {",
  "    if (best === undefined || item.quantity > best.quantity) best = item;",
  "  }",
  "",
  "  return best;",
  "};",
  "",
  "export const summary = (cart: Cart): string => {",
  "  const count = cart.items.length;",
  "",
  "  return `${count} item(s) for ${total(cart.items).toFixed(2)}`;",
  "};",
];

const cartTyped = swap(cartStart, "export const total = (", "export const grand = (");
const cartRenamed = swap(cartTyped, "export const grand = (", "export const grandTotal = (");
const cartCurrent = swap(cartRenamed, "const base = total(", "const base = grandTotal(");
const cartExpected = swap(
  swap(cartCurrent, "return total(cart.items) >= 50;", "return grandTotal(cart.items) >= 50;"),
  "${total(cart.items)",
  "${grandTotal(cart.items)",
);
const cartEdits = replay("src/cart.ts", [cartStart, cartTyped, cartRenamed, cartCurrent]);
const cartDiagnostics = [
  errorAt(cartCurrent, "return total(cart.items) >= 50;", "total(", "ts", "Cannot find name 'total'. Did you mean 'grandTotal'?"),
  errorAt(cartCurrent, "${total(cart.items)", "total(", "ts", "Cannot find name 'total'. Did you mean 'grandTotal'?"),
];
const cartAnchor = lineMatching(cartCurrent, "const base = grandTotal(");

const cartVariants = [
  { variant: "near", cursor: endOf(cartCurrent, cartAnchor) },
  { variant: "far", cursor: endOf(cartCurrent, cartAnchor - 8) },
] as const;

// burst-rename-cross: `colorFor` fully renamed in theme.ts, badge.ts still imports the old name
const themeStart = [
  "export type Tone = \"info\" | \"warn\" | \"error\";",
  "",
  "const COLORS: Record<Tone, string> = {",
  "  info: \"#2563eb\",",
  "  warn: \"#d97706\",",
  "  error: \"#dc2626\",",
  "};",
  "",
  "export const colorFor = (tone: Tone): string => COLORS[tone];",
  "",
  "export const contrastText = (hex: string): string => {",
  "  const channel = Number.parseInt(hex.slice(1, 3), 16);",
  "",
  "  return channel > 127 ? \"#111827\" : \"#f9fafb\";",
  "};",
];

const themeTyped = swap(themeStart, "export const colorFor = (", "export const toneC = (");
const themeRenamed = swap(themeTyped, "export const toneC = (", "export const toneColor = (");
const themeEdits = replay("src/theme.ts", [themeStart, themeTyped, themeRenamed]);

const badgeStale = [
  "import { colorFor, contrastText, type Tone } from \"./theme\";",
  "",
  "export type Badge = {",
  "  label: string;",
  "  tone: Tone;",
  "};",
  "",
  "export const badgeStyle = (badge: Badge): Record<string, string> => {",
  "  const background = colorFor(badge.tone);",
  "",
  "  return {",
  "    background,",
  "    color: contrastText(background),",
  "  };",
  "};",
];

const badgeExpected = swap(
  swap(badgeStale, "import { colorFor,", "import { toneColor,"),
  "const background = colorFor(",
  "const background = toneColor(",
);

// burst-rename-cross in rust: `to_ms` renamed in units.rs, timer.rs still imports and calls it
const unitsStart = [
  "pub const MILLIS_PER_SEC: u64 = 1_000;",
  "",
  "pub fn to_ms(seconds: u64) -> u64 {",
  "    seconds * MILLIS_PER_SEC",
  "}",
  "",
  "pub fn to_seconds(millis: u64) -> u64 {",
  "    millis / MILLIS_PER_SEC",
  "}",
];

const unitsTyped = swap(unitsStart, "pub fn to_ms(", "pub fn to_mil(");
const unitsRenamed = swap(unitsTyped, "pub fn to_mil(", "pub fn to_millis(");
const unitsEdits = replay("src/units.rs", [unitsStart, unitsTyped, unitsRenamed]);

const timerStale = [
  "use crate::units::to_ms;",
  "",
  "pub struct Timer {",
  "    pub started_ms: u64,",
  "}",
  "",
  "impl Timer {",
  "    pub fn from_seconds(seconds: u64) -> Timer {",
  "        Timer { started_ms: to_ms(seconds) }",
  "    }",
  "",
  "    pub fn elapsed(&self, now_ms: u64) -> u64 {",
  "        now_ms - self.started_ms",
  "    }",
  "}",
];

const timerExpected = swap(
  swap(timerStale, "use crate::units::to_ms;", "use crate::units::to_millis;"),
  "to_ms(seconds)",
  "to_millis(seconds)",
);

// burst-signature: formatPrice gained a locale parameter (typed in two keystroke steps, then
// the body rewritten to use it); both call sites sit in functions that already hold a locale
const priceStart = [
  "export type Item = {",
  "  name: string;",
  "  price: number;",
  "};",
  "",
  "export const formatPrice = (value: number): string =>",
  "  `€${value.toFixed(2)}`;",
  "",
  "export const renderRow = (item: Item, locale: string): string =>",
  "  `${item.name.toLocaleUpperCase(locale)}: ${formatPrice(item.price)}`;",
  "",
  "export const renderReceipt = (items: Item[], locale: string): string => {",
  "  const rows = items.map(item => renderRow(item, locale));",
  "  const sum = items.reduce((held, item) => held + item.price, 0);",
  "",
  "  return [...rows, `total: ${formatPrice(sum)}`].join(\"\\n\");",
  "};",
];

const priceTyped = swap(priceStart, "(value: number): string =>", "(value: number, loc): string =>");
const priceSigned = swap(priceTyped, "(value: number, loc): string =>", "(value: number, locale: string): string =>");
const priceCurrent = swap(priceSigned, "`€${value.toFixed(2)}`;", "value.toLocaleString(locale, { style: \"currency\", currency: \"EUR\" });");
const priceExpected = swap(
  swap(priceCurrent, "formatPrice(item.price)", "formatPrice(item.price, locale)"),
  "formatPrice(sum)",
  "formatPrice(sum, locale)",
);
const priceEdits = replay("src/price.ts", [priceStart, priceTyped, priceSigned, priceCurrent]);
const priceDiagnostics = [
  errorAt(priceCurrent, "formatPrice(item.price)", "formatPrice(", "ts", "Expected 2 arguments, but got 1."),
  errorAt(priceCurrent, "formatPrice(sum)", "formatPrice(", "ts", "Expected 2 arguments, but got 1."),
];
const priceAnchor = lineMatching(priceCurrent, "value.toLocaleString(");

const priceVariants = [
  { variant: "near", cursor: endOf(priceCurrent, priceAnchor) },
  { variant: "far", cursor: endOf(priceCurrent, priceAnchor + 8) },
] as const;

// burst-signature in rust: fetch gained a retries parameter and the body now reads it; the
// call sites should forward RETRY_LIMIT, the constant the body used before the burst
const fetchStart = [
  "pub const RETRY_LIMIT: u32 = 3;",
  "",
  "pub struct Response {",
  "    pub status: u16,",
  "    pub body: String,",
  "}",
  "",
  "pub fn fetch(url: &str) -> Response {",
  "    let mut attempt = 0;",
  "",
  "    loop {",
  "        attempt += 1;",
  "",
  "        let response = send(url);",
  "",
  "        if response.status < 500 || attempt > RETRY_LIMIT {",
  "            return response;",
  "        }",
  "    }",
  "}",
  "",
  "fn send(url: &str) -> Response {",
  "    Response {",
  "        status: 200,",
  "        body: format!(\"ok: {url}\"),",
  "    }",
  "}",
  "",
  "pub fn fetch_all(urls: &[&str]) -> Vec<Response> {",
  "    urls.iter().map(|url| fetch(url)).collect()",
  "}",
  "",
  "pub fn healthy(url: &str) -> bool {",
  "    fetch(url).status < 400",
  "}",
];

const fetchTyped = swap(fetchStart, "pub fn fetch(url: &str) -> Response {", "pub fn fetch(url: &str, ret) -> Response {");
const fetchSigned = swap(fetchTyped, ", ret) -> Response {", ", retries: u32) -> Response {");
const fetchCurrent = swap(fetchSigned, "attempt > RETRY_LIMIT {", "attempt > retries {");
const fetchExpected = swap(
  swap(fetchCurrent, "fetch(url)).collect()", "fetch(url, RETRY_LIMIT)).collect()"),
  "fetch(url).status < 400",
  "fetch(url, RETRY_LIMIT).status < 400",
);
const fetchEdits = replay("src/fetch.rs", [fetchStart, fetchTyped, fetchSigned, fetchCurrent]);
const fetchDiagnostics = [
  errorAt(fetchCurrent, "fetch(url)).collect()", "fetch(url)", "rustc", "this function takes 2 arguments but 1 argument was supplied"),
  errorAt(fetchCurrent, "fetch(url).status < 400", "fetch(url)", "rustc", "this function takes 2 arguments but 1 argument was supplied"),
];

// burst-halfway in rust: two of four counter fields widened to i64, two still i32
const totalsStart = [
  "pub struct Totals {",
  "    pub views: i32,",
  "    pub clicks: i32,",
  "    pub likes: i32,",
  "    pub shares: i32,",
  "}",
  "",
  "impl Totals {",
  "    pub fn zero() -> Totals {",
  "        Totals { views: 0, clicks: 0, likes: 0, shares: 0 }",
  "    }",
  "",
  "    pub fn merge(&mut self, other: &Totals) {",
  "        self.views += other.views;",
  "        self.clicks += other.clicks;",
  "        self.likes += other.likes;",
  "        self.shares += other.shares;",
  "    }",
  "}",
];

const totalsViews = swap(totalsStart, "pub views: i32,", "pub views: i64,");
const totalsCurrent = swap(totalsViews, "pub clicks: i32,", "pub clicks: i64,");
const totalsExpected = swap(
  swap(totalsCurrent, "pub likes: i32,", "pub likes: i64,"),
  "pub shares: i32,",
  "pub shares: i64,",
);
const totalsEdits = replay("src/stats.rs", [totalsStart, totalsViews, totalsCurrent]);
const totalsAnchor = lineMatching(totalsCurrent, "pub clicks: i64,");

const totalsVariants = [
  { variant: "near", cursor: endOf(totalsCurrent, totalsAnchor) },
  { variant: "far", cursor: endOf(totalsCurrent, totalsAnchor + 8) },
] as const;

// burst-halfway in typescript: two of four settings fields marked readonly, the first typed
// in two keystroke steps, two fields still mutable
const settingsStart = [
  "export type Settings = {",
  "  theme: string;",
  "  locale: string;",
  "  fontSize: number;",
  "  tabWidth: number;",
  "};",
  "",
  "export const DEFAULT_SETTINGS: Settings = {",
  "  theme: \"dark\",",
  "  locale: \"en-US\",",
  "  fontSize: 14,",
  "  tabWidth: 2,",
  "};",
  "",
  "export const withTheme = (settings: Settings, theme: string): Settings => ({",
  "  ...settings,",
  "  theme,",
  "});",
];

const settingsTyped = swap(settingsStart, "  theme: string;", "  readtheme: string;");
const settingsWord = swap(settingsTyped, "readtheme: string;", "readonly theme: string;");
const settingsCurrent = swap(settingsWord, "  locale: string;", "  readonly locale: string;");
const settingsExpected = swap(
  swap(settingsCurrent, "  fontSize: number;", "  readonly fontSize: number;"),
  "  tabWidth: number;",
  "  readonly tabWidth: number;",
);
const settingsEdits = replay("src/settings.ts", [settingsStart, settingsTyped, settingsWord, settingsCurrent]);

export const burstCases: AuthoredCase[] = [
  ...cartVariants.map(({ variant, cursor }): AuthoredCase => ({
    caseId: `burst-rename-cart-${variant}`,
    category: "burst-rename",
    variant,
    language: "typescript",
    targetPath: "src/cart.ts",
    cursor,
    files: { "src/cart.ts": cartCurrent },
    expected: { "src/cart.ts": cartExpected },
    candidatePaths: [],
    recentEdits: cartEdits,
    diagnostics: cartDiagnostics,
    allowFormat: false,
    previousFiles: { "src/cart.ts": cartStart },
  })),
  {
    caseId: "burst-rename-cross-badge-away",
    category: "burst-rename-cross",
    variant: "away",
    language: "typescript",
    targetPath: "src/badge.ts",
    cursor: endOf(badgeStale, lineMatching(badgeStale, "tone: Tone;")),
    files: { "src/badge.ts": badgeStale, "src/theme.ts": themeRenamed },
    expected: { "src/badge.ts": badgeExpected },
    candidatePaths: ["src/theme.ts"],
    recentEdits: themeEdits,
    diagnostics: [
      errorAt(badgeStale, "import { colorFor,", "colorFor", "ts", "Module '\"./theme\"' has no exported member 'colorFor'."),
    ],
    allowFormat: false,
    previousFiles: { "src/theme.ts": themeStart },
  },
  {
    caseId: "burst-rename-cross-timer-away",
    category: "burst-rename-cross",
    variant: "away",
    language: "rust",
    targetPath: "src/timer.rs",
    cursor: endOf(timerStale, lineMatching(timerStale, "pub started_ms: u64,")),
    files: { "src/timer.rs": timerStale, "src/units.rs": unitsRenamed },
    expected: { "src/timer.rs": timerExpected },
    candidatePaths: ["src/units.rs"],
    recentEdits: unitsEdits,
    diagnostics: [
      errorAt(timerStale, "use crate::units::to_ms;", "crate::units::to_ms", "rustc", "unresolved import `crate::units::to_ms`: no `to_ms` in `units`"),
      errorAt(timerStale, "to_ms(seconds)", "to_ms(", "rustc", "cannot find function `to_ms` in this scope"),
    ],
    allowFormat: false,
    previousFiles: { "src/units.rs": unitsStart },
  },
  ...priceVariants.map(({ variant, cursor }): AuthoredCase => ({
    caseId: `burst-signature-price-${variant}`,
    category: "burst-signature",
    variant,
    language: "typescript",
    targetPath: "src/price.ts",
    cursor,
    files: { "src/price.ts": priceCurrent },
    expected: { "src/price.ts": priceExpected },
    candidatePaths: [],
    recentEdits: priceEdits,
    diagnostics: priceDiagnostics,
    allowFormat: false,
    previousFiles: { "src/price.ts": priceStart },
  })),
  {
    caseId: "burst-signature-fetch-near",
    category: "burst-signature",
    variant: "near",
    language: "rust",
    targetPath: "src/fetch.rs",
    cursor: endOf(fetchCurrent, lineMatching(fetchCurrent, "attempt > retries {")),
    files: { "src/fetch.rs": fetchCurrent },
    expected: { "src/fetch.rs": fetchExpected },
    candidatePaths: [],
    recentEdits: fetchEdits,
    diagnostics: fetchDiagnostics,
    allowFormat: false,
    previousFiles: { "src/fetch.rs": fetchStart },
  },
  ...totalsVariants.map(({ variant, cursor }): AuthoredCase => ({
    caseId: `burst-halfway-totals-${variant}`,
    category: "burst-halfway",
    variant,
    language: "rust",
    targetPath: "src/stats.rs",
    cursor,
    files: { "src/stats.rs": totalsCurrent },
    expected: { "src/stats.rs": totalsExpected },
    candidatePaths: [],
    recentEdits: totalsEdits,
    diagnostics: [],
    allowFormat: false,
    previousFiles: { "src/stats.rs": totalsStart },
  })),
  {
    caseId: "burst-halfway-settings-near",
    category: "burst-halfway",
    variant: "near",
    language: "typescript",
    targetPath: "src/settings.ts",
    cursor: endOf(settingsCurrent, lineMatching(settingsCurrent, "readonly locale: string;")),
    files: { "src/settings.ts": settingsCurrent },
    expected: { "src/settings.ts": settingsExpected },
    candidatePaths: [],
    recentEdits: settingsEdits,
    diagnostics: [],
    allowFormat: false,
    previousFiles: { "src/settings.ts": settingsStart },
  },
];
