/** App reservations keep the server-agreed amount even after master prices change. */
export function reservationPrice(reservation: { service: { price: number }; memberBookingRequest?: { price: number } | null }): number {
  return reservation.memberBookingRequest?.price ?? reservation.service.price;
}
