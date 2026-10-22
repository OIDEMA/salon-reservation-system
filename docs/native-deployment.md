# Native GitHub deployment

## Activation and verification

The regional trigger `reservation-production` (`250509ed-9528-4a9f-8b32-2ef5cbfc58e3`) is enabled for pushes to `main` and uses the completed Developer Connect GitHub event connection below. Inspect its Cloud Build history by commit SHA to verify each automatic deployment.

The production GitHub Actions workflow and archive helper were removed in commit `cd64823`. Historical native pipeline validation of that commit succeeded in Cloud Build `0c274cb5-50db-4c8c-a573-1599d01d8b3b`. App Hosting build/rollout `native-8b5a65699eb7aebd3b23d18` reached `READY` / `SUCCEEDED` with 100% traffic; API revision `reservation-api-00047-k89`, migration execution `reservation-db-migrate-7hh9z`, login HTTP 200, and lease removal were verified. That run predates the Tokyo frontend migration; verify a current release using the checks below.

The frontend now targets Tokyo Cloud Run. The existing App Hosting backend serves a redirect container for old URLs. This document describes the deployment configuration and acceptance checks; the configuration alone is not proof that a particular commit has reached production or improved latency.

The separate **Provision tenant** workflow remains manual and is never triggered by a push. See [provisioning.md](provisioning.md).

## Configuration

| Resource | Configuration |
| --- | --- |
| Project | `salon-reserve-bg` (`42401528382`) |
| GitHub | `OIDEMA/salon-reservation-system`, branch `main` |
| Cloud Build | `asia-east1`, trigger `reservation-production`, `cloudbuild.yaml` |
| Push filter | `^main$`; all file paths, without an `includedFiles` filter |
| Build identity | `github-deploy@salon-reserve-bg.iam.gserviceaccount.com` |
| Logs | Cloud Logging, `CLOUD_LOGGING_ONLY` |
| Web | Cloud Run `salon-reserve-web`, region `asia-northeast1` |
| Web public origin | `https://salon-reserve-web-42401528382.asia-northeast1.run.app` |
| Web runtime identity | `firebase-app-hosting-compute@salon-reserve-bg.iam.gserviceaccount.com` |
| Web limits | 1 CPU, 512 MiB, min 0 / max 1 instances |
| Previous URL | `https://salon-reserve-web--salon-reserve-bg.asia-east1.hosted.app` |
| App Hosting redirect | Backend `salon-reserve-web`, region `asia-east1`; existing source root `apps/web` retained |
| API | Cloud Run `reservation-api`, region `asia-east1` |
| API/job runtime identity | `reservation-api-runtime@salon-reserve-bg.iam.gserviceaccount.com` |
| Schema job | `reservation-db-migrate`, Direct VPC egress |
| Container registry | `asia-east1-docker.pkg.dev/salon-reserve-bg/cloud-run-source-deploy` |
| Lease | `gs://salon-reserve-bg-deployment-locks/deployment-locks/reservation-production.json` |

### Separate source and event connections

| Purpose | GitHub app and connection |
| --- | --- |
| App Hosting Git source | Firebase App Hosting GitHub App (`FIREBASE`), existing connection `apphosting-github-conn-2rjol6r` |
| Cloud Build push events | Developer Connect GitHub App (`DEVELOPER_CONNECT`), completed connection `reservation-github-builds`, installation `171204810` |

The Cloud Build event repository link is:

```txt
projects/salon-reserve-bg/locations/asia-east1/connections/reservation-github-builds/gitRepositoryLinks/OIDEMA-salon-reservation-system
```

The trigger's event configuration references this new event link. Its `_GIT_REPOSITORY_LINK` substitution continues to reference the **existing App Hosting source link** from the backend's `codebase.repository`, under `apphosting-github-conn-2rjol6r`. These values serve different purposes and must not be replaced with one another. Both links were verified against `OIDEMA/salon-reservation-system`; the Developer Connect installation is limited to that one repository.

The Developer Connect GitHub installation can read code, issues, and pull requests and write checks and commit statuses for that repository.

Cloud Build builds the web and redirect containers from its triggering Git SHA. The deployment script still verifies the existing App Hosting link against the backend and Developer Connect clone URI. An empty `_GIT_REPOSITORY_LINK` default fails preflight rather than choosing a repository implicitly.

App Hosting's automatic rollout policy stays **disabled**. Cloud Build performs the database and API steps, deploys and verifies the Tokyo web container, then supplies the redirect container built from the same Git SHA to App Hosting. This gives one deployment sequence and prevents a redirect from being activated before the new frontend is ready. Preflight requires `traffic.rolloutPolicy.disabled === true`.

## Pipeline

