export const INVOICE_PREFIX = "INV";

export function createInvoice(total: number) {
  return `${INVOICE_PREFIX}-${total}`;
}
