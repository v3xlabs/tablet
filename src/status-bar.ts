import * as vscode from "vscode";

export type StatusState
  = | { kind: "unconfigured"; detail: string; }
    | { kind: "idle"; name: string; }
    | { kind: "working"; name: string; }
    | { kind: "problem"; name: string; detail: string; };

export const renderStatus = (item: vscode.StatusBarItem, state: StatusState): void => {
  item.command = "tablet.selectConfiguration";

  switch (state.kind) {
    case "unconfigured": {
      item.text = "$(circle-slash) tablet";
      item.tooltip = state.detail;
      item.backgroundColor = undefined;
      break;
    }
    case "idle": {
      item.text = `$(sparkle) ${state.name}`;
      item.tooltip = `tablet is using ${state.name}`;
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

  item.show();
};
