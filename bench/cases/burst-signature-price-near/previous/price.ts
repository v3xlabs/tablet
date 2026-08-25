export type Item = {
  name: string;
  price: number;
};

export const formatPrice = (value: number): string =>
  `€${value.toFixed(2)}`;

export const renderRow = (item: Item, locale: string): string =>
  `${item.name.toLocaleUpperCase(locale)}: ${formatPrice(item.price)}`;

export const renderReceipt = (items: Item[], locale: string): string => {
  const rows = items.map(item => renderRow(item, locale));
  const sum = items.reduce((held, item) => held + item.price, 0);

  return [...rows, `total: ${formatPrice(sum)}`].join("\n");
};
