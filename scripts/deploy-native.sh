#!/usr/bin/env bash

set -euo pipefail

if [[ $# -eq 1 && "$1" == "--check" ]]; then
  export DEPLOY_PREFLIGHT_ONLY=1
elif [[ $# -ne 0 ]]; then
  echo "Usage: deploy-native.sh [--check]" >&2
  exit 2
fi

# native-deploy.py must hold the production lease before invoking this script.
# All images use the triggering commit and build; services receive fixed digests.
python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request


def required(name):
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"Missing deployment setting: {name}")
    return value


expected = {
    "PROJECT_ID": "salon-reserve-bg",
    "PROJECT_NUMBER": "42401528382",
    "REGION": "asia-east1",
    "API_SERVICE": "reservation-api",
    "API_REGION": "asia-northeast1",
    "DATABASE_URL_SECRET": "reservation-database-url-tokyo:1",
    "INVITATION_TOKEN_KEY_SECRET": "reservation-invitation-token-key:1",
    "SES_ROLE_ARN": "arn:aws:iam::243110548344:role/salon-reserve-ses-sender",
    "API_RELAY_SERVICE_ACCOUNT": "reservation-api-relay@salon-reserve-bg.iam.gserviceaccount.com",
    "CHART_PHOTOS_BUCKET": "salon-reserve-bg-chart-photos",
    "API_RUNTIME_SERVICE_ACCOUNT": "reservation-api-runtime@salon-reserve-bg.iam.gserviceaccount.com",
    "EMAIL_RUNTIME_SERVICE_ACCOUNT": "reservation-email-runtime@salon-reserve-bg.iam.gserviceaccount.com",
    "DB_INSTANCE": "salon-reserve-db-tokyo",
    "VPC_NETWORK": "salon-reserve-vpc",
    "VPC_SUBNET": "salon-reserve-run-asia-northeast1",
    "APP_HOSTING_BACKEND": "salon-reserve-web",
    "WEB_REGION": "asia-northeast1",
    "WEB_SERVICE": "salon-reserve-web",
    "WEB_RUNTIME_SERVICE_ACCOUNT": "firebase-app-hosting-compute@salon-reserve-bg.iam.gserviceaccount.com",
}
for key, value in expected.items():
    if required(key) != value:
        raise SystemExit(f"Unapproved deployment setting: {key}")

commit = required("COMMIT_SHA")
build_id = required("BUILD_ID")
repository_link = required("GIT_REPOSITORY_LINK")
if not re.fullmatch(r"[0-9a-f]{40}", commit):
    raise SystemExit("COMMIT_SHA must be a full commit SHA.")
if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", build_id):
    raise SystemExit("BUILD_ID must be the Cloud Build UUID.")
if not re.fullmatch(
    r"projects/(?:salon-reserve-bg|42401528382)/locations/asia-east1/connections/[^/]+/gitRepositoryLinks/[^/]+",
    repository_link,
):
    raise SystemExit("Unapproved Git repository link.")

project = expected["PROJECT_ID"]
region = expected["REGION"]
api_region = expected["API_REGION"]
image = f"{region}-docker.pkg.dev/{project}/cloud-run-source-deploy/reservation-api:{commit}-{build_id}"
api_image_repository = f"{region}-docker.pkg.dev/{project}/cloud-run-source-deploy/reservation-api"
if required("API_IMAGE") != image:
    raise SystemExit("API_IMAGE must identify the triggering commit and build in the approved registry.")
web_image_repository = f"{region}-docker.pkg.dev/{project}/cloud-run-source-deploy/reservation-web"
web_image = f"{web_image_repository}:{commit}-{build_id}"
if required("WEB_IMAGE") != web_image:
    raise SystemExit("WEB_IMAGE must identify the triggering commit and build in the approved registry.")
redirect_image_repository = f"{region}-docker.pkg.dev/{project}/cloud-run-source-deploy/reservation-redirect"
redirect_image = f"{redirect_image_repository}:{commit}-{build_id}"
if required("REDIRECT_IMAGE") != redirect_image:
    raise SystemExit("REDIRECT_IMAGE must identify the triggering commit and build in the approved registry.")
api_url = "https://reservation-api-42401528382.asia-northeast1.run.app"
email_job_name = "reservation-email-outbox"
relay_image_repository = f"{region}-docker.pkg.dev/{project}/cloud-run-source-deploy/reservation-api-relay"
relay_image = f"{relay_image_repository}:{commit}-{build_id}"
if required("API_RELAY_IMAGE") != relay_image:
    raise SystemExit("API_RELAY_IMAGE must identify the triggering commit and build in the approved registry.")
frontend_url = "https://salon-reserve.beauty-gum.jp"
frontend_fallback_url = "https://salon-reserve-web-42401528382.asia-northeast1.run.app"
legacy_url = "https://salon-reserve-web--salon-reserve-bg.asia-east1.hosted.app"
if os.environ.get("DEPLOY_PREFLIGHT_ONLY") != "1" and not re.fullmatch(r"[1-9][0-9]*", os.environ.get("NATIVE_DEPLOY_LOCK_GENERATION", "")):
    raise SystemExit("A production deployment lease generation is required; invoke native-deploy.py.")

redirect_config = json.loads(Path("scripts/apphosting-redirect-config.json").read_text())
if redirect_config != {
    "runConfig": {"minInstances": 0, "maxInstances": 1, "concurrency": 80, "cpu": 1, "memoryMib": 512},
    "env": [{"variable": "REDIRECT_ORIGIN", "value": frontend_url, "availability": ["RUNTIME"]}],
}:
    raise SystemExit("App Hosting redirect configuration must use the approved destination and runtime limits.")
web_env = json.loads(Path("scripts/web-runtime-env.json").read_text())
approved_env = {
    "APP_PUBLIC_ORIGIN", "APP_PUBLIC_ORIGINS", "NEXT_PUBLIC_API_BASE_URL", "NEXT_PUBLIC_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_APP_ID", "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
}
if not isinstance(web_env, dict) or set(web_env) != approved_env or any(
    not isinstance(value, str) or not value or "|" in value for value in web_env.values()
) or web_env["APP_PUBLIC_ORIGIN"] != frontend_url or web_env["APP_PUBLIC_ORIGINS"] != f"{frontend_url},{frontend_fallback_url}" or web_env["NEXT_PUBLIC_API_BASE_URL"] != api_url or web_env["NEXT_PUBLIC_FIREBASE_PROJECT_ID"] != project or web_env["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"] != f"{project}.firebaseapp.com":
    raise SystemExit("Cloud Run web environment must contain only approved public settings and origins.")


def gcloud(*args, capture=False):
    result = subprocess.run(
        ["gcloud", *args], check=True, text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout if capture else None


def gcloud_json(*args):
    return json.loads(gcloud(*args, "--format=json", capture=True))


token = ""
token_time = 0.0


def sanitized_message(value):
    if not isinstance(value, str):
        return ""
    if token:
        value = value.replace(token, "[redacted]")
    # Only display the message field, never response/request headers or details.
    value = re.sub(r"(?im)^.*\b(?:headers?|authorization|proxy-authorization|cookie|set-cookie)\s*[\":={].*$", "[redacted headers]", value)
    value = re.sub(r"(?i)\bBearer\s+[^\s\"'<>]+", "Bearer [redacted]", value)
    value = re.sub(r"\bya29\.[A-Za-z0-9._~-]+", "[redacted]", value)
    value = re.sub(r"\bey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[redacted]", value)
    value = re.sub(r"(?i)\b(?:access_token|refresh_token|id_token|api_key|x-api-key)\s*[:=]\s*[^\s\"'<>]+", "[redacted]", value)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", value)
    return " ".join(value.split())[:1200]


class DeploymentApiError(RuntimeError):
    def __init__(self, status, method, url, message=""):
        self.status = status
        detail = sanitized_message(message)
        suffix = f": {detail}" if detail else ""
        super().__init__(f"Deployment API request failed: {method} {url}, HTTP {status}{suffix}")


def api_request(method, url, payload=None):
    global token, token_time
    if not token or time.monotonic() - token_time > 2400:
        token = gcloud("auth", "print-access-token", capture=True).strip()
        token_time = time.monotonic()
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        message = ""
        try:
            body = json.loads(error.read(65536).decode("utf-8"))
            if isinstance(body, dict) and isinstance(body.get("error"), dict):
                message = body["error"].get("message", "")
        except (ValueError, UnicodeError):
            pass
        raise DeploymentApiError(error.code, method, url, message) from None


app_hosting_api = "https://firebaseapphosting.googleapis.com/v1beta"
backend_path = f"projects/{project}/locations/{region}/backends/{expected['APP_HOSTING_BACKEND']}"


def resource_name(name):
    if not isinstance(name, str):
        return ""
    parts = name.split("/")
    if len(parts) < 2 or parts[0] != "projects" or parts[1] not in (project, expected["PROJECT_NUMBER"]):
        return ""
    # Google APIs can canonicalize the project ID to its numeric identifier.
    parts[1] = project
    return "/".join(parts)


def validate_source(resource):
    source = resource.get("source")
    container = source.get("container") if isinstance(source, dict) else None
    if not isinstance(container, dict) or container.get("image") != redirect_image_digest or "codebase" in source:
        raise RuntimeError("App Hosting source must use the verified container digest from the triggering commit and build.")
    # Keep the original repository connection protected even though the build
    # source is now the immutable image produced by this Cloud Build run.
    fresh_backend = api_request("GET", f"{app_hosting_api}/{backend_path}")
    fresh_codebase = fresh_backend.get("codebase")
    if not isinstance(fresh_codebase, dict) or resource_name(fresh_codebase.get("repository")) != resource_name(repository_link) or fresh_codebase.get("rootDirectory") != "apps/web":
        raise RuntimeError("App Hosting source connection changed since deployment preflight.")
    if fresh_backend.get("runtime", {}).get("value") != "nodejs":
        raise RuntimeError("App Hosting container builds require the nodejs backend runtime.")
    fresh_link = api_request("GET", f"https://developerconnect.googleapis.com/v1/{repository_link}")
    if fresh_link.get("cloneUri") not in (
        "https://github.com/OIDEMA/salon-reservation-system.git",
        "https://github.com/OIDEMA/salon-reservation-system",
    ):
        raise RuntimeError("App Hosting source connection must still reference the approved GitHub repository.")


backend = api_request("GET", f"{app_hosting_api}/{backend_path}")
codebase = backend.get("codebase", {})
if resource_name(codebase.get("repository")) != resource_name(repository_link) or codebase.get("rootDirectory") != "apps/web":
    raise SystemExit("App Hosting must be connected to the approved repository link at apps/web.")
if backend.get("runtime", {}).get("value") != "nodejs":
    raise SystemExit("App Hosting container builds require the nodejs backend runtime.")
traffic = api_request("GET", f"{app_hosting_api}/{backend_path}/traffic")
if traffic.get("rolloutPolicy", {}).get("disabled") is not True:
    raise SystemExit("App Hosting automatic rollouts must be disabled for the ordered production deployment.")
linked_repository = api_request("GET", f"https://developerconnect.googleapis.com/v1/{repository_link}")
if linked_repository.get("cloneUri") not in (
    "https://github.com/OIDEMA/salon-reservation-system.git",
    "https://github.com/OIDEMA/salon-reservation-system",
):
    raise SystemExit("Developer Connect must reference OIDEMA/salon-reservation-system.")

sql = gcloud_json("sql", "instances", "describe", expected["DB_INSTANCE"], f"--project={project}")
ip_config = sql.get("settings", {}).get("ipConfiguration", {})
if sql.get("region") != api_region or sql.get("databaseVersion") != "POSTGRES_16" or sql.get("state") != "RUNNABLE" or sql.get("instanceType") != "CLOUD_SQL_INSTANCE" or sql.get("masterInstanceName"):
    raise SystemExit("The production database must be a runnable PostgreSQL 16 primary in the API region.")
if ip_config.get("ipv4Enabled") is not False or ip_config.get("privateNetwork") != f"projects/{project}/global/networks/{expected['VPC_NETWORK']}":
    raise SystemExit("The database must use only the approved private network.")
bucket = gcloud_json("storage", "buckets", "describe", f"gs://{expected['CHART_PHOTOS_BUCKET']}", f"--project={project}")
if bucket.get("uniform_bucket_level_access") is not True or bucket.get("public_access_prevention") != "enforced":
    raise SystemExit("Chart photo storage must have uniform access and enforced public access prevention.")

if os.environ.get("DEPLOY_PREFLIGHT_ONLY") == "1":
    print("Production deployment target, repository, private database and photo storage verified.")
    raise SystemExit(0)

# Preflight runs before images exist. Resolve the exact pushed tag only inside
# the deployment lease and before any migration or service mutation.
def resolve_image(tag, repository):
    metadata = gcloud_json("artifacts", "docker", "images", "describe", tag, f"--project={project}")
    summary = metadata.get("image_summary", {})
    digest = summary.get("digest")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise RuntimeError("Artifact Registry must provide the image SHA-256 digest.")
    full_digest = f"{repository}@{digest}"
    if summary.get("fully_qualified_digest") != full_digest:
        raise RuntimeError("Artifact Registry must resolve the image inside the approved repository.")
    return full_digest


web_image_digest = resolve_image(web_image, web_image_repository)
redirect_image_digest = resolve_image(redirect_image, redirect_image_repository)
relay_image_digest = resolve_image(relay_image, relay_image_repository)
api_image_digest = resolve_image(image, api_image_repository)
app_build_id = "native-" + hashlib.sha256(build_id.encode("utf-8")).hexdigest()[:23]
container_build_payload = {"source": {"container": {"image": redirect_image_digest}}, "config": redirect_config}
# Validate the legacy-host redirect before any production mutation.
api_request("POST", f"{app_hosting_api}/{backend_path}/builds?buildId={app_build_id}&validateOnly=true", container_build_payload)


def mark_intent(phase, baseline=None):
    command = [
        "python3", "scripts/native-deploy.py", "mark-intent",
        "--generation", required("NATIVE_DEPLOY_LOCK_GENERATION"), "--phase", phase,
    ]
    if baseline is not None:
        command.extend(["--baseline", baseline])
    # A failed or ambiguous metadata write must prevent the corresponding mutation.
    subprocess.run(command, check=True)


run_api = f"https://run.googleapis.com/v2/projects/{project}/locations/{api_region}"


def resource_generation(resource):
    generation = str(resource.get("generation", ""))
    if not re.fullmatch(r"[1-9][0-9]*", generation):
        raise RuntimeError("Cloud Run must provide its current resource generation before deployment.")
    return generation


def generation_before_create(url):
    try:
        return resource_generation(api_request("GET", url))
    except DeploymentApiError as error:
        if error.status != 404:
            raise
        return "0"


mark_intent("jobDeployRequested", generation_before_create(f"{run_api}/jobs/reservation-db-migrate"))
gcloud(
    "run", "jobs", "deploy", "reservation-db-migrate",
    f"--project={project}", f"--region={api_region}", f"--image={image}",
    f"--service-account={expected['API_RUNTIME_SERVICE_ACCOUNT']}",
    f"--labels=native-deploy-build={build_id}",
    f"--network={expected['VPC_NETWORK']}", f"--subnet={expected['VPC_SUBNET']}",
    "--vpc-egress=private-ranges-only", f"--set-secrets=DATABASE_URL={expected['DATABASE_URL_SECRET']}",
    "--set-env-vars=DB_CONNECTIVITY=private-ip", "--command=npm", "--args=run,prisma:deploy",
    "--tasks=1", "--max-retries=0", "--task-timeout=10m", "--cpu=1", "--memory=512Mi", "--quiet",
)
job_before_execute = api_request("GET", f"{run_api}/jobs/reservation-db-migrate")
execution_baseline = (job_before_execute.get("latestCreatedExecution") or {}).get("name") or ""
if not isinstance(execution_baseline, str):
    raise RuntimeError("Unexpected Cloud Run migration execution resource.")
if execution_baseline and not (
    re.fullmatch(r"reservation-db-migrate-[a-z0-9-]+", execution_baseline)
    or re.fullmatch(
        rf"projects/(?:salon-reserve-bg|42401528382)/locations/{api_region}/jobs/reservation-db-migrate/executions/[^/]+",
        execution_baseline,
    )
):
    raise RuntimeError("Unexpected Cloud Run migration execution resource.")
mark_intent("jobExecutionRequested", execution_baseline)
gcloud("run", "jobs", "execute", "reservation-db-migrate", f"--project={project}", f"--region={api_region}", "--wait")


def verify_private_run(resource):
    annotations = resource.get("spec", {}).get("template", {}).get("metadata", {}).get("annotations", {})
    interfaces = json.loads(annotations.get("run.googleapis.com/network-interfaces", "[]"))
    if annotations.get("run.googleapis.com/cloudsql-instances", "") or not interfaces:
        raise RuntimeError("Cloud Run must use Direct VPC without Cloud SQL socket mounts.")
    if interfaces[0].get("network") != expected["VPC_NETWORK"] or interfaces[0].get("subnetwork") != expected["VPC_SUBNET"]:
        raise RuntimeError("Cloud Run must use the approved VPC network and subnet.")


# Deploy the backward-compatible consumer before the API can emit new payloads.
# Updating a Job leaves its previous executions alive, so verify and drain those
# executions before deploying any producer. The scheduler may keep running.
email_job_url = f"{run_api}/jobs/{email_job_name}"
email_job_baseline = generation_before_create(email_job_url)
mark_intent("emailJobDeployRequested", email_job_baseline)
gcloud(
    "run", "jobs", "deploy", email_job_name,
    f"--project={project}", f"--region={api_region}", f"--image={api_image_digest}",
    f"--service-account={expected['EMAIL_RUNTIME_SERVICE_ACCOUNT']}",
    f"--labels=native-deploy-build={build_id}",
    f"--network={expected['VPC_NETWORK']}", f"--subnet={expected['VPC_SUBNET']}",
    "--vpc-egress=private-ranges-only",
    f"--set-secrets=DATABASE_URL={expected['DATABASE_URL_SECRET']},INVITATION_TOKEN_KEY={expected['INVITATION_TOKEN_KEY_SECRET']}",
    f"--set-env-vars=NODE_ENV=production,DB_CONNECTIVITY=private-ip,AWS_SES_ROLE_ARN={expected['SES_ROLE_ARN']},PUBLIC_BASE_URL={frontend_url}",
    "--command=node", "--args=dist/src/scripts/send-email-outbox.js",
    "--tasks=1", "--max-retries=0", "--task-timeout=10m", "--cpu=1", "--memory=512Mi", "--quiet",
)
verify_private_run(gcloud_json("run", "jobs", "describe", email_job_name, f"--project={project}", f"--region={api_region}"))


def verify_email_job():
    job = api_request("GET", email_job_url)
    if int(resource_generation(job)) <= int(email_job_baseline) or job.get("labels", {}).get("native-deploy-build") != build_id:
        raise RuntimeError("Email Job must belong to this build and advance its generation.")
    if job.get("reconciling", False) is not False or job.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED" or str(job.get("observedGeneration", "")) != str(job.get("generation", "")):
        raise RuntimeError("Email Job must finish reconciling successfully.")
    execution = job.get("template", {})
    task = execution.get("template", {})
    containers = task.get("containers", [])
    if execution.get("taskCount", 1) != 1 or task.get("maxRetries", 0) != 0 or len(containers) != 1 or task.get("serviceAccount") != expected["EMAIL_RUNTIME_SERVICE_ACCOUNT"]:
        raise RuntimeError("Email Job task count, retries, container, or identity changed.")
    network = task.get("vpcAccess", {})
    interfaces = network.get("networkInterfaces", [])
    if network.get("egress") != "PRIVATE_RANGES_ONLY" or len(interfaces) != 1 or interfaces[0].get("network") != expected["VPC_NETWORK"] or interfaces[0].get("subnetwork") != expected["VPC_SUBNET"]:
        raise RuntimeError("Email Job must use the approved Tokyo private network.")
    container = containers[0]
    if container.get("image") != api_image_digest or container.get("command") != ["node"] or container.get("args") != ["dist/src/scripts/send-email-outbox.js"]:
        raise RuntimeError("Email Job must use this build's exact API digest and outbox command.")
    environment = {item.get("name"): item for item in container.get("env", [])}
    if set(environment) != {"NODE_ENV", "DB_CONNECTIVITY", "AWS_SES_ROLE_ARN", "PUBLIC_BASE_URL", "DATABASE_URL", "INVITATION_TOKEN_KEY"}:
        raise RuntimeError("Email Job has unapproved environment settings.")
    expected_values = {"NODE_ENV": "production", "DB_CONNECTIVITY": "private-ip", "AWS_SES_ROLE_ARN": expected["SES_ROLE_ARN"], "PUBLIC_BASE_URL": frontend_url}
    if any(environment[name].get("value") != value or "valueSource" in environment[name] for name, value in expected_values.items()):
        raise RuntimeError("Email Job must use the approved role and public origin.")
    for name, secret_name in (("DATABASE_URL", "reservation-database-url-tokyo"), ("INVITATION_TOKEN_KEY", "reservation-invitation-token-key")):
        item = environment[name]
        secret = item.get("valueSource", {}).get("secretKeyRef", {})
        if secret.get("secret") not in (secret_name, f"projects/{project}/secrets/{secret_name}", f"projects/{expected['PROJECT_NUMBER']}/secrets/{secret_name}") or secret.get("version") != "1" or "value" in item:
            raise RuntimeError("Email Job must use only the approved pinned secrets.")


verify_email_job()


# Share the same fail-closed execution inspection with lease recovery.
import importlib.util
worker_spec = importlib.util.spec_from_file_location("native_deploy", "scripts/native-deploy.py")
worker_deployment = importlib.util.module_from_spec(worker_spec)
worker_spec.loader.exec_module(worker_deployment)
clear_observations = 0
drain_deadline = time.monotonic() + 12 * 60
for drain_attempt in range(73):
    verify_email_job()
    pending = worker_deployment.unfinished_old_email_executions(api_request, api_image_digest, api_region, deadline=drain_deadline)
    clear_observations = clear_observations + 1 if not pending else 0
    if clear_observations >= 2:
        verify_email_job()
        break
    if drain_attempt == 72:
        raise RuntimeError("Previous email worker executions did not drain within 12 minutes; API deployment is blocked.")
    if pending:
        print("Waiting for previous email worker executions: " + ", ".join(pending), flush=True)
    time.sleep(10)


api_resource = f"projects/{project}/locations/{api_region}/services/{expected['API_SERVICE']}"
api_baseline = generation_before_create("https://run.googleapis.com/v2/" + api_resource)
mark_intent("apiDeployRequested", api_baseline)
gcloud(
    "run", "deploy", expected["API_SERVICE"], f"--project={project}", f"--region={api_region}",
    "--platform=managed", f"--image={image}", f"--service-account={expected['API_RUNTIME_SERVICE_ACCOUNT']}",
    f"--labels=native-deploy-build={build_id}",
    "--allow-unauthenticated", f"--network={expected['VPC_NETWORK']}", f"--subnet={expected['VPC_SUBNET']}",
    "--vpc-egress=private-ranges-only", f"--set-secrets=DATABASE_URL={expected['DATABASE_URL_SECRET']},INVITATION_TOKEN_KEY={expected['INVITATION_TOKEN_KEY_SECRET']}",
    f"--set-env-vars=^|^NODE_ENV=production|DB_CONNECTIVITY=private-ip|CHART_PHOTOS_BUCKET={expected['CHART_PHOTOS_BUCKET']}|CORS_ORIGINS={legacy_url},{frontend_fallback_url},{frontend_url}|MEMBER_BOOKING_TENANTS=mens-gentle:gentle;missmrs-takamatsu:missmrs",
    "--cpu=1", "--memory=512Mi", "--min-instances=0", "--max-instances=1", "--concurrency=40",
    "--timeout=60", "--port=8080",
    "--startup-probe=httpGet.path=/ready,httpGet.port=8080,initialDelaySeconds=0,periodSeconds=5,timeoutSeconds=5,failureThreshold=24",
    "--quiet",
)


verify_private_run(gcloud_json("run", "services", "describe", expected["API_SERVICE"], f"--project={project}", f"--region={api_region}"))
verify_private_run(gcloud_json("run", "jobs", "describe", "reservation-db-migrate", f"--project={project}", f"--region={api_region}"))


def api_revision_name(name):
    if not isinstance(name, str):
        return ""
    if re.fullmatch(r"reservation-api-[a-z0-9-]+", name):
        return api_resource + "/revisions/" + name
    canonical = resource_name(name)
    return canonical if re.fullmatch(re.escape(api_resource) + r"/revisions/reservation-api-[a-z0-9-]+", canonical) else ""


def verify_api_identity_and_database(template):
    if template.get("serviceAccount") != expected["API_RUNTIME_SERVICE_ACCOUNT"]:
        raise RuntimeError("Tokyo API must use the approved runtime identity.")
    containers = template.get("containers", [])
    if len(containers) != 1:
        raise RuntimeError("Tokyo API must have exactly one approved container.")
    database = [item for item in containers[0].get("env", []) if item.get("name") == "DATABASE_URL"]
    secret = database[0].get("valueSource", {}).get("secretKeyRef", {}) if len(database) == 1 else {}
    if secret.get("secret") not in ("reservation-database-url-tokyo", f"projects/{project}/secrets/reservation-database-url-tokyo", f"projects/{expected['PROJECT_NUMBER']}/secrets/reservation-database-url-tokyo") or secret.get("version") != "1" or "value" in database[0]:
        raise RuntimeError("Tokyo API must use the approved pinned Tokyo database secret.")
    invitation = [item for item in containers[0].get("env", []) if item.get("name") == "INVITATION_TOKEN_KEY"]
    invitation_secret = invitation[0].get("valueSource", {}).get("secretKeyRef", {}) if len(invitation) == 1 else {}
    if invitation_secret.get("secret") not in ("reservation-invitation-token-key", f"projects/{project}/secrets/reservation-invitation-token-key", f"projects/{expected['PROJECT_NUMBER']}/secrets/reservation-invitation-token-key") or invitation_secret.get("version") != "1" or "value" in invitation[0]:
        raise RuntimeError("Tokyo API must use the approved pinned invitation token key.")


def verify_api_revision():
    service = api_request("GET", "https://run.googleapis.com/v2/" + api_resource)
    template = service.get("template", {})
    containers = template.get("containers", [])
    if int(resource_generation(service)) <= int(api_baseline) or service.get("labels", {}).get("native-deploy-build") != build_id or len(containers) != 1 or containers[0].get("image") != image:
        raise RuntimeError("Tokyo API must use this build's exact image and generation.")
    if service.get("reconciling", False) is not False or service.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED" or str(service.get("observedGeneration", "")) != str(service.get("generation", "")):
        raise RuntimeError("Tokyo API must finish and observe the deployed generation.")
    ready = api_revision_name(service.get("latestReadyRevision"))
    traffic = service.get("trafficStatuses", [])
    if not ready or ready != api_revision_name(service.get("latestCreatedRevision")) or sum(item.get("percent", 0) for item in traffic) != 100 or sum(item.get("percent", 0) for item in traffic if api_revision_name(item.get("revision")) == ready) != 100:
        raise RuntimeError("Tokyo API must route all traffic to its latest ready revision.")
    verify_api_identity_and_database(template)
    revision = api_request("GET", "https://run.googleapis.com/v2/" + ready)
    verify_api_identity_and_database(revision)
    if revision["containers"][0].get("image") != api_image_digest:
        raise RuntimeError("Tokyo API active revision must use the verified API digest.")
    return ready


api_ready_revision = verify_api_revision()


def read_url(url):
    for attempt in range(7):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return response.read().decode("utf-8")
        except (urllib.error.URLError, TimeoutError):
            if attempt == 6:
                raise RuntimeError(f"Deployment health check failed: {url}") from None
            time.sleep(5)


read_url(api_url + "/ready")


legacy_api_resource = f"projects/{project}/locations/{region}/services/{expected['API_SERVICE']}"
relay_baseline = generation_before_create("https://run.googleapis.com/v2/" + legacy_api_resource)
mark_intent("apiRelayDeployRequested", relay_baseline)
gcloud(
    "run", "deploy", expected["API_SERVICE"], f"--project={project}", f"--region={region}",
    "--platform=managed", f"--image={relay_image_digest}", f"--service-account={expected['API_RELAY_SERVICE_ACCOUNT']}",
    f"--labels=native-deploy-build={build_id}", "--allow-unauthenticated", "--ingress=all",
    "--clear-secrets", "--clear-cloudsql-instances", "--clear-network", "--clear-vpc-connector",
    f"--set-env-vars=UPSTREAM_ORIGIN={api_url},MAINTENANCE_MODE=false",
    "--cpu=1", "--memory=512Mi", "--min-instances=0", "--max-instances=1", "--concurrency=40",
    "--timeout=60", "--port=8080",
    "--startup-probe=httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=0,periodSeconds=5,timeoutSeconds=5,failureThreshold=24",
    "--quiet",
)
relay = api_request("GET", "https://run.googleapis.com/v2/" + legacy_api_resource)
relay_template = relay.get("template", {})
relay_containers = relay_template.get("containers", [])
if int(resource_generation(relay)) <= int(relay_baseline) or relay.get("labels", {}).get("native-deploy-build") != build_id or len(relay_containers) != 1 or relay_containers[0].get("image") != relay_image_digest:
    raise RuntimeError("The legacy API must use this build's relay image and generation.")
relay_env = relay_containers[0].get("env", [])
if relay_template.get("serviceAccount") != expected["API_RELAY_SERVICE_ACCOUNT"] or relay_template.get("vpcAccess") or relay_template.get("volumes") or any("valueSource" in item for item in relay_env) or {item.get("name"): item.get("value") for item in relay_env} != {"UPSTREAM_ORIGIN": api_url, "MAINTENANCE_MODE": "false"}:
    raise RuntimeError("The legacy API relay must have no database secrets, volumes, or VPC attachment.")
if relay.get("reconciling", False) is not False or relay.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED":
    raise RuntimeError("The legacy API relay must complete its rollout successfully.")
def relay_revision_name(name):
    if not isinstance(name, str):
        return ""
    if re.fullmatch(r"reservation-api-[a-z0-9-]+", name):
        return legacy_api_resource + "/revisions/" + name
    canonical = resource_name(name)
    return canonical if re.fullmatch(re.escape(legacy_api_resource) + r"/revisions/reservation-api-[a-z0-9-]+", canonical) else ""


relay_ready = relay_revision_name(relay.get("latestReadyRevision"))
relay_traffic = relay.get("trafficStatuses", [])
if str(relay.get("observedGeneration", "")) != str(relay.get("generation", "")) or not relay_ready or relay_ready != relay_revision_name(relay.get("latestCreatedRevision")) or sum(item.get("percent", 0) for item in relay_traffic) != 100 or sum(item.get("percent", 0) for item in relay_traffic if relay_revision_name(item.get("revision")) == relay_ready) != 100:
    raise RuntimeError("The legacy API must send all traffic to the observed relay revision.")
relay_revision = api_request("GET", "https://run.googleapis.com/v2/" + relay_ready)
if len(relay_revision.get("containers", [])) != 1 or relay_revision["containers"][0].get("image") != relay_image_digest:
    raise RuntimeError("The legacy API active revision must use the verified relay digest.")
read_url(f"https://reservation-api-{expected['PROJECT_NUMBER']}.{region}.run.app/ready")


def wait_operation(operation_name, label):
    allowed_projects = (project, expected["PROJECT_NUMBER"])
    if not any(operation_name.startswith(f"projects/{name}/locations/{region}/operations/") for name in allowed_projects):
        raise RuntimeError(f"Unexpected operation name for {label}.")
    for _ in range(150):
        response = api_request("GET", f"{app_hosting_api}/{operation_name}")
        if response.get("done") is True:
            if response.get("error"):
                error = response["error"]
                code = error.get("code") if isinstance(error.get("code"), int) else "unknown"
                raise RuntimeError(f"{label} failed with code {code}: {sanitized_message(error.get('message', ''))}")
            return
        time.sleep(10)
    raise RuntimeError(f"Timed out waiting for {label}.")


def wait_state(path, state, label, attempts=120, delay=5):
    wanted = {state} if isinstance(state, str) else set(state)
    for _ in range(attempts):
        try:
            resource = api_request("GET", f"{app_hosting_api}/{path}")
        except DeploymentApiError as error:
            if error.status != 404:
                raise
            # The resource can become visible after its creation was accepted.
            time.sleep(delay)
            continue
        current = resource.get("state", "UNKNOWN")
        if current in wanted:
            return resource
        if current in ("FAILED", "CANCELLED", "PAUSED"):
            raise RuntimeError(f"{label} entered terminal state {current}.")
        time.sleep(delay)
    raise RuntimeError(f"Timed out waiting for {label} to reach {' or '.join(sorted(wanted))}.")


web_resource = f"projects/{project}/locations/{expected['WEB_REGION']}/services/{expected['WEB_SERVICE']}"
try:
    web_before = api_request("GET", f"https://run.googleapis.com/v2/{web_resource}")
    web_baseline = resource_generation(web_before)
except DeploymentApiError as error:
    if error.status != 404:
        raise
    web_baseline = "0"
mark_intent("webDeployRequested", web_baseline)
gcloud(
    "run", "deploy", expected["WEB_SERVICE"], f"--project={project}", f"--region={expected['WEB_REGION']}",
    "--platform=managed", f"--image={web_image_digest}",
    f"--service-account={expected['WEB_RUNTIME_SERVICE_ACCOUNT']}",
    f"--labels=native-deploy-build={build_id}", "--allow-unauthenticated", "--ingress=all",
    "--set-env-vars=^|^" + "|".join(f"{key}={value}" for key, value in web_env.items()),
    "--cpu=1", "--memory=512Mi", "--min-instances=0", "--max-instances=1", "--concurrency=80",
    "--timeout=60", "--port=8080",
    "--startup-probe=httpGet.path=/login,httpGet.port=8080,initialDelaySeconds=0,periodSeconds=5,timeoutSeconds=5,failureThreshold=24",
    "--quiet",
)


def web_revision_name(name):
    if not isinstance(name, str):
        return ""
    if re.fullmatch(re.escape(expected["WEB_SERVICE"]) + r"-[a-z0-9-]+", name):
        return f"{web_resource}/revisions/{name}"
    canonical = resource_name(name)
    if re.fullmatch(re.escape(web_resource) + r"/revisions/" + re.escape(expected["WEB_SERVICE"]) + r"-[a-z0-9-]+", canonical):
        return canonical
    return ""


def verify_web_revision():
    service = api_request("GET", f"https://run.googleapis.com/v2/{web_resource}")
    template = service.get("template", {})
    containers = template.get("containers", [])
    if int(resource_generation(service)) <= int(web_baseline) or service.get("labels", {}).get("native-deploy-build") != build_id or len(containers) != 1 or containers[0].get("image") != web_image_digest:
        raise RuntimeError("Tokyo Cloud Run must use this build's exact web image and generation.")
    if service.get("reconciling", False) is not False or service.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED":
        raise RuntimeError("Tokyo Cloud Run must finish its rollout successfully.")
    if str(service.get("observedGeneration", "")) != str(service.get("generation", "")):
        raise RuntimeError("Tokyo Cloud Run must observe the deployed generation.")
    ready = web_revision_name(service.get("latestReadyRevision"))
    if not ready or ready != web_revision_name(service.get("latestCreatedRevision")):
        raise RuntimeError("Tokyo Cloud Run must serve its latest ready revision.")
    traffic = service.get("trafficStatuses", [])
    if sum(item.get("percent", 0) for item in traffic if web_revision_name(item.get("revision")) == ready) != 100 or sum(item.get("percent", 0) for item in traffic) != 100:
        raise RuntimeError("Tokyo Cloud Run must route all traffic to the verified revision.")
    if template.get("serviceAccount") != expected["WEB_RUNTIME_SERVICE_ACCOUNT"]:
        raise RuntimeError("Tokyo Cloud Run must use the approved Firebase runtime identity.")
    revision = api_request("GET", f"https://run.googleapis.com/v2/{ready}")
    actual = revision.get("containers", [])
    if len(actual) != 1 or actual[0].get("image") != web_image_digest:
        raise RuntimeError("Tokyo Cloud Run ready revision has an unexpected image digest.")
    return ready


web_ready_revision = verify_web_revision()

if "サロン管理へログイン" not in read_url(f"{frontend_url}/login"):
    raise RuntimeError("Frontend login page health check failed.")
if "サロン管理へログイン" not in read_url(f"{frontend_fallback_url}/login"):
    raise RuntimeError("Cloud Run fallback login page health check failed.")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        return None


opener = urllib.request.build_opener(NoRedirect())
try:
    with opener.open(f"{frontend_url}/routing-check", timeout=60):
        raise RuntimeError("The tenant routing check must redirect to login.")
except urllib.error.HTTPError as error:
    if error.code not in (301, 302, 303, 307, 308) or error.headers.get("Location") not in (f"{frontend_url}/login", "/login"):
        raise RuntimeError("The tenant routing check must redirect to login.") from None

try:
    with urllib.request.urlopen(f"{frontend_url}/api/calendar/backend/dashboard", timeout=60):
        raise RuntimeError("The reserved calendar backend path must remain inaccessible.")
except urllib.error.HTTPError as error:
    if error.code != 404:
        raise RuntimeError("The reserved calendar backend path must return 404.") from None

# Redirect existing bookmarks only after the Tokyo frontend passes acceptance.
build_path = f"{backend_path}/builds/{app_build_id}"
mark_intent("appBuildRequested")
build_operation = api_request(
    "POST", f"{app_hosting_api}/{backend_path}/builds?buildId={app_build_id}",
    container_build_payload,
)
built = wait_state(build_path, {"BUILT", "READY"}, "App Hosting container build", attempts=150, delay=10)
validate_source(built)

rollout_path = f"{backend_path}/rollouts/{app_build_id}"
rollout_payload = {"build": build_path}
for attempt in range(10):
    try:
        api_request(
            "POST", f"{app_hosting_api}/{backend_path}/rollouts?rolloutId={app_build_id}&validateOnly=true",
            rollout_payload,
        )
        break
    except DeploymentApiError as error:
        if error.status != 400 or attempt == 9:
            raise
        time.sleep(2)

mark_intent("appRolloutRequested")
rollout_operation = api_request(
    "POST", f"{app_hosting_api}/{backend_path}/rollouts?rolloutId={app_build_id}",
    rollout_payload,
)
wait_operation(build_operation["name"], "App Hosting build")
wait_operation(rollout_operation["name"], "App Hosting rollout")
built = wait_state(build_path, "READY", "App Hosting build")
validate_source(built)
rolled_out = wait_state(rollout_path, "SUCCEEDED", "App Hosting rollout")
if resource_name(rolled_out.get("build")) != resource_name(build_path):
    raise RuntimeError("App Hosting rollout must point to the verified build.")

verify_web_revision()
for path in ("/login", "/mens-gentle/reservations?view=week"):
    try:
        with opener.open(legacy_url + path, timeout=60):
            raise RuntimeError("The legacy frontend must redirect to the production domain.")
    except urllib.error.HTTPError as error:
        if error.code != 302 or error.headers.get("Location") != frontend_url + path or "no-store" not in error.headers.get("Cache-Control", ""):
            raise RuntimeError("The legacy frontend must preserve paths and query strings when redirecting to the production domain.") from None

print(f"Native production deployment succeeded for {commit} ({build_id}).")
print(f"Tokyo Cloud Run ready revision: {web_ready_revision}")
print(f"Tokyo API ready revision: {api_ready_revision}")
print(f"App Hosting build logs: {built.get('buildLogsUri', '')}")
PY
