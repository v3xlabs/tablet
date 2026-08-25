export type Item = {
  name: string;
  price: number;
};

export const formatPrice = (value: number, locale: string): string =>
  value.toLocaleString(locale, { style: "currency", currency: "EUR" });

export const renderRow = (item: Item, locale: string): string =>
  `${item.name.toLocaleUpperCase(locale)}: ${formatPrice(item.price, locale)}`;

export const renderReceipt = (items: Item[], locale: string): string => {
  const rows = items.map(item => renderRow(item, locale));
  const sum = items.reduce((held, item) => held + item.price, 0);

  return [...rows, `total: ${formatPrice(sum, locale)}`].join("\n");
};
