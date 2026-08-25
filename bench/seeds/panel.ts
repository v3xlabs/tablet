import { cssVariables, type Theme } from "./theme";

export const panelTheme: Theme = {
  name: "panel",
  background: "#f5f7fa",
  accent: "#0b6efd",
  fontFamily: "system-ui",
  fontSize: 13,
};

export type Panel = {
  title: string;
  body: string;
  collapsed: boolean;
};

const styleAttribute = (theme: Theme): string =>
  Object.entries(cssVariables(theme))
    .map(([key, value]) => `${key}: ${value};`)
    .join(" ");

export const renderPanel = (panel: Panel, theme: Theme): string => {
  const state = panel.collapsed ? "collapsed" : "open";
  const heading = `<h2>${panel.title}</h2>`;
  const body = panel.collapsed ? "" : `<p>${panel.body}</p>`;

  return `<section class="panel ${state}" style="${styleAttribute(theme)}">${heading}${body}</section>`;
};
