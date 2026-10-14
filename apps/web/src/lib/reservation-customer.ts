export type ReservationCustomerInput = {
  customerId?: string;
  name: string;
  kana: string;
  phone: string;
};

export type ReservationCustomer = { id: string; name: string; kana: string; phone: string | null };

export function reservationCustomerPayload(customer: ReservationCustomerInput) {
  return {
    requireCustomerSelection: true,
    customerId: customer.customerId || undefined,
    customerName: customer.name.trim(),
    customerKana: customer.kana.trim() || undefined,
    customerPhone: customer.phone.trim() || undefined
  };
}