1. Verify the approved project/repository, App Hosting root and policy, private Cloud SQL network, and photo-storage public-access prevention.
2. Under Node.js 22.23.4, install dependencies, audit all three dependency lock files, generate Prisma, run type checks and application tests, and build the API and web app.
3. Build and push `reservation-api:${COMMIT_SHA}-${BUILD_ID}`, `reservation-web:${COMMIT_SHA}-${BUILD_ID}`, and `reservation-redirect:${COMMIT_SHA}-${BUILD_ID}` in `asia-east1-docker.pkg.dev/salon-reserve-bg/cloud-run-source-deploy`. Smoke-test the web container and test redirect behavior before deployment. Each Cloud Build has unique tags, including repeated builds of one commit.
4. Run deployment tests, acquire the production lease, and verify current `main`. Skip a triggering commit that has become obsolete before deployment starts. Resolve immutable web and redirect image digests and validate the App Hosting redirect request before modifying production services.
5. Record intent, update the private-VPC schema job, record execution intent, and wait for the schema operation.
6. Record intent, deploy the same image to the API with `native-deploy-build=BUILD_ID`, and verify VPC configuration and `/ready`.
7. Record `webDeployRequested` with the existing Tokyo service generation and expected web digest. Deploy the web digest to Cloud Run in `asia-northeast1` using `scripts/web-runtime-env.json`. Require the created revision to be ready, match the digest and build label, receive 100% traffic, and pass public login/routing checks.
8. Record intent and request App Hosting `source.container.image` with the redirect digest and `scripts/apphosting-redirect-config.json`. Wait for `BUILT` or `READY`, verify the container source, then validate the rollout request.
9. Record rollout intent, create the rollout, wait for both operations, require build `READY` and rollout `SUCCEEDED`, recheck Tokyo frontend routing and old-URL redirects, and release the lease after its child operations settle.

App Hosting build and rollout IDs are both `native-` followed by the first 23 hexadecimal characters of SHA256 of the Cloud Build UUID encoded as UTF-8. This deterministic 30-character ID meets App Hosting's length limit and is shared by creation and lease recovery.

The web and redirect tags must identify the triggering SHA and Cloud Build UUID in the approved registry. The web digest must match the ready Tokyo Cloud Run revision receiving traffic. The redirect digest must match the App Hosting container source before rollout and again after the build reaches `READY`. The backend's repository/root and Developer Connect clone URI are checked independently. App Hosting container-source builds do not populate Git source metadata; retain the Cloud Build source SHA, both image digests, Tokyo revision and App Hosting rollout ID together as release evidence.

The job and API keep their existing `asia-east1` region, runtime identity, private network, Secret Manager database reference, limits, and startup checks. Build workers and the Tokyo web service do not connect directly to the production database. The web service retains the Firebase runtime identity. The API CORS allowlist includes both frontend origins during the transition.

### Build environments and budgets

