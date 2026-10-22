#!/usr/bin/env bash

set -euo pipefail

if [[ $# -eq 1 && "$1" == "--check" ]]; then
  export DEPLOY_PREFLIGHT_ONLY=1
elif [[ $# -ne 0 ]]; then
  echo "Usage: deploy-native.sh [--check]" >&2
  exit 2
fi

# native-deploy.py must hold the production lease before invoking this script.
# The image and App Hosting source always use the triggering commit, not branch HEAD.
python3 - <<'PY'
import hashlib
import json
import os
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
    "CHART_PHOTOS_BUCKET": "salon-reserve-bg-chart-photos",
    "API_RUNTIME_SERVICE_ACCOUNT": "reservation-api-runtime@salon-reserve-bg.iam.gserviceaccount.com",
    "DB_INSTANCE": "salon-reserve-db",
    "VPC_NETWORK": "salon-reserve-vpc",
    "VPC_SUBNET": "salon-reserve-run-asia-east1",
    "APP_HOSTING_BACKEND": "salon-reserve-web",
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
image = f"{region}-docker.pkg.dev/{project}/cloud-run-source-deploy/reservation-api:{commit}-{build_id}"
if required("API_IMAGE") != image:
    raise SystemExit("API_IMAGE must identify the triggering commit and build in the approved registry.")
if os.environ.get("DEPLOY_PREFLIGHT_ONLY") != "1" and not re.fullmatch(r"[1-9][0-9]*", os.environ.get("NATIVE_DEPLOY_LOCK_GENERATION", "")):
    raise SystemExit("A production deployment lease generation is required; invoke native-deploy.py.")


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
    container = resource.get("source")
    source = container.get("codebase") if isinstance(container, dict) else None
    if not isinstance(source, dict) or source.get("hash") != commit or ("commit" in source and source["commit"] != commit):
        raise RuntimeError("App Hosting source must resolve to the triggering commit.")
    if "repository" in source:
        # An explicit field must match, including rejecting empty/null values.
        if resource_name(source["repository"]) != resource_name(repository_link):
            raise RuntimeError("App Hosting source must use the approved repository link.")
        return
    # Some Git builds omit this optional output field. Authenticate their source
    # using the exact commit URI and a fresh check of both connection resources.
    if source.get("uri") != f"https://github.com/OIDEMA/salon-reservation-system/commit/{commit}":
        raise RuntimeError("App Hosting source without a repository field must have the exact approved commit URI.")
    fresh_backend = api_request("GET", f"{app_hosting_api}/{backend_path}")
    fresh_codebase = fresh_backend.get("codebase")
    if not isinstance(fresh_codebase, dict) or resource_name(fresh_codebase.get("repository")) != resource_name(repository_link) or fresh_codebase.get("rootDirectory") != "apps/web":
        raise RuntimeError("App Hosting source connection changed since deployment preflight.")
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
if ip_config.get("ipv4Enabled") is not False or ip_config.get("privateNetwork") != f"projects/{project}/global/networks/{expected['VPC_NETWORK']}":
    raise SystemExit("The database must use only the approved private network.")
bucket = gcloud_json("storage", "buckets", "describe", f"gs://{expected['CHART_PHOTOS_BUCKET']}", f"--project={project}")
if bucket.get("uniform_bucket_level_access") is not True or bucket.get("public_access_prevention") != "enforced":
    raise SystemExit("Chart photo storage must have uniform access and enforced public access prevention.")

if os.environ.get("DEPLOY_PREFLIGHT_ONLY") == "1":
    print("Production deployment target, repository, private database and photo storage verified.")
    raise SystemExit(0)


def mark_intent(phase, baseline=None):
    command = [
        "python3", "scripts/native-deploy.py", "mark-intent",
        "--generation", required("NATIVE_DEPLOY_LOCK_GENERATION"), "--phase", phase,
    ]
    if baseline is not None:
        command.extend(["--baseline", baseline])
    # A failed or ambiguous metadata write must prevent the corresponding mutation.
    subprocess.run(command, check=True)


run_api = f"https://run.googleapis.com/v2/projects/{project}/locations/{region}"


def resource_generation(resource):
    generation = str(resource.get("generation", ""))
    if not re.fullmatch(r"[1-9][0-9]*", generation):
        raise RuntimeError("Cloud Run must provide its current resource generation before deployment.")
    return generation


job_before_deploy = api_request("GET", f"{run_api}/jobs/reservation-db-migrate")
mark_intent("jobDeployRequested", resource_generation(job_before_deploy))
gcloud(
    "run", "jobs", "deploy", "reservation-db-migrate",
    f"--project={project}", f"--region={region}", f"--image={image}",
    f"--service-account={expected['API_RUNTIME_SERVICE_ACCOUNT']}",
    f"--labels=native-deploy-build={build_id}",
    f"--network={expected['VPC_NETWORK']}", f"--subnet={expected['VPC_SUBNET']}",
    "--vpc-egress=private-ranges-only", "--set-secrets=DATABASE_URL=reservation-database-url:latest",
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
        r"projects/(?:salon-reserve-bg|42401528382)/locations/asia-east1/jobs/reservation-db-migrate/executions/[^/]+",
        execution_baseline,
    )
):
    raise RuntimeError("Unexpected Cloud Run migration execution resource.")
mark_intent("jobExecutionRequested", execution_baseline)
gcloud("run", "jobs", "execute", "reservation-db-migrate", f"--project={project}", f"--region={region}", "--wait")

frontend_url = "https://salon-reserve-web--salon-reserve-bg.asia-east1.hosted.app"
api_before_deploy = api_request("GET", f"{run_api}/services/{expected['API_SERVICE']}")
mark_intent("apiDeployRequested", resource_generation(api_before_deploy))
gcloud(
    "run", "deploy", expected["API_SERVICE"], f"--project={project}", f"--region={region}",
    "--platform=managed", f"--image={image}", f"--service-account={expected['API_RUNTIME_SERVICE_ACCOUNT']}",
    f"--labels=native-deploy-build={build_id}",
    "--allow-unauthenticated", f"--network={expected['VPC_NETWORK']}", f"--subnet={expected['VPC_SUBNET']}",
    "--vpc-egress=private-ranges-only", "--update-secrets=DATABASE_URL=reservation-database-url:latest",
    f"--set-env-vars=NODE_ENV=production,DB_CONNECTIVITY=private-ip,CHART_PHOTOS_BUCKET={expected['CHART_PHOTOS_BUCKET']},CORS_ORIGINS={frontend_url},APP_PUBLIC_ORIGIN={frontend_url},INVITATION_EMAIL_FROM=noreply@beauty-gum.jp,AWS_REGION=ap-northeast-1,MEMBER_BOOKING_TENANTS=mens-gentle:gentle;missmrs-takamatsu:missmrs",
    "--cpu=1", "--memory=512Mi", "--min-instances=0", "--max-instances=1", "--concurrency=40",
    "--timeout=60", "--port=8080",
    "--startup-probe=httpGet.path=/ready,httpGet.port=8080,initialDelaySeconds=0,periodSeconds=5,timeoutSeconds=5,failureThreshold=24",
    "--quiet",
)


def verify_private_run(resource):
    annotations = resource.get("spec", {}).get("template", {}).get("metadata", {}).get("annotations", {})
    interfaces = json.loads(annotations.get("run.googleapis.com/network-interfaces", "[]"))
    if annotations.get("run.googleapis.com/cloudsql-instances", "") or not interfaces:
        raise RuntimeError("Cloud Run must use Direct VPC without Cloud SQL socket mounts.")
    if interfaces[0].get("network") != expected["VPC_NETWORK"] or interfaces[0].get("subnetwork") != expected["VPC_SUBNET"]:
        raise RuntimeError("Cloud Run must use the approved VPC network and subnet.")


verify_private_run(gcloud_json("run", "services", "describe", expected["API_SERVICE"], f"--project={project}", f"--region={region}"))
verify_private_run(gcloud_json("run", "jobs", "describe", "reservation-db-migrate", f"--project={project}", f"--region={region}"))


def read_url(url):
    for attempt in range(7):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return response.read().decode("utf-8")
        except (urllib.error.URLError, TimeoutError):
            if attempt == 6:
                raise RuntimeError(f"Deployment health check failed: {url}") from None
            time.sleep(5)


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


app_build_id = "native-" + hashlib.sha256(build_id.encode("utf-8")).hexdigest()[:23]
build_path = f"{backend_path}/builds/{app_build_id}"
mark_intent("appBuildRequested")
build_operation = api_request(
    "POST", f"{app_hosting_api}/{backend_path}/builds?buildId={app_build_id}",
    {"source": {"codebase": {"commit": commit}}},
)
built = wait_state(build_path, {"BUILT", "READY"}, "App Hosting compiled source", attempts=150, delay=10)
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

if "サロン管理へログイン" not in read_url(f"{frontend_url}/login"):
    raise RuntimeError("Frontend login page health check failed.")


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

print(f"Native production deployment succeeded for {commit} ({build_id}).")
print(f"App Hosting build logs: {built.get('buildLogsUri', '')}")
PY
