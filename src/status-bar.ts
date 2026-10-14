import * as vscode from "vscode";

import { type Palette, usageSvg } from "./chart";
import { type Eagerness, EAGERNESS_SETTINGS, type EagernessSetting } from "./eagerness";
import type { UsagePoint } from "./timing";

export type StatusState
  = | { kind: "unconfigured"; detail: string; }
    | { kind: "unselected"; detail: string; }
    | { kind: "idle"; name: string; detail: string; }
    | { kind: "working"; name: string; }
    | { kind: "problem"; name: string; detail: string; };

export type StatusMarks = {
  isDevelopment: boolean;
  isPaused: boolean;
  snoozedUntil: Date | undefined;
  isCollecting: boolean;
  eagerness: Eagerness;
};

/** Everything the status bar item and its hover show, read in one place. */
export type StatusView = {
  state: StatusState;
  marks: StatusMarks;
  eagernessSetting: EagernessSetting;
  usage: UsagePoint[];
  latency: { p50: number | undefined; p95: number | undefined; };
  counts: { shown: number; accepted: number; carried: number; quickfix: number; };
  recordCount: number | undefined;
};

type Summary = { title: string; headline: string; detail: string; };

const summarize = (view: StatusView): Summary => {
  const { state, marks } = view;

  switch (state.kind) {
    case "unconfigured": {
      return { title: "tablet", headline: "No configuration yet", detail: state.detail };
    }
    case "unselected": {
      return { title: "tablet", headline: "No configuration selected", detail: state.detail };
    }
    case "working": {
      return { title: state.name, headline: "Asking the model", detail: "" };
    }
    case "problem": {
      return { title: state.name, headline: "Needs attention", detail: state.detail };
    }
    case "idle": {
      const detail = state.detail === "" ? "" : `Last answer: ${state.detail}`;

      if (marks.isPaused) return { title: state.name, headline: "Paused", detail };

      if (marks.snoozedUntil !== undefined) {
        return { title: state.name, headline: `Snoozed until ${marks.snoozedUntil.toLocaleTimeString([], { timeStyle: "short" })}`, detail };
      }

      return { title: state.name, headline: "Ready", detail };
    }
  }
};

const iconOf = (view: StatusView): string => {
  switch (view.state.kind) {
    case "unconfigured": {
      return "$(add)";
    }
    case "unselected": {
      return "$(list-selection)";
    }
    case "working": {
      return "$(loading~spin)";
    }
    case "problem": {
      return "$(warning)";
    }
    case "idle": {
      if (view.marks.isPaused) return "$(debug-pause)";

      return view.marks.snoozedUntil === undefined ? "$(sparkle)" : "$(bell-slash)";
    }
  }
};

const HOVER_FRAME = { width: 264, height: 52 };

/** A chart over fewer busy minutes than this is a few dots, which says less than the numbers. */
const MIN_CHART_MINUTES = 3;

/** Every command a hover link may run; the hover renders no link outside this list. */
const HOVER_COMMANDS = [
  "tablet.toggleEnabled",
  "tablet.snooze",
  "tablet.toggleCollect",
  "tablet.selectConfiguration",
  "tablet.addConfiguration",
  "tablet.setEagerness",
];

const EAGERNESS_LABELS: Record<EagernessSetting, string> = { auto: "Auto", low: "Low", medium: "Medium", high: "High" };

const SEPARATOR = " &middot; ";

/** The hover chart is an image, so its colors follow the theme kind rather than the theme. */
const hoverPalette = (): Palette => {
  const kind = vscode.window.activeColorTheme.kind;

  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? { ink: "#3b3b3b", accent: "#005fb8" }
    : { ink: "#cccccc", accent: "#4daafc" };
};