The API, web and redirect Docker images and Cloud Build validation image are pinned to Node.js `22.23.4`, the [2026-10-21 security release](https://nodejs.org/en/blog/release/v22.23.4). Docker builds use `--pull` to refresh the base image for that version. `npm run audit:security` checks the repository, standalone API, and standalone web lock files and stops the pipeline on any reported vulnerability. The redirect uses only Node.js built-in modules. The API image also runs the schema job, so its Prisma CLI must remain available; do not remove development dependencies without separating or preserving that job's runtime requirements.

The Tokyo frontend receives the standalone Next.js image directly through Cloud Run. The old endpoint uses App Hosting's [container source API](https://firebase.google.com/docs/reference/apphosting/rest/v1/projects.locations.backends.builds#BuildSource.ContainerSource) for the redirect image. On 2026-10-22 Google's managed buildpack did not yet provide patched Node.js `22.23.4` or `24.22.1`; a source build with the required engines range failed. Building images with the official Node.js base avoids that dependency. The App Hosting backend uses versionless `runtime.value=nodejs`, which disables Automatic Base Image Updates. Maintain the pinned Docker versions and rebuild to deliver future runtime fixes; automatic runtime patching must not be assumed for these containers. Before declaring a runtime fix complete, verify the generated image's Node.js version and the digest of the revision receiving traffic.

Both Google Cloud CLI steps use `gcr.io/google.com/cloudsdktool/google-cloud-cli:slim`, which supplies the required `python3` and `git`. Verify both executables before changing the image; the deployment scripts use Python's standard library and do not require jq or curl.

The web Docker build sets `APP_HOSTING_BUILD=1` for build time only; the name now describes the independent app-directory build mode rather than its deployment destination. The web prebuild installs its own dependencies with `npm ci --workspaces=false`; Next.js uses the app directory for tracing and Turbopack roots. The final non-root container includes standalone `server.js`, public files and Next.js static assets. Tokyo runtime configuration comes from `scripts/web-runtime-env.json`; keep public build-time Firebase configuration consistent with `cloudbuild.yaml`. Regular workspace builds retain the repository root behavior.

The App Hosting redirect uses `apps/redirect/Dockerfile` and `scripts/apphosting-redirect-config.json`. It returns non-cacheable 302 responses for GET/HEAD, preserving paths and queries and leaving fragments for browser inheritance. Other methods return 409 `SERVICE_MOVED`, without forwarding a mutation body. `/healthz` is a local process health check. The redirect target is the fixed Tokyo HTTPS origin and must never be derived from a request header.

The whole Cloud Build timeout is `10800s` (three hours), including validation, image construction, a lease wait of up to `3600s` (one hour), API/schema work, Tokyo deployment, and App Hosting checks. Uncontended deployments acquire the lease immediately. A timed-out parent can leave asynchronous work active; do not treat timeout as proof of completion.

## IAM

These native deployment grants are applied to the build identity above, in addition to its existing App Hosting, Cloud Run, Artifact Registry, runtime-service-account, and infrastructure metadata deployment access:

The source permissions are project-scoped and cover both repository links in this project.

| Grant | Scope/purpose |
| --- | --- |
| `projects/salon-reserve-bg/roles/nativeDeploymentObserver` | `cloudbuild.builds.create`, `cloudbuild.builds.get`, `developerconnect.gitRepositoryLinks.get`, `developerconnect.connections.get`, `developerconnect.gitRepositoryLinks.fetchReadToken` |
| `roles/iam.serviceAccountUser` | On the deployment service account itself; supplies `iam.serviceAccounts.actAs` for its builds |
| `roles/logging.logWriter` | Project; Cloud Logging build output |
| `roles/storage.objectUser` | Lock bucket, conditional on the exact lease-object resource below |

The lock binding condition is:

```txt
resource.name == 'projects/_/buckets/salon-reserve-bg-deployment-locks/objects/deployment-locks/reservation-production.json'
```

The dedicated lock bucket has uniform bucket-level access and enforced public access prevention. It contains neither clinical photographs nor App Hosting source archives. No service-account key file is used.

### Connection setup credentials

Developer Connect owns the regional OAuth secret:

```txt
projects/42401528382/locations/asia-east1/secrets/reservation-github-builds-github-oauthtoken-26da7d
```

Its persistent secret-scoped `roles/secretmanager.secretAccessor` binding names only the Developer Connect service agent. This binding was verified through IAM metadata without reading stored secret values.

The temporary metadata-only `nativeConnectionSecretCreator` grant and Secret Manager administration limited to `reservation-github-builds-github-oauthtoken-` names were limited to a one-hour setup window and removed immediately after setup completed. They are not runtime requirements. No existing database-secret values were accessed.

## Re-run and inspection

An authorized operator can manually run the trigger for an exact committed SHA, including while its automatic push handling is disabled:

A manual run verifies deployment execution, not GitHub push-event delivery. During connection activation, verify the latter separately through the build history of a new push.

```bash
# Set DEPLOY_COMMIT_SHA to the full SHA on the production main branch.
gcloud builds triggers run reservation-production \
  --project=salon-reserve-bg --region=asia-east1 --sha="$DEPLOY_COMMIT_SHA"

gcloud builds describe BUILD_ID \
  --project=salon-reserve-bg --region=asia-east1

gcloud builds log BUILD_ID \
  --project=salon-reserve-bg --region=asia-east1
```

A newly pushed SHA can take time to become available to the source index. If trigger submission returns a transient source-resolution error, check whether a build was created before retrying the same SHA. A retry receives a different build UUID/image tag; deployment still passes through the lease and current-main check.

For a failed or timed-out build, inspect the lease and its owner before starting further deployment work. A stopped Cloud Build does not establish that its accepted Cloud Run or App Hosting operations stopped.

## Lease recovery conditions

Lease creation uses `ifGenerationMatch=0`. Intent is written **before** each cloud mutation using both object-generation and metageneration preconditions. Metadata updates preserve the object generation. Intent includes job/service generation baselines, the previous migration execution, and the expected execution image digest.

Automatic release/reclaim requires the following evidence for recorded intent:

- Job/API/Tokyo web service generation advanced beyond its respective baseline; the unique image and owning build label match; reconciliation ended in a known terminal condition. Web intent also records its expected immutable digest.
- The migration execution is new, complete, has no running tasks, and matches the recorded image digest.
- Expected App Hosting build/rollout resources exist and have known terminal states.
- The parent is terminal for takeover, and conditional deletion still matches the lease generation and metageneration.

Unknown, paused, unreadable, mismatched, or missing-after-intent resources retain the lease. Review the owner build, commit, intent metadata, generation/metageneration, job/execution/API/Tokyo web snapshots, and deterministic App Hosting IDs described above before recovery. A lost response may indicate an accepted mutation, so do not repeat a recorded phase, erase intent, or blindly delete the object. Resolve ambiguity through operator inspection; any targeted recovery must preserve generation checks and an audit of the decision. Retry after resources settle or the ambiguity is resolved.

## Local verification

The deployment suites cover lease ownership/recovery across both regions, the shared 30-character App Hosting ID, Tokyo revision/digest verification, redirect container source verification and the ordered deployment sequence. Cloud Build additionally starts the actual web container and checks its runtime and public routes before deployment.

```bash
python3 tests/native-deploy.test.py
python3 tests/native-deploy-commands.test.py
```

These checks do not substitute for production verification. Confirm the exact commit, ready Tokyo revision and image digest, 100% traffic, public login/static assets, origin rejection, and App Hosting redirect path/query behavior after deployment. Check a fragment-bearing invitation link in a browser without submitting it. Confirm Firebase authorized domains and unchanged account-recovery callback; see [tenancy.md](tenancy.md#frontend-hostname-changes). Measure old and new endpoints under the same conditions before reporting latency figures.
