# Native GitHub deployment

## Activation and verification

The regional trigger `reservation-production` (`250509ed-9528-4a9f-8b32-2ef5cbfc58e3`) is enabled for pushes to `main`. The former production GitHub Actions workflow and its source-archive helper have been removed. Inspect the trigger's Cloud Build history by commit SHA to verify each automatic deployment.

Git-source acceptance for commit `54a88a04387aa7a4e85269850939ea267500f1d9` completed with frontend build and rollout `native-f44869fe4fb7a020fd6327f`, state `READY` / `SUCCEEDED`, 100% traffic, and a successful login-page check. Its App Hosting Cloud Build `d9a68763-af7b-4e90-8041-f4435e931763` succeeded. The database execution `reservation-db-migrate-xx2rb` and API revision `reservation-api-00046-qzp` also completed. The parent acceptance run `fd319b2a-497b-4d0e-946a-29ede5375a98` stopped because the optional source `repository` field was omitted; an operator verified the full SHA, exact GitHub commit URI, and current approved connection under the deployment lease before completing its rollout. The automatic pipeline now handles this response format with the same source checks below.

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

App Hosting uses the Firebase App Hosting GitHub App connection. The Cloud Build trigger references that Developer Connect repository link and supplies it as `_GIT_REPOSITORY_LINK`. The empty default in the build configuration fails preflight rather than choosing a repository implicitly.

App Hosting's automatic rollout policy stays **disabled**. Cloud Build performs the database and API steps first, then requests an App Hosting build from the same Git SHA. This gives one deployment sequence and prevents a separate frontend rollout from overtaking the API/schema update. Preflight requires `traffic.rolloutPolicy.disabled === true`.

## Pipeline

1. Verify the approved project/repository, App Hosting root and policy, private Cloud SQL network, and photo-storage public-access prevention.
2. Under Node.js 22, install dependencies, generate Prisma, run type checks and application tests, and build the API and web app.
3. Build and push `asia-east1-docker.pkg.dev/salon-reserve-bg/cloud-run-source-deploy/reservation-api:${COMMIT_SHA}-${BUILD_ID}`. Each Cloud Build has a unique tag, including repeated builds of one commit.
4. Run deployment tests, acquire the production lease, and verify current `main`. Skip a triggering commit that has become obsolete before deployment starts.
5. Record intent, update the private-VPC schema job, record execution intent, and wait for the schema operation.
6. Record intent, deploy the same image to the API with `native-deploy-build=BUILD_ID`, and verify VPC configuration and `/ready`.
7. Record intent and request App Hosting `source.codebase.commit = COMMIT_SHA`. Wait for compiled source (`BUILT` or `READY`) and verify the resolved repository/hash, then validate the rollout request.
8. Record rollout intent, create the rollout, wait for both operations, require build `READY` and rollout `SUCCEEDED`, verify frontend routing, and release the lease after its child operations settle.

App Hosting build and rollout IDs are both `native-` followed by the first 23 hexadecimal characters of SHA256 of the Cloud Build UUID encoded as UTF-8. This deterministic 30-character ID meets App Hosting's length limit and is shared by creation and lease recovery.

The resolved source hash must match the triggering SHA; a returned `commit` must also match. A returned `repository` field must equal the approved link, including rejecting empty/null values. If that optional field is omitted, require the exact approved GitHub commit URI and freshly verify the backend's link/root and the Developer Connect clone URI. Repeat source verification after the build reaches `READY`.

The job and API keep their existing runtime identity, private network, Secret Manager database reference, limits, and startup checks. Build workers do not connect directly to the production database.

### Build environments and budgets

Both Google Cloud CLI steps use `gcr.io/google.com/cloudsdktool/google-cloud-cli:slim`, which supplies the required `python3` and `git`. Verify both executables before changing the image; the deployment scripts use Python's standard library and do not require jq or curl.

Native App Hosting builds set `APP_HOSTING_BUILD=1` for build time only. The web prebuild installs its own dependencies with `npm ci --workspaces=false`; Next.js then uses the app directory for tracing and Turbopack roots so its standalone `server.js` matches the App Hosting adapter. Regular workspace builds retain the repository root behavior.

The whole Cloud Build timeout is `10800s` (three hours), including validation, image construction, a lease wait of up to `3600s` (one hour), API/schema work, and App Hosting checks. Uncontended deployments acquire the lease immediately. A timed-out parent can leave asynchronous work active; do not treat timeout as proof of completion.

## IAM

These native deployment grants are applied to the build identity above, in addition to its existing App Hosting, Cloud Run, Artifact Registry, runtime-service-account, and infrastructure metadata deployment access:

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

## Re-run and inspection

An authorized operator can manually run the trigger for an exact committed SHA, including while its automatic push handling is disabled:

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

The deployment suites passed 74 mocked tests (46 lease/helper and 28 command tests), including the shared 30-character App Hosting ID, optional source metadata checks, and compiled-source/rollout sequence. The native-source Next.js fixture also passed App Hosting adapter `14.0.21` and its standalone-output check.

```bash
python3 tests/native-deploy.test.py
python3 tests/native-deploy-commands.test.py
```

These checks complement the production acceptance build recorded above; they do not substitute for its rollout and health checks.
