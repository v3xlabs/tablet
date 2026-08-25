export type Order = {
  reference: string;
  total: number;
  placedAt: string;
};

export type Page = {
  orders: Order[];
  hasMore: boolean;
};

const parseOrder = (raw: Record<string, unknown>): Order => ({
  reference: String(raw.reference ?? ""),
  total: Number(raw.total ?? 0),
  placedAt: String(raw.placedAt ?? ""),
});

export const fetchOrders = async (apiRoot: string, customerId: string, pageSize: number): Promise<Page> => {
  const response = await fetch(`${apiRoot}/customers/${customerId}/orders?limit=${pageSize}`);
  const body = await response.json() as { orders: Record<string, unknown>[]; hasMore: boolean; };

  return {
    orders: body.orders.map(parseOrder),
    hasMore: body.hasMore,
  };
};

export const orderTotal = (page: Page): number =>
  page.orders.reduce((sum, order) => sum + order.total, 0);

export const latestOrder = (page: Page): Order | undefined =>
  page.orders.reduce<Order | undefined>(
    (held, order) => (held === undefined || order.placedAt > held.placedAt ? order : held),
    undefined,
  );
