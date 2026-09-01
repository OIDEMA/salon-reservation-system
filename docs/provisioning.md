# Tenant provisioning

Tenant creation and the first `OWNER` assignment are operator-only operations. The public web application has no sign-up or tenant-creation path, and the public API does not expose a tenant-creation endpoint.

## Provisioning behavior

The `tenant:provision` command performs one transaction that creates:

1. the application user mapped to Firebase Authentication;
2. the tenant;
3. the active `OWNER` membership;
4. the first salon and its settings;
5. the provisioning audit event.

If no Firebase user exists for the selected email, the command creates a verified, passwordless Firebase user. The owner then uses **初回ログイン・パスワード再設定** on the login screen to receive a Firebase password-reset email. If the Firebase user already exists, their email must already be verified; an unverified pre-existing account is never promoted to `OWNER`.

The command is idempotent only when the same tenant slug is already owned by the selected owner and has a salon. Any conflicting or application-reserved slug fails without changing PostgreSQL. The slug becomes the stable URL prefix, for example `/beauty-gum/calendar`, and should not be renamed as ordinary display text.

## Required environment variables

| Variable | Meaning |
| --- | --- |
| `PROVISION_OWNER_EMAIL` | Email address selected by the operator |
| `PROVISION_OWNER_DISPLAY_NAME` | Optional owner display name |
| `PROVISION_TENANT_NAME` | Business or company name |
| `PROVISION_TENANT_SLUG` | Globally unique lowercase tenant identifier |
| `PROVISION_SALON_NAME` | Initial salon name |
| `PROVISION_TIMEZONE` | Optional; defaults to `Asia/Tokyo` |

Run this command only as a one-off Cloud Run job attached to `salon-reserve-vpc` and `salon-reserve-run-asia-east1`, using the private `DATABASE_URL`. The provisioning job service account needs Firebase Authentication administration and Secret Manager access. Do not add this command to the automatic production deployment workflow.

In production, an authorized operator runs the separate **Provision tenant** GitHub Actions workflow manually. The workflow uses `reservation-provisioner@salon-reserve-bg.iam.gserviceaccount.com`, validates the inputs, deploys the private-VPC job, and waits for it to finish. It is never triggered by a push to `main`.
