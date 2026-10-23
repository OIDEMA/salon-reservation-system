#!/usr/bin/env python3
"""Serialize production rollouts and skip obsolete main commits.

The lease is a generation-guarded object in a private deployment lock bucket.
It never touches App Hosting sources or clinical photographs.
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zoneinfo

PROJECT = "salon-reserve-bg"
REGION = "asia-east1"
API_REGION = "asia-northeast1"
WEB_REGION = "asia-northeast1"
WEB_SERVICE = "salon-reserve-web"
EMAIL_RUNTIME_SERVICE_ACCOUNT = "reservation-email-runtime@salon-reserve-bg.iam.gserviceaccount.com"
BUCKET = "salon-reserve-bg-deployment-locks"
LOCK_NAME = "deployment-locks/reservation-production.json"
REPOSITORY = "https://github.com/OIDEMA/salon-reservation-system.git"
TERMINAL_BUILD_STATES = {"SUCCESS", "FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"}
UUID_PATTERN = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
TERMINAL_RUN_CONDITIONS = {"CONDITION_SUCCEEDED", "CONDITION_FAILED"}
LOCK_URL = f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/{urllib.parse.quote(LOCK_NAME, safe='')}"
INTENT_METADATA_KEY = "nativeDeploymentIntents"
INTENT_PHASES = {
    "jobDeployRequested": "baselineGeneration",
    "jobExecutionRequested": "baselineExecution",
    "apiDeployRequested": "baselineGeneration",
    "emailJobDeployRequested": "baselineGeneration",
    "webDeployRequested": "baselineGeneration",
    "apiRelayDeployRequested": "baselineGeneration",
    "appBuildRequested": None,
    "appRolloutRequested": None,
}
EXECUTION_PATTERN = r"projects/(?:salon-reserve-bg|42401528382)/locations/(?:asia-east1|asia-northeast1)/jobs/reservation-db-migrate/executions/[a-z0-9-]+"


class ApiError(RuntimeError):
    def __init__(self, status):
        super().__init__(f"Google Cloud request failed with HTTP {status}.")
        self.status = status


class GoogleApi:
    def __init__(self):
        self.token = ""
        self.token_at = 0.0

    def request(self, method, url, payload=None):
        if not self.token or time.monotonic() - self.token_at > 2400:
            self.token = subprocess.check_output(
                ["gcloud", "auth", "print-access-token"], text=True
            ).strip()
            self.token_at = time.monotonic()
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode() if payload is not None else None,
            method=method,
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = response.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as error:
            raise ApiError(error.code) from None


def canonical_resource(name):
    return name.replace("projects/42401528382/", f"projects/{PROJECT}/", 1)


def app_hosting_id(build_id):
    # App Hosting IDs are limited to 30 characters; keep this mapping identical
    # to deploy-native.sh so recovery observes the resources that were created.
    return "native-" + hashlib.sha256(build_id.encode("utf-8")).hexdigest()[:23]


def owner_api_region(owner):
    region = owner.get("apiRegion", REGION)
    if region not in (REGION, API_REGION):
        raise RuntimeError("The deployment lease has an unapproved API region.")
    return region


def execution_resource(name, api_region=None):
    if not isinstance(name, str):
        return None
    if re.fullmatch(r"reservation-db-migrate-[a-z0-9-]+", name):
        return f"projects/{PROJECT}/locations/{api_region or REGION}/jobs/reservation-db-migrate/executions/{name}"
    if re.fullmatch(EXECUTION_PATTERN, name):
        if api_region is not None and f"/locations/{api_region}/" not in name:
            return None
        return canonical_resource(name)
    return None


def read_intents(metadata, require_execution_digest=True):
    raw = metadata.get("metadata", {}).get(INTENT_METADATA_KEY)
    intents = {} if raw is None else json.loads(raw)
    if not isinstance(intents, dict) or any(phase not in INTENT_PHASES for phase in intents):
        raise RuntimeError("The deployment lease has unrecognized intent metadata.")
    for phase, intent in intents.items():
        if not isinstance(intent, dict):
            raise RuntimeError("The deployment lease has invalid intent metadata.")
        field = INTENT_PHASES[phase]
        if field == "baselineGeneration" and not re.fullmatch(r"[0-9]+", str(intent.get(field, ""))):
            raise RuntimeError("The deployment lease has an invalid generation baseline.")
        digest_field = {"webDeployRequested": "expectedWebDigest", "apiRelayDeployRequested": "expectedRelayDigest", "emailJobDeployRequested": "expectedEmailJobDigest"}.get(phase)
        if digest_field and require_execution_digest and not re.fullmatch(r"sha256:[0-9a-f]{64}", str(intent.get(digest_field, ""))):
            raise RuntimeError("The deployment lease has an invalid service image digest.")
        if field == "baselineExecution":
            baseline = intent.get(field)
            if not isinstance(baseline, str) or (baseline and not execution_resource(baseline)):
                raise RuntimeError("The deployment lease has an invalid execution baseline.")
            if require_execution_digest and not re.fullmatch(r"sha256:[0-9a-f]{64}", intent.get("expectedExecutionDigest", "")):
                raise RuntimeError("The deployment lease has an invalid execution image digest.")
    return intents


def mark_deployment_intent(api, generation, phase, baseline=None):
    """Persist intent before a mutation, without replacing the GCS object.

    Both object and metadata generations are checked: a replaced lease or a
    concurrent intent update must stop the caller before it starts cloud work.
    """
    generation = str(generation)
    if not re.fullmatch(r"[1-9][0-9]*", generation) or phase not in INTENT_PHASES:
        raise RuntimeError("A valid lease generation and deployment phase are required.")
    field = INTENT_PHASES[phase]
    intent = {} if field is None else {field: baseline}
    # Reuse validation before any request, including rejecting a missing baseline.
    read_intents({"metadata": {INTENT_METADATA_KEY: json.dumps({phase: intent})}}, require_execution_digest=False)
    metadata = api.request("GET", LOCK_URL + "?ifGenerationMatch=" + generation)
    owner = api.request("GET", LOCK_URL + "?alt=media&generation=" + generation)
    if not re.fullmatch(UUID_PATTERN, owner.get("buildId", "")) or not re.fullmatch(r"[0-9a-f]{40}", owner.get("commitSha", "")):
        raise RuntimeError("The deployment lease has an unrecognized owner.")
    api_region = owner_api_region(owner)
    if phase == "jobExecutionRequested" and baseline and not execution_resource(baseline, api_region):
        raise RuntimeError("The execution baseline belongs to a different API region.")
    intents = read_intents(metadata)
    if phase in intents:
        # After an ambiguous response, repeating the cloud mutation could create
        # two executions. A new build/lease or operator review is required.
        raise RuntimeError("A deployment phase has already been requested and cannot be repeated.")
    if phase in ("jobExecutionRequested", "webDeployRequested", "apiRelayDeployRequested", "emailJobDeployRequested"):
        # Execution.image is digest-pinned by Cloud Run even when Job.image uses
        # a tag. Record the expected digest before starting the asynchronous run.
        image_name = {"jobExecutionRequested": "reservation-api", "webDeployRequested": "reservation-web", "apiRelayDeployRequested": "reservation-api-relay", "emailJobDeployRequested": "reservation-api"}[phase]
        image = f"{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/{image_name}:{owner['commitSha']}-{owner['buildId']}"
        try:
            digest = subprocess.check_output(
                ["gcloud", "artifacts", "docker", "images", "describe", image,
                 f"--project={PROJECT}", "--format=value(image_summary.digest)"],
                text=True, stderr=subprocess.PIPE, timeout=60,
            ).strip()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            raise RuntimeError("Unable to verify the migration image digest.") from None
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise RuntimeError("The migration image returned an invalid digest.")
        intent[{"jobExecutionRequested": "expectedExecutionDigest", "webDeployRequested": "expectedWebDigest", "apiRelayDeployRequested": "expectedRelayDigest", "emailJobDeployRequested": "expectedEmailJobDigest"}[phase]] = digest
    intents[phase] = intent
    custom_metadata = dict(metadata.get("metadata", {}))
    custom_metadata[INTENT_METADATA_KEY] = json.dumps(intents, sort_keys=True, separators=(",", ":"))
    result = api.request(
        "PATCH", LOCK_URL + "?ifGenerationMatch=" + generation
        + "&ifMetagenerationMatch=" + str(metadata["metageneration"]),
        {"metadata": custom_metadata},
    )
    if str(result.get("generation")) != generation:
        raise RuntimeError("The deployment lease generation changed while recording intent.")


def matches_run_owner(resource, build_id, commit):
    if resource.get("labels", {}).get("native-deploy-build") != build_id:
        return False
    template = resource.get("template", {})
    containers = template.get("template", template).get("containers", [])
    image = f"{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/reservation-api:{commit}-{build_id}"
    return len(containers) == 1 and containers[0].get("image") == image


def owns_run_resource(resource, build_id, commit, baseline):
    generation = str(resource.get("generation", ""))
    return (
        re.fullmatch(r"[0-9]+", generation) is not None
        and int(generation) > int(baseline)
        and matches_run_owner(resource, build_id, commit)
    )


def run_resource_finished(resource):
    state = resource.get("terminalCondition", {}).get("state")
    if resource.get("reconciling", False) is not False or state not in TERMINAL_RUN_CONDITIONS:
        return False
    # Successful reconciliation must acknowledge the requested generation.
    # Failed reconciliation is terminal even if observedGeneration is older.
    if state == "CONDITION_SUCCEEDED":
        generation = str(resource.get("generation", ""))
        return re.fullmatch(r"[1-9][0-9]*", generation) is not None and str(resource.get("observedGeneration", "")) == generation
    return True


def deployment_children_finished(api, build_id, commit=None, intents=None, api_region=REGION):
    """A stopped Cloud Build does not imply its asynchronous children stopped.

    An absent resource or an unchanged Run snapshot cannot discharge recorded
    intent: the mutation may have been accepted but not yet become visible.
    PAUSED/unknown states and unreadable resources also retain the lease.
    """
    if api_region not in (REGION, API_REGION):
        raise RuntimeError("Unapproved API recovery region.")
    intents = intents or {}
    backend = f"projects/{PROJECT}/locations/{REGION}/backends/salon-reserve-web"
    app_id = app_hosting_id(build_id)
    for resource_type, phase, terminal_states in (
        ("builds", "appBuildRequested", {"READY", "FAILED", "SKIPPED", "EXPIRED"}),
        ("rollouts", "appRolloutRequested", {"SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"}),
    ):
        try:
            resource = api.request(
                "GET", f"https://firebaseapphosting.googleapis.com/v1beta/{backend}/{resource_type}/{app_id}"
            )
        except ApiError as error:
            if error.status == 404:
                if phase in intents:
                    return False
                continue
            raise
        if resource.get("state") not in terminal_states:
            return False

    run_base = f"https://run.googleapis.com/v2/projects/{PROJECT}/locations/{api_region}"
    try:
        job = api.request("GET", run_base + "/jobs/reservation-db-migrate")
    except ApiError as error:
        if error.status != 404:
            raise
        if "jobDeployRequested" in intents or "jobExecutionRequested" in intents:
            return False
        job = None
    if job is not None:
        if "jobDeployRequested" in intents and not owns_run_resource(
            job, build_id, commit, intents["jobDeployRequested"]["baselineGeneration"]
        ):
            return False
        if not run_resource_finished(job):
            return False
        latest = job.get("latestCreatedExecution")
        if "jobExecutionRequested" in intents:
            execution_intent = intents["jobExecutionRequested"]
            if not latest or not execution_resource(latest.get("name"), api_region) or execution_resource(latest.get("name"), api_region) == execution_resource(execution_intent["baselineExecution"], api_region):
                return False
            if not matches_run_owner(job, build_id, commit):
                return False
        if latest:
            if latest.get("completionStatus") not in {"EXECUTION_SUCCEEDED", "EXECUTION_FAILED", "EXECUTION_CANCELLED"}:
                return False
            execution_name = execution_resource(latest.get("name"), api_region)
            if not execution_name:
                return False
            execution = api.request("GET", "https://run.googleapis.com/v2/" + execution_name)
            if not execution.get("completionTime") or execution.get("reconciling", False) is not False or execution.get("runningCount", 0) != 0:
                return False
            if "jobExecutionRequested" in intents:
                containers = execution.get("template", {}).get("containers", [])
                image = f"{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/reservation-api@{intents['jobExecutionRequested']['expectedExecutionDigest']}"
                if len(containers) != 1 or containers[0].get("image") != image:
                    return False
        elif job.get("executionCount", 0) != 0:
            return False

    try:
        service = api.request("GET", run_base + "/services/reservation-api")
    except ApiError as error:
        if error.status != 404:
            raise
        if "apiDeployRequested" in intents:
            return False
        service = None
    if service is not None:
        if "apiDeployRequested" in intents and not owns_run_resource(
            service, build_id, commit, intents["apiDeployRequested"]["baselineGeneration"]
        ):
            return False
        if not run_resource_finished(service):
            return False

    # A newly deployed mail Job must reconcile to the exact API image before
    # an interrupted build can relinquish the lease. Older leases omit this
    # intent and do not require the Job to exist.
    if "emailJobDeployRequested" in intents:
        intent = intents["emailJobDeployRequested"]
        try:
            email_job = api.request("GET", run_base + "/jobs/reservation-email-outbox")
        except ApiError as error:
            if error.status == 404:
                return False
            raise
        generation = str(email_job.get("generation", ""))
        task = email_job.get("template", {}).get("template", {})
        containers = task.get("containers", [])
        image = f"{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/reservation-api@{intent['expectedEmailJobDigest']}"
        if (not re.fullmatch(r"[0-9]+", generation)
                or int(generation) <= int(intent["baselineGeneration"])
                or email_job.get("labels", {}).get("native-deploy-build") != build_id
                or task.get("serviceAccount") != EMAIL_RUNTIME_SERVICE_ACCOUNT
                or len(containers) != 1 or containers[0].get("image") != image):
            return False
        if not run_resource_finished(email_job):
            return False

    # Older leases remain recoverable without new-region or relay resources.
    for phase, target_region, service_name, image_name, digest_key in (
        ("webDeployRequested", WEB_REGION, WEB_SERVICE, "reservation-web", "expectedWebDigest"),
        ("apiRelayDeployRequested", REGION, "reservation-api", "reservation-api-relay", "expectedRelayDigest"),
    ):
        if phase not in intents:
            continue
        intent = intents[phase]
        try:
            resource = api.request("GET", f"https://run.googleapis.com/v2/projects/{PROJECT}/locations/{target_region}/services/{service_name}")
        except ApiError as error:
            if error.status == 404:
                return False
            raise
        generation = str(resource.get("generation", ""))
        containers = resource.get("template", {}).get("containers", [])
        image = f"{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/{image_name}@{intent[digest_key]}"
        if not re.fullmatch(r"[0-9]+", generation) or int(generation) <= int(intent["baselineGeneration"]) or resource.get("labels", {}).get("native-deploy-build") != build_id or len(containers) != 1 or containers[0].get("image") != image:
            return False
        if not run_resource_finished(resource):
            return False
    return True


class ProductionLease:
    def __init__(self, api, build_id, commit, sleep=time.sleep, api_region=API_REGION):
        self.api = api
        self.build_id = build_id
        self.commit = commit
        self.api_region = owner_api_region({"apiRegion": api_region})
        self.sleep = sleep
        self.generation = None
        self.object_url = LOCK_URL

    def delete_generation(self, generation, metageneration):
        try:
            self.api.request("DELETE", self.object_url + "?ifMetagenerationMatch=" + str(metageneration) + "&ifGenerationMatch=" + str(generation))
        except ApiError as error:
            if error.status not in (404, 412):
                raise
            return error.status == 404
        return True

    def owner(self):
        return {
            "buildId": self.build_id,
            "commitSha": self.commit,
            "apiRegion": self.api_region,
            "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }

    def acquire(self, wait_seconds=3600):
        deadline = time.monotonic() + wait_seconds
        owner = self.owner()
        upload_url = (
            f"https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o"
            f"?uploadType=media&name={urllib.parse.quote(LOCK_NAME, safe='')}&ifGenerationMatch=0"
        )
        while time.monotonic() <= deadline:
            try:
                metadata = self.api.request("POST", upload_url, owner)
                self.generation = str(metadata["generation"])
                print("Acquired production deployment lease.", flush=True)
                return
            except ApiError as error:
                if error.status != 412:
                    raise
            try:
                metadata = self.api.request("GET", self.object_url)
                held_by = self.api.request("GET", self.object_url + "?alt=media&generation=" + str(metadata["generation"]))
            except ApiError as error:
                if error.status in (404, 412):
                    continue
                raise
            owner_id = held_by.get("buildId", "")
            if held_by.get("kind") == "tenantProvisioning":
                if not re.fullmatch(r"[1-9][0-9]*-[1-9][0-9]*", held_by.get("workflowRun", "")) or owner_api_region(held_by) != API_REGION:
                    raise RuntimeError("The provisioning lease has an unrecognized owner; operator review is required.")
                # A cancelled workflow can leave its Cloud Run execution alive.
                # Only that workflow or an operator may release this fence.
                print("Waiting for tenant provisioning to release the production lease.", flush=True)
                self.sleep(10)
                continue
            if not re.fullmatch(UUID_PATTERN, owner_id):
                raise RuntimeError("The deployment lease has an unrecognized owner; operator review is required.")
            status = self.api.request(
                "GET", f"https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}/builds/{owner_id}"
            ).get("status")
            if status in TERMINAL_BUILD_STATES and deployment_children_finished(
                self.api, owner_id, held_by.get("commitSha"), read_intents(metadata), owner_api_region(held_by)
            ):
                self.delete_generation(metadata["generation"], metadata["metageneration"])
                continue
            print("Waiting for the production deployment and its asynchronous operations.", flush=True)
            self.sleep(10)
        raise RuntimeError("Timed out waiting for the production deployment lease.")

    def release(self):
        if self.generation is not None:
            # A command can fail after its remote operation was accepted. Keep
            # the lease until a later build confirms those operations stopped.
            try:
                metadata = self.api.request("GET", self.object_url + "?ifGenerationMatch=" + self.generation)
                finished = deployment_children_finished(self.api, self.build_id, self.commit, read_intents(metadata), self.api_region)
            except Exception:
                print("Retaining the deployment lease: asynchronous operation status could not be verified.", flush=True)
                return
            if not finished:
                print("Retaining the deployment lease while asynchronous operations remain unsettled.", flush=True)
                return
            deleted = self.delete_generation(self.generation, metadata["metageneration"])
            self.generation = None
            print("Released production deployment lease." if deleted else "Deployment lease changed; it was not deleted.", flush=True)


class ProvisioningLease(ProductionLease):
    def __init__(self, api, workflow_run, commit, sleep=time.sleep):
        if not re.fullmatch(r"[1-9][0-9]*-[1-9][0-9]*", workflow_run) or not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise RuntimeError("A GitHub workflow run, attempt, and full commit SHA are required.")
        super().__init__(api, "", commit, sleep=sleep)
        self.workflow_run = workflow_run

    def owner(self):
        return {"kind": "tenantProvisioning", "workflowRun": self.workflow_run,
                "commitSha": self.commit, "apiRegion": API_REGION,
                "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}

    def note(self, phase):
        metadata = self.api.request("GET", LOCK_URL + "?ifGenerationMatch=" + self.generation)
        owner = self.api.request("GET", LOCK_URL + "?alt=media&generation=" + self.generation)
        if owner.get("kind") != "tenantProvisioning" or owner.get("workflowRun") != self.workflow_run or owner.get("commitSha") != self.commit:
            raise RuntimeError("The provisioning lease changed ownership.")
        custom = dict(metadata.get("metadata", {}))
        custom["tenantProvisioningPhase"] = phase
        self.api.request("PATCH", LOCK_URL + "?ifGenerationMatch=" + self.generation
                         + "&ifMetagenerationMatch=" + str(metadata["metageneration"]), {"metadata": custom})

    def release(self):
        if self.generation is not None:
            metadata = self.api.request("GET", LOCK_URL + "?ifGenerationMatch=" + self.generation)
            if not self.delete_generation(self.generation, metadata["metageneration"]):
                raise RuntimeError("The provisioning lease changed before release.")
            self.generation = None
            print("Released tenant provisioning lease.", flush=True)


def verify_provisioning_image(api):
    """Use the exact image serving Tokyo, never an unbuilt GitHub SHA tag."""
    base = f"projects/{PROJECT}/locations/{API_REGION}/services/reservation-api"
    service = api.request("GET", "https://run.googleapis.com/v2/" + base)
    def revision_name(name):
        if not isinstance(name, str):
            return ""
        if re.fullmatch(r"reservation-api-[a-z0-9-]+", name):
            return base + "/revisions/" + name
        canonical = canonical_resource(name)
        return canonical if re.fullmatch(re.escape(base) + r"/revisions/reservation-api-[a-z0-9-]+", canonical) else ""
    ready = revision_name(service.get("latestReadyRevision"))
    traffic = service.get("trafficStatuses", [])
    if (service.get("reconciling", False) is not False
            or service.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED"
            or not service.get("generation") or str(service.get("observedGeneration")) != str(service.get("generation"))
            or not ready or ready != revision_name(service.get("latestCreatedRevision"))
            or sum(item.get("percent", 0) for item in traffic) != 100
            or sum(item.get("percent", 0) for item in traffic if revision_name(item.get("revision")) == ready) != 100):
        raise RuntimeError("Tenant provisioning requires a fully ready Tokyo API serving all traffic.")
    revision = api.request("GET", "https://run.googleapis.com/v2/" + ready)
    containers = revision.get("containers", [])
    image_prefix = f"{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/reservation-api@"
    if len(containers) != 1 or not re.fullmatch(re.escape(image_prefix) + r"sha256:[0-9a-f]{64}", containers[0].get("image", "")):
        raise RuntimeError("The active Tokyo API revision must have a fixed API image digest.")
    if revision.get("serviceAccount") != f"reservation-api-runtime@{PROJECT}.iam.gserviceaccount.com":
        raise RuntimeError("The active Tokyo API has an unexpected runtime identity.")
    env = {item.get("name"): item for item in containers[0].get("env", [])}
    secret = env.get("DATABASE_URL", {}).get("valueSource", {}).get("secretKeyRef", {})
    if secret.get("secret") not in ("reservation-database-url-tokyo", f"projects/{PROJECT}/secrets/reservation-database-url-tokyo", "projects/42401528382/secrets/reservation-database-url-tokyo") or secret.get("version") != "1":
        raise RuntimeError("The active Tokyo API must use the approved pinned database secret.")
    return containers[0]["image"]


def run_provisioning(api, workflow_run, commit, values, sleep=time.sleep):
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", values.get("OWNER_EMAIL", "")) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", values.get("TENANT_SLUG", "")) or not 3 <= len(values.get("TENANT_SLUG", "")) <= 50:
        raise RuntimeError("Invalid tenant owner email or slug.")
    for key in ("OWNER_EMAIL", "OWNER_DISPLAY_NAME", "TENANT_NAME", "TENANT_SLUG", "SALON_NAME", "TIMEZONE"):
        value = values.get(key, "")
        if not isinstance(value, str) or len(value) > 255 or any(ord(char) < 32 for char in value) or (key != "OWNER_DISPLAY_NAME" and not value.strip()):
            raise RuntimeError("Invalid tenant provisioning input.")
    try:
        zoneinfo.ZoneInfo(values["TIMEZONE"])
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        raise RuntimeError("Invalid tenant timezone.") from None
    lease = ProvisioningLease(api, workflow_run, commit, sleep=sleep)
    lease.acquire(wait_seconds=300)
    requested = False
    completed = False
    job_name = f"projects/{PROJECT}/locations/{API_REGION}/jobs/reservation-tenant-provision"
    job_url = "https://run.googleapis.com/v2/" + job_name
    try:
        image = verify_provisioning_image(api)
        try:
            before = api.request("GET", job_url)
            baseline = int(before["generation"])
            if before.get("reconciling", False) or before.get("latestCreatedExecution", {}).get("completionStatus", "EXECUTION_SUCCEEDED") not in {"EXECUTION_SUCCEEDED", "EXECUTION_FAILED", "EXECUTION_CANCELLED"}:
                requested = True
                raise RuntimeError("A tenant provisioning job is already running.")
        except ApiError as error:
            if error.status != 404:
                raise
            baseline = 0
        # JSON is also valid YAML and safely preserves commas/pipes in names.
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as env_file:
            json.dump({"PROVISION_" + key: value for key, value in values.items()}, env_file)
            env_file.flush()
            lease.note("jobDeployRequested")
            requested = True
            command = ["gcloud", "run", "jobs", "deploy", "reservation-tenant-provision", f"--project={PROJECT}",
                       f"--region={API_REGION}", "--image=" + image,
                       f"--service-account=reservation-provisioner@{PROJECT}.iam.gserviceaccount.com",
                       "--network=salon-reserve-vpc", "--subnet=salon-reserve-run-asia-northeast1", "--vpc-egress=private-ranges-only",
                       "--set-secrets=DATABASE_URL=reservation-database-url-tokyo:1", "--env-vars-file=" + env_file.name,
                       "--labels=tenant-provision-run=" + workflow_run, "--command=npm", "--args=run,tenant:provision",
                       "--tasks=1", "--max-retries=0", "--task-timeout=10m", "--cpu=1", "--memory=512Mi", "--quiet"]
            try:
                subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                raise RuntimeError("Tenant provisioning job deployment could not be verified.") from None
        job = api.request("GET", job_url)
        template = job.get("template", {}).get("template", {})
        containers = template.get("containers", [])
        if int(job.get("generation", 0)) <= baseline or job.get("labels", {}).get("tenant-provision-run") != workflow_run or job.get("reconciling", False) or job.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED" or len(containers) != 1 or containers[0].get("image") != image:
            raise RuntimeError("Tenant provisioning job does not match this workflow's requested generation and image.")
        database = [item for item in containers[0].get("env", []) if item.get("name") == "DATABASE_URL"]
        secret = database[0].get("valueSource", {}).get("secretKeyRef", {}) if len(database) == 1 else {}
        allowed_secrets = {"reservation-database-url-tokyo", *(f"projects/{project}/secrets/reservation-database-url-tokyo" for project in (PROJECT, "42401528382"))}
        if template.get("serviceAccount") != f"reservation-provisioner@{PROJECT}.iam.gserviceaccount.com" or secret.get("secret") not in allowed_secrets or secret.get("version") != "1" or "value" in database[0]:
            raise RuntimeError("Tenant provisioning job must use the approved identity and pinned Tokyo database secret.")
        vpc = template.get("vpcAccess", {})
        interfaces = vpc.get("networkInterfaces", [])
        allowed_networks = {"salon-reserve-vpc", *(f"projects/{project}/global/networks/salon-reserve-vpc" for project in (PROJECT, "42401528382"))}
        allowed_subnets = {"salon-reserve-run-asia-northeast1", *(f"projects/{project}/regions/{API_REGION}/subnetworks/salon-reserve-run-asia-northeast1" for project in (PROJECT, "42401528382"))}
        if vpc.get("connector") or vpc.get("egress") != "PRIVATE_RANGES_ONLY" or len(interfaces) != 1 or interfaces[0].get("network") not in allowed_networks or interfaces[0].get("subnetwork") not in allowed_subnets or any(volume.get("cloudSqlInstance") for volume in template.get("volumes", [])):
            raise RuntimeError("Tenant provisioning job must use the approved Tokyo Direct VPC attachment.")
        lease.note("jobExecutionRequested")
        operation = api.request("POST", job_url + ":run", {})
        operation_name = operation.get("name", "")
        if not re.fullmatch(r"projects/(?:salon-reserve-bg|42401528382)/locations/asia-northeast1/operations/[A-Za-z0-9_-]+", operation_name):
            raise RuntimeError("Unexpected tenant provisioning operation.")
        for _ in range(121):
            operation = api.request("GET", "https://run.googleapis.com/v2/" + operation_name)
            if operation.get("done"):
                if operation.get("error"):
                    raise RuntimeError("Tenant provisioning execution failed; the lease is retained for review.")
                break
            sleep(5)
        else:
            raise RuntimeError("Tenant provisioning execution timed out; the lease is retained for review.")
        execution_name = canonical_resource(operation.get("response", {}).get("name", ""))
        if not re.fullmatch(re.escape(job_name) + r"/executions/reservation-tenant-provision-[a-z0-9-]+", execution_name):
            raise RuntimeError("Unexpected tenant provisioning execution resource.")
        execution = api.request("GET", "https://run.googleapis.com/v2/" + execution_name)
        actual = execution.get("template", {}).get("containers", [])
        if not execution.get("completionTime") or execution.get("reconciling", False) or execution.get("runningCount", 0) != 0 or execution.get("succeededCount") != 1 or execution.get("failedCount", 0) or execution.get("cancelledCount", 0) or len(actual) != 1 or actual[0].get("image") != image:
            raise RuntimeError("Tenant provisioning did not complete successfully with the verified API image.")
        completed = True
        print("Tenant provisioning completed using the active Tokyo API image.", flush=True)
    finally:
        if not requested or completed:
            lease.release()
        else:
            print("Retaining the production lease: tenant provisioning requires operator review.", flush=True)


def latest_main_commit(api, repository_link):
    linked = api.request("GET", "https://developerconnect.googleapis.com/v1/" + repository_link)
    if linked.get("cloneUri", "").removesuffix(".git") != REPOSITORY.removesuffix(".git"):
        raise RuntimeError("The repository link must point to OIDEMA/salon-reservation-system.")
    # This approved repository is public. Verify its branch without minting a
    # repository token or giving the deployment account Git credential access.
    git_env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="/bin/false")
    result = subprocess.run(
        ["git", "-c", "credential.helper=", "ls-remote", "--exit-code", REPOSITORY, "refs/heads/main"],
        env=git_env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
    )
    if result.returncode:
        raise RuntimeError("Unable to verify the current main commit.")
    fields = result.stdout.strip().split()
    if len(fields) != 2 or not re.fullmatch(r"[0-9a-f]{40}", fields[0]) or fields[1] != "refs/heads/main":
        raise RuntimeError("The main branch returned an unexpected commit reference.")
    return fields[0]


def run_deployment(api, build_id, commit, repository_link, deploy, get_head=latest_main_commit):
    lease = ProductionLease(api, build_id, commit)
    lease.acquire()
    try:
        if get_head(api, repository_link) != commit:
            print("Skipping an obsolete commit; a newer main commit owns production deployment.", flush=True)
            return False
        deploy(lease.generation)
        return True
    finally:
        lease.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command")
    marker = commands.add_parser("mark-intent", help="Record a phase before its cloud mutation")
    marker.add_argument("--generation", required=True)
    marker.add_argument("--phase", required=True, choices=INTENT_PHASES)
    marker.add_argument("--baseline")
    commands.add_parser("provision-tenant", help="Provision with the active Tokyo image under the production lease")
    args = parser.parse_args()
    build_id = os.environ.get("BUILD_ID", "")
    commit = os.environ.get("COMMIT_SHA", "")
    repository_link = os.environ.get("GIT_REPOSITORY_LINK", "")
    if os.environ.get("PROJECT_ID") != PROJECT or os.environ.get("REGION") != REGION or os.environ.get("API_REGION") != API_REGION:
        raise SystemExit("Unapproved deployment project or region.")
    if args.command == "provision-tenant":
        workflow_run = os.environ.get("GITHUB_RUN_ID", "") + "-" + os.environ.get("GITHUB_RUN_ATTEMPT", "")
        values = {key: os.environ.get(key, "") for key in ("OWNER_EMAIL", "OWNER_DISPLAY_NAME", "TENANT_NAME", "TENANT_SLUG", "SALON_NAME", "TIMEZONE")}
        run_provisioning(GoogleApi(), workflow_run, os.environ.get("GITHUB_SHA", ""), values)
        return
    if not re.fullmatch(UUID_PATTERN, build_id) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise SystemExit("A Cloud Build UUID and full commit SHA are required.")
    if not re.fullmatch(r"projects/(?:salon-reserve-bg|42401528382)/locations/asia-east1/connections/[^/]+/gitRepositoryLinks/[^/]+", repository_link):
        raise SystemExit("An approved Firebase Git repository link is required.")
    api = GoogleApi()
    if args.command == "mark-intent":
        if not re.fullmatch(r"[1-9][0-9]*", args.generation):
            raise SystemExit("A valid lease generation is required.")
        # A stale helper invocation must not annotate a different build's lease.
        owner = api.request("GET", LOCK_URL + "?alt=media&generation=" + args.generation)
        if owner.get("buildId") != build_id or owner.get("commitSha") != commit:
            raise SystemExit("The deployment lease does not belong to this build.")
        mark_deployment_intent(api, args.generation, args.phase, args.baseline)
        return

    def deploy(generation):
        deploy_env = dict(os.environ, NATIVE_DEPLOY_LOCK_GENERATION=generation)
        subprocess.run(["bash", "scripts/deploy-native.sh"], env=deploy_env, check=True)

    run_deployment(api, build_id, commit, repository_link, deploy)


if __name__ == "__main__":
    main()
