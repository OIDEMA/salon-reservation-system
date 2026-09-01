# Production infrastructure

## Database networking

The production Cloud SQL instance `salon-reserve-db` must not have a public IP address.

- Cloud SQL uses Private Service Access on `salon-reserve-vpc`.
- Cloud Run services and jobs use Direct VPC egress through `salon-reserve-run-asia-east1`.
- Only private address ranges are routed through the VPC.
- `DATABASE_URL` points directly to the Cloud SQL private IP over TCP and requires TLS.
- Cloud SQL socket mounts are deliberately cleared from the Cloud Run service and migration job.

The production workflow checks that `ipv4Enabled` is `false` and that the expected private network is attached before applying the database schema. A deployment fails closed if public IP is re-enabled or the private network is detached.

Direct VPC connectivity can take time to become available when a new Cloud Run instance or job task starts. Schema deployment retries transient connection failures, and the API startup probe calls `/ready` until PostgreSQL is reachable before the revision accepts traffic.

## Network resources

| Resource | Name | Range/region |
| --- | --- | --- |
| VPC | `salon-reserve-vpc` | custom mode |
| Cloud Run subnet | `salon-reserve-run-asia-east1` | `10.80.0.0/24`, `asia-east1` |
| Private Service Access range | `google-managed-services-salon-reserve` | `10.90.0.0/24` |

Do not add an authorized network or enable `ipv4Enabled` on Cloud SQL. Administrative database operations must run through the VPC-connected Cloud Run migration job.
