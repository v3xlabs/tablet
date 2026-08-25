export type Settings = {
  readonly theme: string;
  readonly locale: string;
  readonly fontSize: number;
  readonly tabWidth: number;
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  locale: "en-US",
  fontSize: 14,
  tabWidth: 2,
};

export const withTheme = (settings: Settings, theme: string): Settings => ({
  ...settings,
  theme,
});
