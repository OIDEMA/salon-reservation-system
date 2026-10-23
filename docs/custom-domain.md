# Production custom domain

The selected public hostname is `salon-reserve.beauty-gum.jp`. It maps directly to Cloud Run service `salon-reserve-web` in `asia-northeast1` in project `salon-reserve-bg`. A dedicated load balancer and reserved public IP are not part of this configuration. The Tokyo `run.app` endpoint remains available as a fallback.

## DNS and certificate setup

1. Verify ownership of the base domain `beauty-gum.jp` with the same Google account used to create the mapping. Cloud Run requires base-domain ownership verification when mapping a subdomain, so verification of `salon-reserve.beauty-gum.jp` alone does not satisfy this prerequisite. Check `gcloud domains list-user-verified`, then use `gcloud domains verify beauty-gum.jp` if the base domain is not listed. Complete the Search Console flow and retain its instructed DNS verification record. The public serving mapping remains only `salon-reserve.beauty-gum.jp`; existing serving records for the parent domain and other hostnames are outside this setup.
2. Create the mapping only for the approved service and hostname:

   ```sh
   gcloud beta run domain-mappings create \
     --service=salon-reserve-web \
     --domain=salon-reserve.beauty-gum.jp \
     --region=asia-northeast1 \
     --project=salon-reserve-bg
   ```

3. Read the mapping's `status.resourceRecords` and configure those records at Xserver. For subdomains the serving record is a CNAME to `ghs.googlehosted.com`. Remove conflicting A/AAAA records for this exact hostname only. Retain the separate Google ownership-verification DNS record as well; its record type and name must match the Search Console instructions.
4. Require the mapping to be ready, its Google-managed certificate to be provisioned, and HTTPS login/assets to succeed before changing the legacy redirect. Do not bypass certificate validation or redirect users to an unready hostname.

Google documents the direct mapping feature as Preview with possible latency limitations. The user explicitly selected direct Cloud Run mapping without a load balancer. See [Google's domain mapping documentation](https://docs.cloud.google.com/run/docs/mapping-custom-domains) and [Search Console ownership verification](https://support.google.com/webmasters/answer/9008080).

## Application and release settings

- `scripts/web-runtime-env.json`: canonical `APP_PUBLIC_ORIGIN` is the custom domain. `APP_PUBLIC_ORIGINS` also allows the existing Tokyo origin for legitimate fallback sessions.
- Firebase Authentication: add the custom hostname while retaining earlier authorized domains. The Firebase auth domain and password recovery callback stay under `salon-reserve-bg.firebaseapp.com`.
- API: retain both existing frontend origins and add the custom domain to CORS. Database connections continue to use Tokyo's pinned private secret.
- Legacy App Hosting: its fixed, non-cacheable redirect preserves paths and queries and targets the custom domain after release checks succeed. Mutation forwarding remains disabled.
- Session cookies remain secure and host scoped. A user signs in separately on a different hostname.

The load balancer and reserved IP briefly prepared during setup were removed after the user chose direct mapping. No Cloud SQL instance or backup was part of that cleanup.
