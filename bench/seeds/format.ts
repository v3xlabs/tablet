export const money = (amount: number, currency: string): string =>
  `${currency} ${amount.toFixed(2)}`;

export const percentage = (ratio: number): string =>
  `${(ratio * 100).toFixed(1)}%`;

export const formatDate = (iso: string): string => {
  const date = new Date(iso);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${date.getUTCFullYear()}-${month}-${day}`;
};

export const truncate = (text: string, width: number): string =>
  (text.length <= width ? text : `${text.slice(0, width - 1)}…`);

export const padColumn = (text: string, width: number): string =>
  (text.length >= width ? text : text + " ".repeat(width - text.length));

export const list = (items: string[]): string => {
  if (items.length <= 1) return items.join("");

  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
};
