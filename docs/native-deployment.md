# Native GitHub deployment

## Current migration status

This is a prepared migration, not an active replacement for the production deployment workflow. The native Cloud Build trigger has not been created. Keep `.github/workflows/deploy.yml` in place until a native deployment has completed successfully and its production checks have passed.

The following supporting configuration has already been applied to `github-deploy@salon-reserve-bg.iam.gserviceaccount.com`:

- The custom role `projects/salon-reserve-bg/roles/nativeDeploymentObserver` grants `cloudbuild.builds.create`, `cloudbuild.builds.get`, and `developerconnect.gitRepositoryLinks.get` under the title `Native deployment build control`.
- `roles/logging.logWriter` permits Cloud Build logs in Cloud Logging.
- The private bucket `salon-reserve-bg-deployment-locks` exists with uniform bucket-level access and enforced public access prevention. A bucket-scoped `roles/storage.objectUser` binding is restricted to `resource.name == 'projects/_/buckets/salon-reserve-bg-deployment-locks/objects/deployment-locks/reservation-production.json'`.

On 2026-10-14, the user explicitly approved adding `cloudbuild.builds.create` to the custom role and granting the deployment account `roles/iam.serviceAccountUser` on itself. Both changes have been applied. The native trigger and complete production rollout still require verification before the old deployment workflow is removed.

Cloud Build source retrieval also requires `developerconnect.connections.get` and `developerconnect.gitRepositoryLinks.fetchReadToken`. Live IAM diagnostics confirmed both are missing on the build account. These source-read additions are pending explicit approval; write-token access is not requested. The project currently contains the one approved public GitHub repository link.

## Target configuration

| Setting | Value |
| --- | --- |
| Project | `salon-reserve-bg` (`42401528382`) |
| GitHub repository | `OIDEMA/salon-reservation-system` |
| Production branch | `main` |
| App Hosting backend | `salon-reserve-web` |
| App Hosting root directory | `apps/web` |
| App Hosting automatic rollout policy | Explicitly disabled |
| Cloud Build region | `asia-east1` |
| Cloud Build trigger | `reservation-production`, push branch filter `^main$` |
| Build configuration | `cloudbuild.yaml` |
| Build service account | `github-deploy@salon-reserve-bg.iam.gserviceaccount.com` |
| Log destination | Cloud Logging (`CLOUD_LOGGING_ONLY`) |
| API service | `reservation-api` |
| API runtime service account | `reservation-api-runtime@salon-reserve-bg.iam.gserviceaccount.com` |
| Schema job | `reservation-db-migrate` |
| Lease bucket | `salon-reserve-bg-deployment-locks` |
| Lease object | `deployment-locks/reservation-production.json` |

The App Hosting repository connection must come from the **Firebase App Hosting GitHub App**. Its Developer Connect repository link is also used by the Cloud Build trigger. Configure the actual link resource as `_GIT_REPOSITORY_LINK`; its empty default in `cloudbuild.yaml` deliberately fails preflight.

App Hosting automatic rollouts must remain disabled so a GitHub push cannot release the frontend ahead of the API and database. Cloud Build receives the push and requests the App Hosting build explicitly after those steps succeed. The preflight verifies `traffic.rolloutPolicy.disabled === true`.

## Deployment sequence

The pipeline uses the triggering `COMMIT_SHA` and Cloud Build `BUILD_ID` throughout:

1. Verify the approved project, Developer Connect clone URI, backend repository/root directory, disabled automatic rollout policy, private Cloud SQL network, and private photo-bucket settings.
2. Install dependencies under Node.js 22; generate Prisma; run type checks, application unit tests, and both builds.
3. Build and push the API image with the unique tag `${COMMIT_SHA}-${BUILD_ID}`. A second build of the same commit uses a different tag and cannot replace the image another deployment expects.
4. Run the mocked deployment tests and acquire the production lease. Verify the current `main` SHA and skip a commit that has become obsolete before deployment begins.
5. Record schema-job deployment intent, update the VPC-connected job, record execution intent, and wait for schema application to complete.
6. Record API deployment intent, deploy the same image to Cloud Run, and verify Direct VPC configuration and `/ready`.
7. Record App Hosting build intent and build from `source.codebase.commit = COMMIT_SHA`. Require `READY`, the expected repository, and an exact resolved Git hash before requesting the rollout.
8. Record rollout intent, require `SUCCEEDED`, and verify the login page, tenant redirect, and reserved calendar API path.
9. Release the lease only after the recorded child operations are proven settled.

The API and schema job keep their existing private network, runtime identity, Secret Manager reference, startup probe, and resource limits. Database operations stay inside the VPC-connected Cloud Run job. No public SQL IP, direct build-worker database connection, or service-account key file is introduced.

### Next.js build behavior

Native App Hosting builds receive `APP_HOSTING_BUILD=1` at build time. The web prebuild installs `apps/web` dependencies with `npm ci --workspaces=false`; Next.js uses the application directory for tracing and Turbopack roots. This gives the App Hosting adapter the standalone `server.js` layout it expects even when the Git source includes the complete npm workspace repository. Ordinary workspace builds retain their existing repository root behavior.

### Time budgets

Cloud Build has a whole-pipeline timeout of `10800s` (three hours). This covers validation, image construction, a production lease wait of up to `3600s`, database/API operations, and App Hosting build/rollout checks. Uncontended deployments acquire the lease immediately; the larger wait budget is used only when another deployment is still active.

