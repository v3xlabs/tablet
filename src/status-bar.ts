import * as vscode from "vscode";

export type StatusState
  = | { kind: "unconfigured"; detail: string; }
    | { kind: "unselected"; detail: string; }
    | { kind: "idle"; name: string; detail: string; }
    | { kind: "working"; name: string; }
    | { kind: "problem"; name: string; detail: string; };

export type StatusMarks = {
  isDevelopment: boolean;
  isPaused: boolean;
  isCollecting: boolean;
  eagerness: "low" | "medium" | "high";
};

export const renderStatus = (item: vscode.StatusBarItem, state: StatusState, marks: StatusMarks): void => {
  item.command = "tablet.menu";

  switch (state.kind) {
    case "unconfigured": {
      item.text = "$(add) tablet";
      item.tooltip = state.detail;
      item.backgroundColor = undefined;
      break;
    }
    case "unselected": {
      item.text = "$(list-selection) tablet";
      item.tooltip = state.detail;
      item.backgroundColor = undefined;
      break;
    }
    case "idle": {
      item.text = `${marks.isPaused ? "$(debug-pause)" : "$(sparkle)"} ${state.name}`;
      item.tooltip = state.detail === ""
        ? `tablet is using ${state.name}`
        : `tablet is using ${state.name}\nlast answer: ${state.detail}`;
      item.backgroundColor = undefined;
      break;
    }
    case "working": {
      item.text = `$(loading~spin) ${state.name}`;
      item.tooltip = `tablet is asking ${state.name}`;
      item.backgroundColor = undefined;
      break;
    }
    case "problem": {
      item.text = `$(warning) ${state.name}`;
      item.tooltip = state.detail;
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      break;
    }
  }

  // collection is never on by surprise: while it runs, the glyph is in the bar
  if (marks.isCollecting) {
    item.text += " $(database)";
    item.tooltip = `${item.tooltip ?? ""}\ncollecting records locally`;
  }

  item.tooltip = marks.isPaused ? `${item.tooltip ?? ""}\nautomatic suggestions are paused` : `${item.tooltip ?? ""}\neagerness ${marks.eagerness}`;

  // the dev host and the installed copy render the same name, so the build the reader
  // is looking at is only ever told apart here
  if (marks.isDevelopment) {
    item.text += " (dev)";
    item.tooltip = `development build\n${item.tooltip ?? ""}`;
  }

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
