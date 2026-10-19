# Member booking API

The canonical implemented API contract is maintained in [member-reservations.md](member-reservations.md).

It covers Firebase ID Token authentication, published salons, availability, server-paginated personal reservations, required `expectedPrice`/`expectedDurationMinutes` preconditions, idempotent creation, cancellation, limits and validation. The current payment mode is `pay_at_salon`.