A timeout does not prove that asynchronous child operations stopped. Retry only after checking the retained lease and cloud resources. An unknown or ambiguous recorded intent requires operator inspection rather than an automatic bypass.

## Lease and recovery

The lease is isolated from both clinical photographs and App Hosting source archives. Creation uses `ifGenerationMatch=0`. Before each cloud mutation, intent is stored in object metadata with both object-generation and metageneration preconditions; metadata updates do not replace the object generation.

Intent records include the job/service generation before deployment or the previous migration execution name. Cloud Run resources must advance past the recorded generation and match the expected image and `native-deploy-build=BUILD_ID` label. Migration executions must differ from their baseline and use the verified image digest, since Cloud Run pins execution images to digests. App Hosting build and rollout IDs are derived from the owning Cloud Build UUID.

A terminal parent Cloud Build is insufficient to reclaim a lease. Recovery also checks its recorded child resources. Running, paused, missing-after-intent, unknown, mismatched, or unreadable resources retain the lease. Conditional deletion protects a replacement lease from a stale owner or concurrent metadata update.

For a retained lease, inspect:

- The object body and `nativeDeploymentIntents` metadata, including generation and metageneration.
- The owning regional Cloud Build and the triggering commit.
- The schema job generation, label, image, latest execution, execution completion, and pinned digest.
- The API generation, reconciliation/terminal state, label, and image.
- The deterministic App Hosting build and rollout, including Git hash and rollout state.

Do not blindly delete the object, remove its intent metadata, or rerun a recorded phase. A lost response can mean the mutation was accepted. Establish whether each operation can still change production before a targeted operator recovery; use generation and metageneration checks and record the reason for recovery. The automatic path retains unknown intent and can be retried after the resources settle or the ambiguity is resolved.

## Cutover procedure

1. Keep the old production workflow active while preparing and reviewing the migration files.
2. Verify the Firebase GitHub connection, `main`, root directory `apps/web`, and disabled automatic rollouts against the target configuration above.
3. Obtain explicit approval for the two pending grants. Only after approval, apply the following scoped changes:

   ```bash
   gcloud iam roles update nativeDeploymentObserver \
     --project=salon-reserve-bg \
     --title="Native deployment build control" \
     --permissions=cloudbuild.builds.get,developerconnect.gitRepositoryLinks.get,cloudbuild.builds.create

   gcloud iam service-accounts add-iam-policy-binding \
     github-deploy@salon-reserve-bg.iam.gserviceaccount.com \
     --project=salon-reserve-bg \
     --member=serviceAccount:github-deploy@salon-reserve-bg.iam.gserviceaccount.com \
     --role=roles/iam.serviceAccountUser
   ```

4. Commit the reviewed migration source. Run a native build for that exact commit and inspect its complete Cloud Build, Cloud Run, schema, and App Hosting results before removing the old workflow. Avoid a concurrent old-Action deployment during this verification; it does not participate in the native lease.
5. After successful verification, remove `.github/workflows/deploy.yml` and retire its archive-deployment helper. Create the regional native trigger using the actual Firebase repository link:

   ```bash
   # Set DEPLOY_GIT_LINK to the verified Firebase App Hosting repository resource.
   gcloud beta builds triggers create developer-connect \
     --project=salon-reserve-bg \
     --region=asia-east1 \
     --name=reservation-production \
     --git-repository-link="$DEPLOY_GIT_LINK" \
     --branch-pattern='^main$' \
     --build-config=cloudbuild.yaml \
     --service-account=projects/salon-reserve-bg/serviceAccounts/github-deploy@salon-reserve-bg.iam.gserviceaccount.com \
     --substitutions="_GIT_REPOSITORY_LINK=$DEPLOY_GIT_LINK" \
     --included-files='cloudbuild.yaml,scripts/**,tests/native-deploy*.py,apps/api/**,apps/web/**,firebase.json,package.json,package-lock.json'
   ```

6. Push a reviewed change to `main`, confirm the native trigger runs once, and verify the expected commit/build image and frontend Git hash in production. Update the migration status in this document with the successful build and rollout IDs.

The `Provision tenant` workflow remains a separate, manually invoked administrative operation. It is never triggered by a push and is not part of the production deployment cutover. Its tenant-provisioning identity and workflow are retained.

## Verification

The migration passed 60 isolated mocked deployment tests (44 lease/helper tests and 16 command tests), covering lease ownership, generation/metadata races, asynchronous children, safety preflight, phase intent, command ordering, and same-commit/different-build image rejection. Re-run both deployment suites before cutover:

```bash
python3 tests/native-deploy.test.py
python3 tests/native-deploy-commands.test.py
```

The Next.js native-source fixture also passed with App Hosting adapter `14.0.21`, including standalone output. These local checks do not establish that the native production trigger or the pending IAM grants are complete. Production deployment verification remains part of the cutover procedure.

## References

- [Firebase App Hosting repository connections](https://firebase.google.com/docs/reference/apphosting/rest/v1beta/projects.locations.backends#Backend.Codebase)
- [App Hosting build source and resolved Git hash](https://firebase.google.com/docs/reference/apphosting/rest/v1beta/projects.locations.backends.builds)
- [App Hosting rollout policy](https://firebase.google.com/docs/reference/apphosting/rest/v1beta/projects.locations.backends.traffic)
- [Cloud Build Developer Connect GitHub triggers](https://docs.cloud.google.com/build/docs/automating-builds/github/build-repos-from-github?generation=connect)
- [User-managed Cloud Build service accounts](https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts)
