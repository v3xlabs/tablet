export type Item = {
  name: string;
  price: number;
  quantity: number;
};

export type Cart = {
  items: Item[];
  discount: number;
};

export const grandTotal = (items: Item[]): number => {
  let sum = 0;

  for (const item of items) {
    sum += item.price * item.quantity;
  }

  return sum;
};

export const discounted = (cart: Cart): number => {
  const base = grandTotal(cart.items);

  return base - base * cart.discount;
};

export const isFreeShipping = (cart: Cart): boolean => {
  return total(cart.items) >= 50;
};

export const heaviest = (cart: Cart): Item | undefined => {
  let best: Item | undefined;

  for (const item of cart.items) {
    if (best === undefined || item.quantity > best.quantity) best = item;
  }

  return best;
};

export const summary = (cart: Cart): string => {
  const count = cart.items.length;

  return `${count} item(s) for ${total(cart.items).toFixed(2)}`;
};
