export type Theme = {
  name: string;
  background: string;
  accent: string;
  fontFamily: string;
  fontSize: number;
};

export const darkTheme: Theme = {
  name: "dark",
  background: "#101418",
  accent: "#4fa3ff",
  fontFamily: "Inter",
  fontSize: 14,
};

export const withScale = (theme: Theme, scale: number): Theme => ({
  ...theme,
  fontSize: Math.round(theme.fontSize * scale),
});

export const cssVariables = (theme: Theme): Record<string, string> => ({
  "--background": theme.background,
  "--accent": theme.accent,
  "--font-family": theme.fontFamily,
  "--font-size": `${theme.fontSize}px`,
});
