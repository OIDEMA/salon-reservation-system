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


## Private chart photo storage

Clinical photos use a dedicated Google Cloud Storage bucket, separate from App Hosting sources.

| Setting | Production value |
| --- | --- |
| Bucket | `salon-reserve-bg-chart-photos` |
| Location | `asia-east1` (same region as the API) |
| API environment variable | `CHART_PHOTOS_BUCKET=salon-reserve-bg-chart-photos` |
| Public access prevention | `enforced` |
| Uniform bucket-level access | Enabled |
| Soft delete | 7 days |
| API principal | `reservation-api-runtime@salon-reserve-bg.iam.gserviceaccount.com` |
| Runtime bucket-scoped role | `roles/storage.objectUser` |
| Deployment principal | `github-deploy@salon-reserve-bg.iam.gserviceaccount.com` |
| Required deployment bucket-scoped role | `roles/storage.bucketViewer` (approved and applied) |

The bucket has no public website, client Firebase upload access, download tokens, or signed URLs. Clients upload through the authenticated tenant API. The server validates and re-encodes JPEG/PNG/WebP images, removes EXIF/GPS, and reads them through the same authorization boundary. Never put `CHART_PHOTOS_BUCKET` credentials in a `NEXT_PUBLIC_*` variable. Cloud Run uses Application Default Credentials; no service-account key file is needed.

The bucket was created on 2026-10-13 with public access prevention and uniform access enabled. On the same day, the user explicitly approved and the bucket-scoped `roles/storage.objectUser` binding was applied to the API runtime service account. Public access prevention and uniform access remained enabled after the grant. Deploy the matching API/Web and schema together to enable production photo uploads; bucket provisioning alone does not enable the feature. Existing project-level IAM roles can still grant administrative access; staff access is enforced by the application.

Initial setup (run under an approved infrastructure administrator; do not rerun creation for an existing bucket):

```bash
gcloud storage buckets create gs://salon-reserve-bg-chart-photos \
  --project=salon-reserve-bg --location=asia-east1 \
  --uniform-bucket-level-access --public-access-prevention \
  --soft-delete-duration=7d --default-storage-class=STANDARD

gcloud storage buckets add-iam-policy-binding gs://salon-reserve-bg-chart-photos \
  --project=salon-reserve-bg \
  --member=serviceAccount:reservation-api-runtime@salon-reserve-bg.iam.gserviceaccount.com \
  --role=roles/storage.objectUser
```

The deployment workflow verifies public access prevention and uniform access before applying the schema, then supplies `CHART_PHOTOS_BUCKET` to the API. The deployment principal needs `storage.buckets.get` on this bucket. The first attempt of deployment run `38353085184` stopped at this check before any schema/API changes because its existing project roles did not provide that permission. The minimal predefined `roles/storage.bucketViewer` role contains only `storage.buckets.get` and `storage.buckets.list`; it does not allow reading photos, modifying objects, or editing IAM. On 2026-10-13, the user explicitly approved this binding for the deployment principal on this bucket. It was applied and verified; public access prevention remained enforced and uniform bucket-level access remained enabled. Do not grant public IAM bindings, enable browser CORS, create download tokens, or remove these checks to work around an upload failure.

The approved deployment metadata-read binding was applied with the following command:

```bash
gcloud storage buckets add-iam-policy-binding gs://salon-reserve-bg-chart-photos \
  --project=salon-reserve-bg \
  --member=serviceAccount:github-deploy@salon-reserve-bg.iam.gserviceaccount.com \
  --role=roles/storage.bucketViewer
```

Apply the additive Prisma fields before running the new API. New photos have null legacy `data` and populated `storageBucket`, `storagePath`, and `storageGeneration`. Legacy database bytes remain readable; this release does not automatically copy them to Cloud Storage. Confirm cloud configuration, authenticated upload/read, cross-tenant denial, finalized revision retention, and deletion before enabling the feature in production.

Keep DB backups and object recovery coordinated. Soft delete offers recovery for seven days after physical object deletion; it is not a clinical retention policy or a substitute for long-term backups. No lifecycle expiry is configured. Ambiguous upload/commit outcomes may leave private objects: compare IDs and generations against the DB before manual cleanup, and never delete objects referenced by finalized revisions.

For local development use an isolated development bucket and ADC, or the in-memory storage test implementation. Do not point local preview or tests at the production bucket. Unit and local PostgreSQL integration tests inject storage and need no cloud credentials.

Official references: [Admin Storage](https://firebase.google.com/docs/storage/admin/start), [public access prevention](https://cloud.google.com/storage/docs/public-access-prevention), [uniform bucket access](https://cloud.google.com/storage/docs/uniform-bucket-level-access).

### Read-only object reconciliation

After building the API, an approved operator can inspect aged storage objects against the DB:

```bash
CHART_PHOTOS_BUCKET=YOUR_PRIVATE_BUCKET npm run chart:photos:audit -w @reservation-system/api -- \
  --bucket YOUR_PRIVATE_BUCKET --older-than-hours 48
```

The explicit bucket must match `CHART_PHOTOS_BUCKET`; the age must be at least 24 hours. Use the intended database, bucket, and ADC together (a local DB must not be compared against the production bucket). The tool only reads object metadata and DB references. It never reads image bodies or deletes anything. Recent objects and unrecognized object markers are skipped. A report is a manual-review candidate, not permission to delete; confirm the environment, commit outcome, photo links, and pinned generation before any cleanup. An inventory/DB read failure aborts the command.