/** Endpoint messages come from outside, so they never become markup or icons. */
const escapeMarkdown = (text: string): string => text.replaceAll(/[\\`*_{}[\]()<>#+\-.!|~$&]/g, String.raw`\$&`);

/** Markdown is not read inside an HTML block, so text there is escaped as HTML, and `$` so it cannot become an icon. */
const escapeHtml = (text: string): string => text
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll("\"", "&quot;")
  .replaceAll("$", "&#36;");

const link = (label: string, uri: string, title: string): string => `[${label}](${uri} "${title}")`;

const anchor = (command: string, title: string, content: string): string =>
  `<a href="command:${command}" title="${escapeHtml(title)}">${content}</a>`;

const tinted = (color: string, content: string): string => `<span style="color:var(--vscode-${color});">${content}</span>`;

const recordsOf = (count: number): string => `${count.toLocaleString()} ${count === 1 ? "record" : "records"}`;

/** Icon-only switches; each icon shows what a click does, and its title says the state. */
const actionsOf = (view: StatusView): string => {
  const { marks, recordCount } = view;
  const records = recordCount === undefined ? "" : `, ${recordsOf(recordCount)}`;

  return [
    marks.isPaused
      ? anchor("tablet.toggleEnabled", "Automatic suggestions are off. Click to turn them on", "$(play)")
      : anchor("tablet.toggleEnabled", "Pause automatic suggestions", "$(debug-pause)"),
    marks.snoozedUntil === undefined
      ? anchor("tablet.snooze", "Snooze for a minute", "$(bell-slash)")
      : anchor("tablet.snooze", `Snoozed until ${marks.snoozedUntil.toLocaleTimeString()}. Click to resume`, "$(bell)"),
    marks.isCollecting
      ? anchor("tablet.toggleCollect", `Collecting${records}. Click to turn off`, "$(database)")
      : anchor("tablet.toggleCollect", `Collection off${records}. Click to turn on`, tinted("disabledForeground", "$(database)")),
  ].join("&nbsp;&nbsp;");
};

/** One table row, so the switches can sit at the right edge, which plain markdown cannot place. */
const headerOf = (view: StatusView, summary: Summary, isSetup: boolean): string => {
  const title = tinted("editorHoverWidget-foreground", `<strong>${escapeHtml(summary.title)}</strong>`);
  const name = isSetup
    ? title
    : anchor("tablet.selectConfiguration", "Switch configuration", `${title}${tinted("descriptionForeground", "$(chevron-down)")}`);
  const headline = view.marks.isDevelopment ? `${summary.headline}, development build` : summary.headline;
  const left = `${name}&nbsp;&nbsp;${tinted("descriptionForeground", escapeHtml(headline))}`;

  return `<table width="100%"><tr><td>${left}</td><td align="right">${isSetup ? "" : actionsOf(view)}</td></tr></table>`;
};

const usageOf = (view: StatusView): string => {
  const { latency, counts } = view;

  if (latency.p50 === undefined || latency.p95 === undefined) return tinted("descriptionForeground", "No suggestions yet this session");

  const busyMinutes = view.usage.filter(point => point.served > 0).length;
  const chart = busyMinutes >= MIN_CHART_MINUTES
    ? `![Suggestions per minute and the median wait over the last ${view.usage.length} minutes](data:image/svg+xml;base64,${Buffer.from(usageSvg(view.usage, HOVER_FRAME, hoverPalette())).toString("base64")})\n\n`
    : "";
  const stats = [
    `<span title="Median wait; p95 ${latency.p95} ms">**${latency.p50}** ${tinted("descriptionForeground", "ms")}</span>`,
    `**${counts.shown}** ${tinted("descriptionForeground", "shown")}`,
    `**${counts.accepted}** ${tinted("descriptionForeground", "accepted")}`,
    `**${counts.carried}** ${tinted("descriptionForeground", "carried")}`,
    `**${counts.quickfix}** ${tinted("descriptionForeground", "fixes")}`,
  ].join(SEPARATOR);

  return `${chart}${stats}`;
};

const eagernessOf = (view: StatusView): string => {
  const explanation = `Auto follows how the last twenty suggestions went; ${view.marks.eagerness} right now`;
  const choices = EAGERNESS_SETTINGS.map((setting) => {
    const label = setting === "auto" && view.eagernessSetting === "auto" ? `Auto (${view.marks.eagerness})` : EAGERNESS_LABELS[setting];
    const title = setting === "auto" ? explanation : `Set eagerness to ${setting}`;

    return setting === view.eagernessSetting
      ? `<span title="${title}">**${label}**</span>`
      : link(label, `command:tablet.setEagerness?${encodeURIComponent(JSON.stringify([setting]))}`, title);
  });

  return `${tinted("descriptionForeground", "Eagerness")}&nbsp;&nbsp;${choices.join(SEPARATOR)}`;
};

const detailOf = (view: StatusView, summary: Summary): string => {
  const text = escapeMarkdown(summary.detail).replaceAll("\n", "<br>");

  return tinted(view.state.kind === "problem" ? "editorWarning-foreground" : "descriptionForeground", text);
};

const statusHover = (view: StatusView): vscode.MarkdownString => {
  const summary = summarize(view);
  const isSetup = view.state.kind === "unconfigured" || view.state.kind === "unselected";
  const blocks = [headerOf(view, summary, isSetup)];

  if (isSetup && summary.detail !== "") blocks.push(detailOf(view, summary));

  if (view.state.kind === "unconfigured") blocks.push(link("Add a configuration", "command:tablet.addConfiguration", "Add a configuration"));
  else if (view.state.kind === "unselected") blocks.push(link("Pick a configuration", "command:tablet.selectConfiguration", "Pick a configuration"));
  else blocks.push(usageOf(view), eagernessOf(view));

  if (!isSetup && summary.detail !== "") blocks.push(detailOf(view, summary));

  const hover = new vscode.MarkdownString(blocks.join("\n\n"), true);

  hover.isTrusted = { enabledCommands: HOVER_COMMANDS };
  hover.supportHtml = true;

  return hover;
};

export const renderStatus = (item: vscode.StatusBarItem, view: StatusView): void => {
  const name = view.state.kind === "unconfigured" || view.state.kind === "unselected" ? "tablet" : view.state.name;

  item.command = "tablet.menu";
  item.text = `${iconOf(view)} ${name}`;
  item.tooltip = statusHover(view);
  item.backgroundColor = view.state.kind === "problem" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;

  // collection is never on by surprise: while it runs, the glyph is in the bar
  if (view.marks.isCollecting) item.text += " $(database)";

  // the dev host and the installed copy render the same name, so the build the reader
  // is looking at is only ever told apart here
  if (view.marks.isDevelopment) item.text += " (dev)";

  item.show();
};

/** The two idle shapes differ by whether anything is defined at all, which decides what a click does. */
export const idleStatus = (names: string[], problems: string[]): StatusState => {
  if (names.length > 0) {
    return {
      kind: "unselected",
      detail: `tablet has ${names.join(", ")} but none is selected. Click to pick one.`,
    };
  }

  return {
    kind: "unconfigured",
    detail: problems.length > 0 ? problems.join("\n") : "tablet has no configuration yet. Click to add one.",
  };
};
