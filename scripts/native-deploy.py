#!/usr/bin/env python3
"""Serialize production rollouts and skip obsolete main commits.

The lease is a generation-guarded object in a private deployment lock bucket.
It never touches App Hosting sources or clinical photographs.
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

PROJECT = "salon-reserve-bg"
REGION = "asia-east1"
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
    "appBuildRequested": None,
    "appRolloutRequested": None,
}
EXECUTION_PATTERN = r"projects/(?:salon-reserve-bg|42401528382)/locations/asia-east1/jobs/reservation-db-migrate/executions/[a-z0-9-]+"


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


def execution_resource(name):
    if not isinstance(name, str):
        return None
    if re.fullmatch(r"reservation-db-migrate-[a-z0-9-]+", name):
        return f"projects/{PROJECT}/locations/{REGION}/jobs/reservation-db-migrate/executions/{name}"
    if re.fullmatch(EXECUTION_PATTERN, name):
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
    intents = read_intents(metadata)
    if phase in intents:
        # After an ambiguous response, repeating the cloud mutation could create
        # two executions. A new build/lease or operator review is required.
        raise RuntimeError("A deployment phase has already been requested and cannot be repeated.")
    if phase == "jobExecutionRequested":
        # Execution.image is digest-pinned by Cloud Run even when Job.image uses
        # a tag. Record the expected digest before starting the asynchronous run.
        image = f"{REGION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/reservation-api:{owner['commitSha']}-{owner['buildId']}"
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
        intent["expectedExecutionDigest"] = digest
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


def deployment_children_finished(api, build_id, commit=None, intents=None):
    """A stopped Cloud Build does not imply its asynchronous children stopped.

    An absent resource or an unchanged Run snapshot cannot discharge recorded
    intent: the mutation may have been accepted but not yet become visible.
    PAUSED/unknown states and unreadable resources also retain the lease.
    """
    intents = intents or {}
    backend = f"projects/{PROJECT}/locations/{REGION}/backends/salon-reserve-web"
    for resource_type, phase, terminal_states in (
        ("builds", "appBuildRequested", {"READY", "FAILED", "SKIPPED", "EXPIRED"}),
        ("rollouts", "appRolloutRequested", {"SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"}),
    ):
        try:
            resource = api.request(
                "GET", f"https://firebaseapphosting.googleapis.com/v1beta/{backend}/{resource_type}/native-{build_id}"
            )
        except ApiError as error:
            if error.status == 404:
                if phase in intents:
                    return False
                continue
            raise
        if resource.get("state") not in terminal_states:
            return False

    run_base = f"https://run.googleapis.com/v2/projects/{PROJECT}/locations/{REGION}"
    job = api.request("GET", run_base + "/jobs/reservation-db-migrate")
    if "jobDeployRequested" in intents and not owns_run_resource(
        job, build_id, commit, intents["jobDeployRequested"]["baselineGeneration"]
    ):
        return False
    if job.get("reconciling", False) is not False or job.get("terminalCondition", {}).get("state") not in TERMINAL_RUN_CONDITIONS:
        return False
    latest = job.get("latestCreatedExecution")
    if "jobExecutionRequested" in intents:
        execution_intent = intents["jobExecutionRequested"]
        if not latest or not execution_resource(latest.get("name")) or execution_resource(latest.get("name")) == execution_resource(execution_intent["baselineExecution"]):
            return False
        if not matches_run_owner(job, build_id, commit):
            return False
    if latest:
        if latest.get("completionStatus") not in {"EXECUTION_SUCCEEDED", "EXECUTION_FAILED", "EXECUTION_CANCELLED"}:
            return False
        execution_name = execution_resource(latest.get("name"))
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

    service = api.request("GET", run_base + "/services/reservation-api")
    if "apiDeployRequested" in intents and not owns_run_resource(
        service, build_id, commit, intents["apiDeployRequested"]["baselineGeneration"]
    ):
        return False
    return (
        service.get("reconciling", False) is False
        and service.get("terminalCondition", {}).get("state") in TERMINAL_RUN_CONDITIONS
    )


class ProductionLease:
    def __init__(self, api, build_id, commit, sleep=time.sleep):
        self.api = api
        self.build_id = build_id
        self.commit = commit
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

    def acquire(self, wait_seconds=3600):
        deadline = time.monotonic() + wait_seconds
        owner = {
            "buildId": self.build_id,
            "commitSha": self.commit,
            "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
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
            if not re.fullmatch(UUID_PATTERN, owner_id):
                raise RuntimeError("The deployment lease has an unrecognized owner; operator review is required.")
            status = self.api.request(
                "GET", f"https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}/builds/{owner_id}"
            ).get("status")
            if status in TERMINAL_BUILD_STATES and deployment_children_finished(
                self.api, owner_id, held_by.get("commitSha"), read_intents(metadata)
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
                finished = deployment_children_finished(self.api, self.build_id, self.commit, read_intents(metadata))
            except Exception:
                print("Retaining the deployment lease: asynchronous operation status could not be verified.", flush=True)
                return
            if not finished:
                print("Retaining the deployment lease while asynchronous operations remain unsettled.", flush=True)
                return
            deleted = self.delete_generation(self.generation, metadata["metageneration"])
            self.generation = None
            print("Released production deployment lease." if deleted else "Deployment lease changed; it was not deleted.", flush=True)


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
    args = parser.parse_args()
    build_id = os.environ.get("BUILD_ID", "")
    commit = os.environ.get("COMMIT_SHA", "")
    repository_link = os.environ.get("GIT_REPOSITORY_LINK", "")
    if os.environ.get("PROJECT_ID") != PROJECT or os.environ.get("REGION") != REGION:
        raise SystemExit("Unapproved deployment project or region.")
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
