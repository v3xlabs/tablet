import { addDays, daysBetween, isOverdue } from "./dates";
import { formatDate } from "./format";

export type Invoice = {
  reference: string;
  issuedAt: string;
  amount: number;
  currency: string;
};

const PAYMENT_TERM_DAYS = 30;

export const dueDate = (invoice: Invoice): string =>
  addDays(invoice.issuedAt, PAYMENT_TERM_DAYS);

export const statusOf = (invoice: Invoice, nowIso: string): string => {
  const due = dueDate(invoice);

  if (!isOverdue(due, nowIso)) return "open";

  return `overdue by ${daysBetween(due, nowIso)} day(s)`;
};

export const describeInvoice = (invoice: Invoice, nowIso: string): string => {
  const amount = `${invoice.currency} ${invoice.amount.toFixed(2)}`;
  const issued = formatDate(invoice.issuedAt);

  return `${invoice.reference}: ${amount}, issued ${issued}, ${statusOf(invoice, nowIso)}`;
};
