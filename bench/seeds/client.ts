import { fetchOrders, latestOrder, orderTotal, type Page } from "./api";

const baseUrl = "https://shop.example.com/api";
const pageSize = 25;

export type Summary = {
  count: number;
  total: number;
  newestReference: string | undefined;
  hasMore: boolean;
};

export const loadRecentOrders = (customerId: string): Promise<Page> =>
  fetchOrders(baseUrl, customerId, pageSize);

export const summarise = async (customerId: string): Promise<Summary> => {
  const page = await loadRecentOrders(customerId);

  return {
    count: page.orders.length,
    total: orderTotal(page),
    newestReference: latestOrder(page)?.reference,
    hasMore: page.hasMore,
  };
};

export const describeSummary = (summary: Summary): string => {
  const suffix = summary.hasMore ? " (more available)" : "";

  return `${summary.count} order(s) totalling ${summary.total.toFixed(2)}${suffix}`;
};
