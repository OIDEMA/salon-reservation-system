# Production custom domain

The selected public hostname is `salon-reserve.beauty-gum.jp`. It maps directly to Cloud Run service `salon-reserve-web` in `asia-northeast1` in project `salon-reserve-bg`. A dedicated load balancer and reserved public IP are not part of this configuration. The Tokyo `run.app` endpoint remains available as a fallback.

## DNS and certificate setup

1. Verify ownership of `salon-reserve.beauty-gum.jp` with the same Google account used to create the mapping. Search Console supports CNAME verification; retain its separate verification record so ownership remains valid. Verifying this subdomain does not require verifying ownership of the parent domain.
2. Create the mapping only for the approved service and hostname:

   ```sh
   gcloud beta run domain-mappings create \
     --service=salon-reserve-web \
     --domain=salon-reserve.beauty-gum.jp \
     --region=asia-northeast1 \
     --project=salon-reserve-bg
   ```

3. Read the mapping's `status.resourceRecords` and configure those records at Xserver. For subdomains the serving record is a CNAME to `ghs.googlehosted.com`. Remove conflicting A/AAAA records for this exact hostname only. The Google ownership-verification CNAME has a different name and must also remain.
4. Require the mapping to be ready, its Google-managed certificate to be provisioned, and HTTPS login/assets to succeed before changing the legacy redirect. Do not bypass certificate validation or redirect users to an unready hostname.

Google documents the direct mapping feature as Preview with possible latency limitations. The user explicitly selected direct Cloud Run mapping without a load balancer. See [Google's domain mapping documentation](https://docs.cloud.google.com/run/docs/mapping-custom-domains) and [CNAME ownership verification](https://support.google.com/webmasters/answer/9008080).

## Application and release settings

- `scripts/web-runtime-env.json`: canonical `APP_PUBLIC_ORIGIN` is the custom domain. `APP_PUBLIC_ORIGINS` also allows the existing Tokyo origin for legitimate fallback sessions.
- Firebase Authentication: add the custom hostname while retaining earlier authorized domains. The Firebase auth domain and password recovery callback stay under `salon-reserve-bg.firebaseapp.com`.
- API: retain both existing frontend origins and add the custom domain to CORS. Database connections continue to use Tokyo's pinned private secret.
- Legacy App Hosting: its fixed, non-cacheable redirect preserves paths and queries and targets the custom domain after release checks succeed. Mutation forwarding remains disabled.
- Session cookies remain secure and host scoped. A user signs in separately on a different hostname.

The load balancer and reserved IP briefly prepared during setup were removed after the user chose direct mapping. No Cloud SQL instance or backup was part of that cleanup.
