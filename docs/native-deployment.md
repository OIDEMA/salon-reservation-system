# Native GitHub deployment

## Activation and verification

The regional trigger `reservation-production` (`250509ed-9528-4a9f-8b32-2ef5cbfc58e3`) is enabled for pushes to `main` and uses the completed Developer Connect GitHub event connection below. Inspect its Cloud Build history by commit SHA to verify each automatic deployment.

The production GitHub Actions workflow and archive helper were removed in commit `cd64823`. Full native pipeline validation of that commit succeeded in Cloud Build `0c274cb5-50db-4c8c-a573-1599d01d8b3b`. App Hosting build/rollout `native-8b5a65699eb7aebd3b23d18` reached `READY` / `SUCCEEDED` with 100% traffic; API revision `reservation-api-00047-k89`, migration execution `reservation-db-migrate-7hh9z`, login HTTP 200, and lease removal were verified.

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
| App Hosting | Backend `salon-reserve-web`, root `apps/web` |
| API | Cloud Run `reservation-api`, region `asia-east1` |
| API/job runtime identity | `reservation-api-runtime@salon-reserve-bg.iam.gserviceaccount.com` |
| Schema job | `reservation-db-migrate`, Direct VPC egress |
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

Cloud Build builds the frontend container from its triggering Git SHA. The deployment script still verifies the existing App Hosting link against the backend and Developer Connect clone URI. An empty `_GIT_REPOSITORY_LINK` default fails preflight rather than choosing a repository implicitly.

App Hosting's automatic rollout policy stays **disabled**. Cloud Build performs the database and API steps first, then supplies the frontend container built from the same Git SHA to App Hosting. This gives one deployment sequence and prevents a separate frontend rollout from overtaking the API/schema update. Preflight requires `traffic.rolloutPolicy.disabled === true`.

## Pipeline

1. Verify the approved project/repository, App Hosting root and policy, private Cloud SQL network, and photo-storage public-access prevention.
2. Under Node.js 22.23.4, install dependencies, audit all three dependency lock files, generate Prisma, run type checks and application tests, and build the API and web app.
3. Build and push `reservation-api:${COMMIT_SHA}-${BUILD_ID}` and `reservation-web:${COMMIT_SHA}-${BUILD_ID}` in `asia-east1-docker.pkg.dev/salon-reserve-bg/cloud-run-source-deploy`. Smoke-test the web container before deployment. Each Cloud Build has unique tags, including repeated builds of one commit.
4. Run deployment tests, acquire the production lease, and verify current `main`. Skip a triggering commit that has become obsolete before deployment starts. Resolve the web image digest and validate its App Hosting request before modifying production services.
5. Record intent, update the private-VPC schema job, record execution intent, and wait for the schema operation.
6. Record intent, deploy the same image to the API with `native-deploy-build=BUILD_ID`, and verify VPC configuration and `/ready`.
7. Resolve the web image tag to its immutable digest, record intent and request App Hosting `source.container.image` with that digest and the checked-in container configuration. Wait for `BUILT` or `READY`, verify the container source, then validate the rollout request.
8. Record rollout intent, create the rollout, wait for both operations, require build `READY` and rollout `SUCCEEDED`, verify frontend routing, and release the lease after its child operations settle.

App Hosting build and rollout IDs are both `native-` followed by the first 23 hexadecimal characters of SHA256 of the Cloud Build UUID encoded as UTF-8. This deterministic 30-character ID meets App Hosting's length limit and is shared by creation and lease recovery.

The web tag must identify the triggering SHA and Cloud Build UUID in the approved registry. Its resolved digest must match the App Hosting container source before rollout and again after the build reaches `READY`. The backend's repository/root and Developer Connect clone URI are checked independently. App Hosting container-source builds do not populate Git source metadata; retain the Cloud Build source SHA, image digest and rollout ID together as release evidence.

The job and API keep their existing runtime identity, private network, Secret Manager database reference, limits, and startup checks. Build workers do not connect directly to the production database.

### Build environments and budgets

The API, web Docker images and Cloud Build validation image are pinned to Node.js `22.23.4`, the [2026-10-21 security release](https://nodejs.org/en/blog/release/v22.23.4). Docker builds use `--pull` to refresh the base image for that version. `npm run audit:security` checks the repository, standalone API, and standalone web lock files and stops the pipeline on any reported vulnerability. The API image also runs the schema job, so its Prisma CLI must remain available; do not remove development dependencies without separating or preserving that job's runtime requirements.

The frontend uses App Hosting's [container source API](https://firebase.google.com/docs/reference/apphosting/rest/v1/projects.locations.backends.builds#BuildSource.ContainerSource). On 2026-10-22 Google's managed buildpack did not yet provide patched Node.js `22.23.4` or `24.22.1`; a source build with the required engines range failed. Building the standalone Next.js image with the official Node.js base avoids that dependency. The backend uses versionless `runtime.value=nodejs`, which disables Automatic Base Image Updates. Maintain the pinned Docker versions and rebuild to deliver future runtime fixes; automatic runtime patching must not be assumed. Before declaring a runtime fix complete, verify the generated image's Node.js version and the digest of the revision receiving traffic.

Both Google Cloud CLI steps use `gcr.io/google.com/cloudsdktool/google-cloud-cli:slim`, which supplies the required `python3` and `git`. Verify both executables before changing the image; the deployment scripts use Python's standard library and do not require jq or curl.

The web Docker build sets `APP_HOSTING_BUILD=1` for build time only. The web prebuild installs its own dependencies with `npm ci --workspaces=false`; Next.js uses the app directory for tracing and Turbopack roots. The final non-root container includes standalone `server.js`, public files and Next.js static assets. Runtime configuration comes from `scripts/apphosting-container-config.json`; keep public build-time Firebase configuration consistent with `cloudbuild.yaml` and `apps/web/apphosting.yaml`. Container-source requests accept runtime variables only, so the JSON excludes build-only `APP_HOSTING_BUILD` and assigns `RUNTIME` availability to the remaining values. Regular workspace builds retain the repository root behavior.

The whole Cloud Build timeout is `10800s` (three hours), including validation, image construction, a lease wait of up to `3600s` (one hour), API/schema work, and App Hosting checks. Uncontended deployments acquire the lease immediately. A timed-out parent can leave asynchronous work active; do not treat timeout as proof of completion.

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

- Job/service generation advanced beyond its baseline; the unique image and owning build label match; reconciliation ended in a known terminal condition.
- The migration execution is new, complete, has no running tasks, and matches the recorded image digest.
- Expected App Hosting build/rollout resources exist and have known terminal states.
- The parent is terminal for takeover, and conditional deletion still matches the lease generation and metageneration.

Unknown, paused, unreadable, mismatched, or missing-after-intent resources retain the lease. Review the owner build, commit, intent metadata, generation/metageneration, job/execution/API snapshots, and deterministic App Hosting IDs described above before recovery. A lost response may indicate an accepted mutation, so do not repeat a recorded phase, erase intent, or blindly delete the object. Resolve ambiguity through operator inspection; any targeted recovery must preserve generation checks and an audit of the decision. Retry after resources settle or the ambiguity is resolved.

## Local verification

The deployment suites cover lease ownership/recovery, the shared 30-character App Hosting ID, container source verification and the ordered build/rollout sequence. Cloud Build additionally starts the actual web container and checks its runtime and public routes before deployment.

```bash
python3 tests/native-deploy.test.py
python3 tests/native-deploy-commands.test.py
```

These checks complement the production acceptance build recorded above; they do not substitute for its rollout and health checks.
