"""Offline regression tests for the generation-guarded production lease."""

import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "native-deploy.py"
SPEC = importlib.util.spec_from_file_location("native_deploy", SCRIPT)
native_deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(native_deploy)

BUILD_ID = "11111111-1111-4111-8111-111111111111"
OLD_BUILD_ID = "22222222-2222-4222-8222-222222222222"
OTHER_BUILD_ID = "33333333-3333-4333-8333-333333333333"
APP_HOSTING_IDS = {
    BUILD_ID: "native-bd7662a5eeb41614e720d47",
    OLD_BUILD_ID: "native-b454f82c5857ebabf342b72",
    OTHER_BUILD_ID: "native-f6222a1106eefe4f6b25302",
}
COMMIT = "a" * 40
OLDER_COMMIT = "b" * 40
REPOSITORY_LINK = (
    "projects/salon-reserve-bg/locations/asia-east1/connections/github/"
    "gitRepositoryLinks/salon-reservation-system"
)
EXECUTION_NAME = (
    "projects/salon-reserve-bg/locations/asia-northeast1/jobs/"
    "reservation-db-migrate/executions/reservation-db-migrate-test"
)
IMAGE = "asia-east1-docker.pkg.dev/salon-reserve-bg/cloud-run-source-deploy/reservation-api:" + COMMIT + "-" + BUILD_ID
DIGEST = "sha256:" + "c" * 64
EXECUTION_IMAGE = IMAGE.rsplit(":", 1)[0] + "@" + DIGEST
WEB_IMAGE = IMAGE.replace("/reservation-api:", "/reservation-web:")
WEB_DIGEST_IMAGE = WEB_IMAGE.rsplit(":", 1)[0] + "@" + DIGEST
RELAY_IMAGE = IMAGE.replace("/reservation-api:", "/reservation-api-relay:")
RELAY_DIGEST_IMAGE = RELAY_IMAGE.rsplit(":", 1)[0] + "@" + DIGEST


class FakeClock:
    def __init__(self):
        self.now = 0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeGoogleApi:
    """Models GCS generation preconditions; never performs any I/O."""

    def __init__(self, owner=None, status="WORKING"):
        self.owner = dict(owner) if owner is not None else None
        self.generation = "41" if owner is not None else None
        self.metageneration = "1"
        self.custom_metadata = {}
        self.next_generation = 42
        self.statuses = {OLD_BUILD_ID: status, OTHER_BUILD_ID: "WORKING"}
        self.calls = []
        self.before_delete = None
        self.before_patch = None
        self.lose_upload_response = False
        self.lose_patch_response = False
        self.app_build = None
        self.app_rollout = None
        self.job = {
            "generation": "10", "observedGeneration": "10",
            "labels": {"native-deploy-build": (owner or {}).get("buildId", BUILD_ID)},
            "template": {"template": {"containers": [{"image": IMAGE}]}},
            "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
            "executionCount": 1,
            "latestCreatedExecution": {
                "name": EXECUTION_NAME, "completionStatus": "EXECUTION_SUCCEEDED",
            },
        }
        self.execution = {
            "completionTime": "2026-10-13T00:00:00Z",
            "template": {"containers": [{"image": EXECUTION_IMAGE}]},
        }
        self.relay = {
            "generation": "10", "observedGeneration": "10", "labels": {"native-deploy-build": BUILD_ID},
            "template": {"containers": [{"image": RELAY_DIGEST_IMAGE}]},
            "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
        }
        self.web = {
            "generation": "10", "observedGeneration": "10",
            "labels": {"native-deploy-build": (owner or {}).get("buildId", BUILD_ID)},
            "template": {"containers": [{"image": WEB_DIGEST_IMAGE}]},
            "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
        }
        self.service = {
            "generation": "10", "observedGeneration": "10",
            "labels": {"native-deploy-build": (owner or {}).get("buildId", BUILD_ID)},
            "template": {"containers": [{"image": IMAGE}]},
            "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
        }

    def request(self, method, url, payload=None):
        self.calls.append((method, url, payload))
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        if parsed.netloc == "cloudbuild.googleapis.com":
            expected = (
                f"/v1/projects/{native_deploy.PROJECT}/locations/{native_deploy.REGION}/builds/"
            )
            assert method == "GET" and parsed.path.startswith(expected), url
            status = self.statuses[parsed.path.removeprefix(expected)]
            if isinstance(status, Exception):
                raise status
            return {"status": status}

        if parsed.netloc == "firebaseapphosting.googleapis.com":
            assert method == "GET", (method, url)
            expected = (
                f"/v1beta/projects/{native_deploy.PROJECT}/locations/"
                f"{native_deploy.REGION}/backends/salon-reserve-web/"
            )
            assert parsed.path.startswith(expected), url
            resource_type, resource_name = parsed.path.removeprefix(expected).split("/")
            assert resource_name in APP_HOSTING_IDS.values(), url
            resource = {"builds": self.app_build, "rollouts": self.app_rollout}[resource_type]
            if resource is None:
                raise native_deploy.ApiError(404)
            if isinstance(resource, Exception):
                raise resource
            return resource

        if parsed.netloc == "run.googleapis.com":
            assert method == "GET", (method, url)
            if parsed.path == "/v2/projects/salon-reserve-bg/locations/asia-northeast1/services/salon-reserve-web":
                if isinstance(self.web, Exception):
                    raise self.web
                return self.web
            region = (self.owner or {}).get("apiRegion", native_deploy.REGION)
            run_base = f"/v2/projects/{native_deploy.PROJECT}/locations/{region}"
            if parsed.path == "/v2/projects/salon-reserve-bg/locations/asia-east1/services/reservation-api" and region == native_deploy.API_REGION:
                if isinstance(self.relay, Exception):
                    raise self.relay
                return self.relay
            if parsed.path.startswith(run_base + "/jobs/reservation-db-migrate/executions/"):
                resource = self.execution
            else:
                resource = {
                    run_base + "/jobs/reservation-db-migrate": self.job,
                    run_base + "/services/reservation-api": self.service,
                }[parsed.path]
            if isinstance(resource, Exception):
                raise resource
            if region == native_deploy.REGION and resource is self.job:
                resource = json.loads(json.dumps(resource))
                if resource.get("latestCreatedExecution", {}).get("name") == EXECUTION_NAME:
                    resource["latestCreatedExecution"]["name"] = EXECUTION_NAME.replace("asia-northeast1", "asia-east1")
            return resource

        assert parsed.netloc == "storage.googleapis.com", url
        assert f"/b/{native_deploy.BUCKET}/o" in parsed.path, url
        assert "chart-photos" not in url, url
        if method == "POST":
            assert query["ifGenerationMatch"] == ["0"], url
            assert query["name"] == [native_deploy.LOCK_NAME], url
            assert query["uploadType"] == ["media"], url
            if self.owner is not None:
                raise native_deploy.ApiError(412)
            self.owner = dict(payload)
            self.generation = str(self.next_generation)
            self.metageneration = "1"
            self.custom_metadata = {}
            self.next_generation += 1
            if self.lose_upload_response:
                raise TimeoutError("Upload acknowledged by storage, response lost")
            return {"generation": self.generation}

        if method == "GET":
            if self.owner is None:
                raise native_deploy.ApiError(404)
            if "ifGenerationMatch" in query and query["ifGenerationMatch"] != [self.generation]:
                raise native_deploy.ApiError(412)
            if query.get("alt") == ["media"]:
                assert query.get("generation") == [self.generation], url
                return dict(self.owner)
            return self.metadata()

        if method == "PATCH":
            assert "ifGenerationMatch" in query and "ifMetagenerationMatch" in query, url
            if self.before_patch is not None:
                before_patch, self.before_patch = self.before_patch, None
                before_patch()
            if self.owner is None:
                raise native_deploy.ApiError(404)
            if query["ifGenerationMatch"] != [self.generation] or query["ifMetagenerationMatch"] != [self.metageneration]:
                raise native_deploy.ApiError(412)
            self.custom_metadata = dict(payload["metadata"])
            self.metageneration = str(int(self.metageneration) + 1)
            if self.lose_patch_response:
                raise TimeoutError("Metadata update accepted, response lost")
            return self.metadata()

        if method == "DELETE":
            assert "ifGenerationMatch" in query, "Unconditional deletion is forbidden"
            assert "ifMetagenerationMatch" in query, "Intent snapshot must be guarded"
            if self.before_delete is not None:
                before_delete, self.before_delete = self.before_delete, None
                before_delete()
            if self.owner is None:
                raise native_deploy.ApiError(404)
            if query["ifGenerationMatch"] != [self.generation] or query["ifMetagenerationMatch"] != [self.metageneration]:
                raise native_deploy.ApiError(412)
            self.owner = None
            self.generation = None
            return None
        raise AssertionError((method, url))

    def replace_with_live_owner(self):
        self.owner = {"buildId": OTHER_BUILD_ID, "commitSha": COMMIT}
        self.generation = "99"
        self.metageneration = "1"
        self.custom_metadata = {}

    def metadata(self):
        return {
            "generation": self.generation,
            "metageneration": self.metageneration,
            "metadata": dict(self.custom_metadata),
        }

    def intents(self):
        return json.loads(self.custom_metadata.get(native_deploy.INTENT_METADATA_KEY, "{}"))

    def deletes(self):
        return [call for call in self.calls if call[0] == "DELETE"]


class ProductionLeaseTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        for target in ("urllib.request.urlopen", "subprocess.run"):
            self.stack.enter_context(mock.patch.object(
                getattr(native_deploy, target.split(".")[0])
                if target.startswith("subprocess.") else native_deploy.urllib.request,
                target.split(".")[-1],
                side_effect=AssertionError("Tests must not access network or execute commands"),
            ))
        def image_digest(command, **kwargs):
            self.assertEqual(command, [
                "gcloud", "artifacts", "docker", "images", "describe", command[5] if command[5] in (WEB_IMAGE, RELAY_IMAGE) else IMAGE,
                "--project=salon-reserve-bg", "--format=value(image_summary.digest)",
            ])
            self.assertEqual(kwargs, {"text": True, "stderr": native_deploy.subprocess.PIPE, "timeout": 60})
            return DIGEST + "\n"
        self.digest_lookup = self.stack.enter_context(mock.patch.object(
            native_deploy.subprocess, "check_output", side_effect=image_digest,
        ))
        self.clock = FakeClock()
        self.stack.enter_context(mock.patch.object(
            native_deploy.time, "monotonic", self.clock.monotonic
        ))

    def lease(self, api):
        return native_deploy.ProductionLease(api, BUILD_ID, COMMIT, sleep=self.clock.sleep)

    def run_deployment(self, api, deploy, head=COMMIT, commit=COMMIT):
        return native_deploy.run_deployment(
            api, BUILD_ID, commit, REPOSITORY_LINK, deploy,
            get_head=lambda *_: head,
        )

    def test_live_builds_are_never_deleted(self):
        for status in ("PENDING", "QUEUED", "WORKING"):
            with self.subTest(status=status):
                api = FakeGoogleApi({"buildId": OLD_BUILD_ID}, status)
                with self.assertRaisesRegex(RuntimeError, "Timed out"):
                    self.lease(api).acquire(wait_seconds=15)
                self.assertEqual(api.owner["buildId"], OLD_BUILD_ID)
                self.assertEqual(api.generation, "41")
                self.assertEqual(api.deletes(), [])

    def test_only_terminal_builds_allow_generation_guarded_reclaim(self):
        for status in native_deploy.TERMINAL_BUILD_STATES:
            with self.subTest(status=status):
                api = FakeGoogleApi({"buildId": OLD_BUILD_ID}, status)
                lease = self.lease(api)
                lease.acquire()
                self.assertEqual(lease.generation, "42")
                self.assertEqual(api.owner["buildId"], BUILD_ID)
                self.assertEqual(len(api.deletes()), 1)
                self.assertTrue(api.deletes()[0][1].endswith("ifGenerationMatch=41"))
                urls = [url for _, url, _ in api.calls]
                media_index = next(i for i, url in enumerate(urls) if "?alt=media&generation=41" in url)
                owner_index = next(i for i, url in enumerate(urls) if "cloudbuild.googleapis.com" in url)
                delete_index = next(i for i, call in enumerate(api.calls) if call[0] == "DELETE")
                self.assertLess(media_index, owner_index)
                self.assertLess(owner_index, delete_index)

    def test_unrecognized_owner_fails_closed(self):
        for owner in ({}, {"buildId": "unexpected-owner"}):
            with self.subTest(owner=owner):
                api = FakeGoogleApi(owner)
                with self.assertRaisesRegex(RuntimeError, "unrecognized owner"):
                    self.lease(api).acquire()
                self.assertEqual(api.owner, owner)
                self.assertEqual(api.deletes(), [])

    def test_unknown_build_status_fails_closed(self):
        for status in (None, "STATUS_UNKNOWN", "SOME_FUTURE_STATE"):
            with self.subTest(status=status):
                api = FakeGoogleApi({"buildId": OLD_BUILD_ID}, status)
                with self.assertRaisesRegex(RuntimeError, "Timed out"):
                    self.lease(api).acquire(wait_seconds=15)
                self.assertEqual(api.deletes(), [])
                self.assertEqual(api.generation, "41")

    def test_owner_lookup_error_fails_closed(self):
        for status in (403, 404, 500):
            with self.subTest(status=status):
                api = FakeGoogleApi({"buildId": OLD_BUILD_ID}, native_deploy.ApiError(status))
                with self.assertRaises(native_deploy.ApiError) as error:
                    self.lease(api).acquire()
                self.assertEqual(error.exception.status, status)
                self.assertEqual(api.deletes(), [])
                self.assertEqual(api.generation, "41")

    def test_reclaim_race_never_deletes_replacement_live_lease(self):
        api = FakeGoogleApi({"buildId": OLD_BUILD_ID}, "SUCCESS")
        api.before_delete = api.replace_with_live_owner
        with self.assertRaisesRegex(RuntimeError, "Timed out"):
            self.lease(api).acquire(wait_seconds=15)
        self.assertEqual(api.owner["buildId"], OTHER_BUILD_ID)
        self.assertEqual(api.generation, "99")
        self.assertEqual(len(api.deletes()), 1)
        self.assertTrue(api.deletes()[0][1].endswith("ifGenerationMatch=41"))

    def test_release_deletes_only_its_acquired_generation_once(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        lease.release()
        lease.release()
        self.assertIsNone(api.owner)
        self.assertIsNone(lease.generation)
        self.assertEqual(len(api.deletes()), 1)
        self.assertTrue(api.deletes()[0][1].endswith("ifGenerationMatch=42"))

    def test_release_412_does_not_retry_or_delete_replacement_lease(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        api.before_delete = api.replace_with_live_owner
        lease.release()
        lease.release()
        self.assertEqual(api.owner["buildId"], OTHER_BUILD_ID)
        self.assertEqual(api.generation, "99")
        self.assertIsNone(lease.generation)
        self.assertEqual(len(api.deletes()), 1)
        self.assertTrue(api.deletes()[0][1].endswith("ifGenerationMatch=42"))

    def test_obsolete_commit_never_deploys_and_releases_lease(self):
        api = FakeGoogleApi()
        deploy = mock.Mock()
        result = self.run_deployment(api, deploy, commit=OLDER_COMMIT)
        self.assertFalse(result)
        deploy.assert_not_called()
        self.assertIsNone(api.owner)
        self.assertEqual(len(api.deletes()), 1)

    def test_current_commit_deploys_while_lease_held_and_then_releases(self):
        api = FakeGoogleApi()
        def deploy(generation):
            self.assertEqual(generation, api.generation)
            self.assertEqual(api.owner["buildId"], BUILD_ID)
            self.assertEqual(api.owner["commitSha"], COMMIT)
            self.assertEqual(api.deletes(), [])
        self.assertTrue(self.run_deployment(api, deploy))
        self.assertIsNone(api.owner)
        self.assertEqual(len(api.deletes()), 1)

    def test_deploy_failure_releases_lease_and_preserves_error(self):
        api = FakeGoogleApi()
        failure = RuntimeError("Deployment failed")
        deploy = mock.Mock(side_effect=failure)
        with self.assertRaises(RuntimeError) as error:
            self.run_deployment(api, deploy)
        self.assertIs(error.exception, failure)
        self.assertIsNone(api.owner)
        self.assertTrue(api.deletes()[0][1].endswith("ifGenerationMatch=42"))

    def test_head_lookup_failure_releases_lease_without_deploy(self):
        api = FakeGoogleApi()
        deploy = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "Cannot verify main"):
            native_deploy.run_deployment(
                api, BUILD_ID, COMMIT, REPOSITORY_LINK, deploy,
                get_head=mock.Mock(side_effect=RuntimeError("Cannot verify main")),
            )
        deploy.assert_not_called()
        self.assertIsNone(api.owner)
        self.assertEqual(len(api.deletes()), 1)

    def test_lost_upload_response_does_not_guess_generation_or_delete(self):
        api = FakeGoogleApi()
        api.lose_upload_response = True
        lease = self.lease(api)
        with self.assertRaises(TimeoutError):
            lease.acquire()
        lease.release()
        self.assertIsNone(lease.generation)
        self.assertEqual(api.owner["buildId"], BUILD_ID)
        self.assertEqual(api.generation, "42")
        self.assertEqual(api.deletes(), [])

    def test_terminal_parent_with_unsettled_app_child_cannot_be_reclaimed(self):
        child_states = (
            ("app_build", ("BUILDING", "BUILT", "DEPLOYING", "STATE_UNSPECIFIED", None)),
            ("app_rollout", ("QUEUED", "PENDING_BUILD", "PROGRESSING", "PAUSED", "UNKNOWN", None)),
        )
        for attribute, states in child_states:
            for state in states:
                with self.subTest(child=attribute, state=state):
                    api = FakeGoogleApi({"buildId": OLD_BUILD_ID}, "CANCELLED")
                    setattr(api, attribute, {"state": state})
                    with self.assertRaisesRegex(RuntimeError, "Timed out"):
                        self.lease(api).acquire(wait_seconds=15)
                    self.assertEqual(api.deletes(), [])
                    self.assertEqual(api.generation, "41")

    def test_terminal_app_children_allow_reclaim(self):
        for build_state in ("READY", "FAILED", "SKIPPED", "EXPIRED"):
            for rollout_state in ("SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"):
                with self.subTest(build=build_state, rollout=rollout_state):
                    api = FakeGoogleApi({"buildId": OLD_BUILD_ID}, "TIMEOUT")
                    api.app_build = {"state": build_state}
                    api.app_rollout = {"state": rollout_state}
                    lease = self.lease(api)
                    lease.acquire()
                    self.assertEqual(lease.generation, "42")
                    self.assertEqual(len(api.deletes()), 1)

    def test_unsettled_cloud_run_operations_block_reclaim(self):
        for case in (
            "job_reconciling", "job_unknown", "execution_running", "execution_pending",
            "execution_unknown", "execution_missing_time", "execution_reconciling",
            "execution_running_task", "execution_wrong_project", "service_reconciling", "service_unknown",
        ):
            with self.subTest(case=case):
                api = FakeGoogleApi({"buildId": OLD_BUILD_ID}, "FAILURE")
                if case == "job_reconciling":
                    api.job["reconciling"] = True
                elif case == "job_unknown":
                    api.job["terminalCondition"] = {}
                elif case in ("execution_running", "execution_pending", "execution_unknown"):
                    api.job["latestCreatedExecution"]["completionStatus"] = {
                        "execution_running": "EXECUTION_RUNNING",
                        "execution_pending": "EXECUTION_PENDING",
                        "execution_unknown": "COMPLETION_STATUS_UNSPECIFIED",
                    }[case]
                elif case == "execution_missing_time":
                    api.execution.clear()
                elif case == "execution_reconciling":
                    api.execution["reconciling"] = True
                elif case == "execution_running_task":
                    api.execution["runningCount"] = 1
                elif case == "execution_wrong_project":
                    api.job["latestCreatedExecution"]["name"] = EXECUTION_NAME.replace("salon-reserve-bg", "wrong-project")
                elif case == "service_reconciling":
                    api.service["reconciling"] = True
                elif case == "service_unknown":
                    api.service["terminalCondition"] = {}
                with self.assertRaisesRegex(RuntimeError, "Timed out"):
                    self.lease(api).acquire(wait_seconds=15)
                self.assertEqual(api.deletes(), [])
                self.assertEqual(api.generation, "41")

    def test_failed_or_cancelled_completed_execution_can_release(self):
        for status in ("EXECUTION_FAILED", "EXECUTION_CANCELLED"):
            with self.subTest(status=status):
                api = FakeGoogleApi()
                api.job["latestCreatedExecution"]["completionStatus"] = status
                api.service["terminalCondition"]["state"] = "CONDITION_FAILED"
                lease = self.lease(api)
                lease.acquire()
                lease.release()
                self.assertIsNone(api.owner)

    def test_deploy_failure_retains_lease_until_async_rollout_finishes(self):
        api = FakeGoogleApi()
        failure = RuntimeError("Command failed after rollout accepted")
        def deploy(_generation):
            api.app_build = {"state": "READY"}
            api.app_rollout = {"state": "PROGRESSING"}
            raise failure
        with self.assertRaises(RuntimeError) as error:
            self.run_deployment(api, deploy)
        self.assertIs(error.exception, failure)
        self.assertEqual(api.generation, "42")
        self.assertEqual(api.deletes(), [])
        api.statuses[BUILD_ID] = "FAILURE"
        api.app_rollout = {"state": "SUCCEEDED"}
        replacement = native_deploy.ProductionLease(
            api, OTHER_BUILD_ID, COMMIT, sleep=self.clock.sleep,
        )
        replacement.acquire()
        self.assertEqual(replacement.generation, "43")
        self.assertTrue(api.deletes()[0][1].endswith("ifGenerationMatch=42"))

    def test_child_lookup_errors_retain_lease_on_release(self):
        for child in ("app_build", "app_rollout", "job", "execution", "service"):
            for status in (403, 500):
                with self.subTest(child=child, status=status):
                    api = FakeGoogleApi()
                    lease = self.lease(api)
                    lease.acquire()
                    setattr(api, child, native_deploy.ApiError(status))
                    lease.release()
                    self.assertEqual(api.deletes(), [])
                    self.assertEqual(api.generation, "42")
                    self.assertEqual(lease.generation, "42")

    def test_child_lookup_error_never_reclaims_terminal_parent(self):
        api = FakeGoogleApi({"buildId": OLD_BUILD_ID}, "SUCCESS")
        api.app_rollout = native_deploy.ApiError(403)
        with self.assertRaises(native_deploy.ApiError):
            self.lease(api).acquire()
        self.assertEqual(api.deletes(), [])
        self.assertEqual(api.generation, "41")

    def test_missing_expected_cloud_run_resource_retains_lease(self):
        for child in ("job", "execution", "service"):
            with self.subTest(child=child):
                api = FakeGoogleApi()
                lease = self.lease(api)
                lease.acquire()
                if child in ("job", "service"):
                    native_deploy.mark_deployment_intent(api, lease.generation,
                        "jobDeployRequested" if child == "job" else "apiDeployRequested", "0")
                setattr(api, child, native_deploy.ApiError(404))
                lease.release()
                self.assertEqual(api.deletes(), [])
                self.assertEqual(api.generation, "42")

    def test_initial_missing_tokyo_resources_without_intent_allow_release(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        api.job = native_deploy.ApiError(404)
        api.service = native_deploy.ApiError(404)
        lease.release()
        self.assertEqual(len(api.deletes()), 1)

    def test_new_lease_records_tokyo_region(self):
        api = FakeGoogleApi()
        self.lease(api).acquire()
        self.assertEqual(api.owner["apiRegion"], "asia-northeast1")

    def test_execution_baseline_must_match_owner_region(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        with self.assertRaisesRegex(RuntimeError, "different API region"):
            native_deploy.mark_deployment_intent(api, lease.generation, "jobExecutionRequested", EXECUTION_NAME.replace("asia-northeast1", "asia-east1"))
        self.assertEqual(api.intents(), {})

    def test_relay_intent_requires_new_owned_digest_generation(self):
        for bad in ("generation", "image", "owner", "pending", "missing"):
            with self.subTest(bad=bad):
                api = FakeGoogleApi()
                lease = self.lease(api)
                lease.acquire()
                native_deploy.mark_deployment_intent(api, lease.generation, "apiRelayDeployRequested", "9")
                self.assertEqual(api.intents()["apiRelayDeployRequested"]["expectedRelayDigest"], DIGEST)
                if bad == "generation":
                    api.relay["generation"] = "9"
                elif bad == "image":
                    api.relay["template"]["containers"][0]["image"] = EXECUTION_IMAGE
                elif bad == "owner":
                    api.relay["labels"]["native-deploy-build"] = OTHER_BUILD_ID
                elif bad == "pending":
                    api.relay["reconciling"] = True
                else:
                    api.relay = native_deploy.ApiError(404)
                lease.release()
                self.assertEqual(api.deletes(), [])

    def test_provisioning_owner_is_never_automatically_reclaimed(self):
        api = FakeGoogleApi({"kind": "tenantProvisioning", "workflowRun": "12345-1", "apiRegion": native_deploy.API_REGION})
        with self.assertRaisesRegex(RuntimeError, "Timed out"):
            self.lease(api).acquire(wait_seconds=15)
        self.assertEqual(api.deletes(), [])
        self.assertFalse(any("cloudbuild.googleapis.com" in url for _, url, _ in api.calls))

    def test_successful_run_resource_requires_observed_generation(self):
        for child, phase in (("job", "jobDeployRequested"), ("service", "apiDeployRequested"), ("web", "webDeployRequested"), ("relay", "apiRelayDeployRequested")):
            with self.subTest(child=child):
                api = FakeGoogleApi()
                lease = self.lease(api)
                lease.acquire()
                native_deploy.mark_deployment_intent(api, lease.generation, phase, "9")
                getattr(api, child)["observedGeneration"] = "9"
                lease.release()
                self.assertEqual(api.deletes(), [])

    def test_failed_run_resource_with_older_observed_generation_is_terminal(self):
        for child, phase in (("job", "jobDeployRequested"), ("service", "apiDeployRequested"), ("web", "webDeployRequested"), ("relay", "apiRelayDeployRequested")):
            with self.subTest(child=child):
                api = FakeGoogleApi()
                lease = self.lease(api)
                lease.acquire()
                native_deploy.mark_deployment_intent(api, lease.generation, phase, "9")
                resource = getattr(api, child)
                resource["observedGeneration"] = "9"
                resource["terminalCondition"]["state"] = "CONDITION_FAILED"
                lease.release()
                self.assertIsNone(api.owner)

    def test_public_repository_head_check_does_not_request_credentials(self):
        api = mock.Mock()
        api.request.return_value = {"cloneUri": native_deploy.REPOSITORY}
        completed = native_deploy.subprocess.CompletedProcess(
            [], 0, stdout=COMMIT + "\trefs/heads/main\n", stderr="",
        )
        with mock.patch.object(native_deploy.subprocess, "run", return_value=completed) as run:
            self.assertEqual(native_deploy.latest_main_commit(api, REPOSITORY_LINK), COMMIT)
        api.request.assert_called_once_with(
            "GET", "https://developerconnect.googleapis.com/v1/" + REPOSITORY_LINK,
        )
        args, kwargs = run.call_args
        self.assertEqual(args[0], [
            "git", "-c", "credential.helper=", "ls-remote", "--exit-code",
            native_deploy.REPOSITORY, "refs/heads/main",
        ])
        self.assertEqual(kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")
        self.assertEqual(kwargs["env"]["GIT_ASKPASS"], "/bin/false")

    def test_wrong_repository_never_invokes_git(self):
        api = mock.Mock()
        api.request.return_value = {"cloneUri": "https://github.com/other/project.git"}
        with self.assertRaisesRegex(RuntimeError, "must point to"):
            native_deploy.latest_main_commit(api, REPOSITORY_LINK)

    def test_malformed_or_failed_head_lookup_is_rejected(self):
        for code, stdout in (
            (1, ""), (0, ""), (0, COMMIT + "\trefs/heads/other\n"),
            (0, "not-a-commit\trefs/heads/main\n"),
        ):
            with self.subTest(code=code, stdout=stdout):
                api = mock.Mock()
                api.request.return_value = {"cloneUri": native_deploy.REPOSITORY}
                completed = native_deploy.subprocess.CompletedProcess(
                    [], code, stdout=stdout, stderr="Private diagnostic content",
                )
                with mock.patch.object(native_deploy.subprocess, "run", return_value=completed):
                    with self.assertRaises(RuntimeError) as error:
                        native_deploy.latest_main_commit(api, REPOSITORY_LINK)
                self.assertNotIn("Private diagnostic content", str(error.exception))

    def test_mark_intent_preserves_object_generation_and_other_metadata(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        api.custom_metadata["unrelated"] = "preserved"
        expected = {}
        for phase, baseline in (
            ("jobDeployRequested", "10"),
            ("jobExecutionRequested", "reservation-db-migrate-test"),
            ("apiDeployRequested", "10"),
            ("appBuildRequested", None),
            ("appRolloutRequested", None),
        ):
            native_deploy.mark_deployment_intent(api, lease.generation, phase, baseline)
            field = native_deploy.INTENT_PHASES[phase]
            expected[phase] = {} if field is None else {field: baseline}
            if phase == "jobExecutionRequested":
                expected[phase]["expectedExecutionDigest"] = DIGEST
            self.assertEqual(api.intents(), expected)
            self.assertEqual(api.generation, "42")
            self.assertEqual(api.custom_metadata["unrelated"], "preserved")
        patches = [call for call in api.calls if call[0] == "PATCH"]
        self.assertEqual(len(patches), 5)
        for i, (_method, url, _payload) in enumerate(patches, start=1):
            self.assertEqual(parse_qs(urlparse(url).query), {
                "ifGenerationMatch": ["42"], "ifMetagenerationMatch": [str(i)],
            })

    def test_recorded_phase_cannot_be_repeated_even_with_the_same_baseline(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        native_deploy.mark_deployment_intent(api, "42", "jobDeployRequested", "10")
        for baseline in ("10", "11"):
            with self.assertRaisesRegex(RuntimeError, "cannot be repeated"):
                native_deploy.mark_deployment_intent(api, "42", "jobDeployRequested", baseline)
        self.assertEqual(len([call for call in api.calls if call[0] == "PATCH"]), 1)
        self.assertEqual(api.intents()["jobDeployRequested"], {"baselineGeneration": "10"})

    def test_invalid_intent_is_rejected_before_storage_access(self):
        for generation, phase, baseline in (
            ("0", "appBuildRequested", None),
            ("42&other=1", "appBuildRequested", None),
            ("42", "unknownPhase", None),
            ("42", "jobDeployRequested", None),
            ("42", "apiDeployRequested", "-1"),
            ("42", "jobExecutionRequested", "wrong-job-run"),
            ("42", "jobExecutionRequested", EXECUTION_NAME.replace("salon-reserve-bg", "wrong-project")),
        ):
            with self.subTest(generation=generation, phase=phase, baseline=baseline):
                api = FakeGoogleApi()
                with self.assertRaises(RuntimeError):
                    native_deploy.mark_deployment_intent(api, generation, phase, baseline)
                self.assertEqual(api.calls, [])

    def test_mark_intent_cannot_update_replacement_generation(self):
        api = FakeGoogleApi()
        self.lease(api).acquire()
        api.before_patch = api.replace_with_live_owner
        with self.assertRaises(native_deploy.ApiError) as error:
            native_deploy.mark_deployment_intent(api, "42", "appBuildRequested")
        self.assertEqual(error.exception.status, 412)
        self.assertEqual(api.owner["buildId"], OTHER_BUILD_ID)
        self.assertEqual(api.generation, "99")
        self.assertEqual(api.custom_metadata, {})

    def test_mark_intent_cannot_overwrite_concurrent_metadata(self):
        api = FakeGoogleApi()
        self.lease(api).acquire()
        def concurrent_intent():
            api.custom_metadata[native_deploy.INTENT_METADATA_KEY] = '{"appRolloutRequested":{}}'
            api.metageneration = "2"
        api.before_patch = concurrent_intent
        with self.assertRaises(native_deploy.ApiError) as error:
            native_deploy.mark_deployment_intent(api, "42", "appBuildRequested")
        self.assertEqual(error.exception.status, 412)
        self.assertEqual(api.intents(), {"appRolloutRequested": {}})

    def test_lost_metadata_patch_response_retains_persisted_intent(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        api.lose_patch_response = True
        with self.assertRaises(TimeoutError):
            native_deploy.mark_deployment_intent(api, "42", "appBuildRequested")
        lease.release()
        self.assertEqual(api.intents(), {"appBuildRequested": {}})
        self.assertEqual(api.deletes(), [])
        self.assertEqual(api.generation, "42")

    def test_requested_app_resource_404_retains_release_and_reclaim(self):
        for phase in ("appBuildRequested", "appRolloutRequested"):
            with self.subTest(phase=phase):
                api = FakeGoogleApi()
                lease = self.lease(api)
                lease.acquire()
                native_deploy.mark_deployment_intent(api, "42", phase)
                lease.release()
                api.statuses[BUILD_ID] = "CANCELLED"
                replacement = native_deploy.ProductionLease(
                    api, OTHER_BUILD_ID, COMMIT, sleep=self.clock.sleep,
                )
                with self.assertRaisesRegex(RuntimeError, "Timed out"):
                    replacement.acquire(wait_seconds=15)
                self.assertEqual(api.deletes(), [])
                self.assertEqual(api.generation, "42")

    def test_requested_cloud_run_old_snapshot_is_not_completion(self):
        for phase, resource_name in (
            ("jobDeployRequested", "job"), ("apiDeployRequested", "service"),
        ):
            with self.subTest(phase=phase):
                api = FakeGoogleApi()
                lease = self.lease(api)
                lease.acquire()
                native_deploy.mark_deployment_intent(api, "42", phase, "10")
                lease.release()
                self.assertEqual(api.deletes(), [])
                self.assertEqual(api.generation, "42")
                getattr(api, resource_name)["generation"] = "11"
                getattr(api, resource_name)["observedGeneration"] = "11"
                lease.release()
                self.assertIsNone(api.owner)

    def test_run_generation_advance_requires_matching_owner_and_image(self):
        for phase, resource_name in (
            ("jobDeployRequested", "job"), ("apiDeployRequested", "service"),
        ):
            for wrong_field in ("label", "image"):
                with self.subTest(phase=phase, wrong_field=wrong_field):
                    api = FakeGoogleApi()
                    lease = self.lease(api)
                    lease.acquire()
                    native_deploy.mark_deployment_intent(api, "42", phase, "9")
                    resource = getattr(api, resource_name)
                    if wrong_field == "label":
                        resource["labels"]["native-deploy-build"] = OLD_BUILD_ID
                    else:
                        template = resource["template"]
                        template.get("template", template)["containers"][0]["image"] = IMAGE.replace(COMMIT, OLDER_COMMIT)
                    lease.release()
                    self.assertEqual(api.deletes(), [])
                    self.assertEqual(api.generation, "42")

    def test_execution_baseline_normalizes_short_id_and_project_number(self):
        for baseline in (
            EXECUTION_NAME, EXECUTION_NAME.split("/")[-1],
            EXECUTION_NAME.replace("salon-reserve-bg", "42401528382"),
        ):
            with self.subTest(baseline=baseline):
                api = FakeGoogleApi()
                lease = self.lease(api)
                lease.acquire()
                api.job["latestCreatedExecution"]["name"] = EXECUTION_NAME.split("/")[-1]
                native_deploy.mark_deployment_intent(api, "42", "jobExecutionRequested", baseline)
                lease.release()
                self.assertEqual(api.deletes(), [])
                api.job["latestCreatedExecution"]["name"] = "reservation-db-migrate-new"
                lease.release()
                self.assertIsNone(api.owner)
                self.assertTrue(any(
                    url.endswith("/jobs/reservation-db-migrate/executions/reservation-db-migrate-new")
                    for method, url, _payload in api.calls if method == "GET"
                ))

    def test_requested_execution_requires_matching_image(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        native_deploy.mark_deployment_intent(api, "42", "jobExecutionRequested", "")
        api.execution["template"]["containers"][0]["image"] = IMAGE.replace(COMMIT, OLDER_COMMIT)
        lease.release()
        self.assertEqual(api.deletes(), [])

    def test_release_metadata_race_cannot_delete_new_intent(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        api.before_delete = lambda: native_deploy.mark_deployment_intent(api, "42", "appBuildRequested")
        lease.release()
        self.assertEqual(api.generation, "42")
        self.assertEqual(api.intents(), {"appBuildRequested": {}})
        self.assertEqual(len(api.deletes()), 1)

    def test_malformed_intent_metadata_is_retained(self):
        for value in ("not-json", "[]", '{"unknown":{}}', '{"apiDeployRequested":{}}'):
            with self.subTest(value=value):
                api = FakeGoogleApi()
                lease = self.lease(api)
                lease.acquire()
                api.custom_metadata[native_deploy.INTENT_METADATA_KEY] = value
                lease.release()
                self.assertEqual(api.generation, "42")
                self.assertEqual(api.deletes(), [])

    def test_execution_intent_digest_is_persisted_before_release(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        native_deploy.mark_deployment_intent(api, "42", "jobExecutionRequested", "")
        self.assertEqual(api.intents()["jobExecutionRequested"], {
            "baselineExecution": "", "expectedExecutionDigest": DIGEST,
        })
        self.digest_lookup.assert_called_once()
        # Cloud Run keeps the Job tag but resolves the Execution to a digest.
        self.assertEqual(api.job["template"]["template"]["containers"][0]["image"], IMAGE)
        self.assertEqual(api.execution["template"]["containers"][0]["image"], EXECUTION_IMAGE)
        lease.release()
        self.assertIsNone(api.owner)

    def test_failed_or_invalid_digest_lookup_never_records_execution_intent(self):
        outcomes = (
            "", "sha256:too-short", "untrusted diagnostic content",
            native_deploy.subprocess.CalledProcessError(1, ["gcloud"]),
            native_deploy.subprocess.TimeoutExpired(["gcloud"], 60),
        )
        for outcome in outcomes:
            with self.subTest(outcome=type(outcome).__name__):
                api = FakeGoogleApi()
                self.lease(api).acquire()
                self.digest_lookup.side_effect = outcome if isinstance(outcome, Exception) else None
                self.digest_lookup.return_value = outcome
                with self.assertRaises(RuntimeError):
                    native_deploy.mark_deployment_intent(api, "42", "jobExecutionRequested", "")
                self.assertEqual(api.intents(), {})
                self.assertEqual([call for call in api.calls if call[0] == "PATCH"], [])

    def test_execution_with_wrong_digest_or_repository_is_retained(self):
        for image in (
            EXECUTION_IMAGE.replace("c" * 64, "d" * 64),
            EXECUTION_IMAGE.replace("salon-reserve-bg/", "wrong-project/"),
            IMAGE,
        ):
            with self.subTest(image=image):
                api = FakeGoogleApi()
                lease = self.lease(api)
                lease.acquire()
                native_deploy.mark_deployment_intent(api, "42", "jobExecutionRequested", "")
                api.execution["template"]["containers"][0]["image"] = image
                lease.release()
                self.assertEqual(api.generation, "42")
                self.assertEqual(api.deletes(), [])

    def test_mark_intent_cli_checks_owner_and_records_phase(self):
        api = FakeGoogleApi()
        self.lease(api).acquire()
        with mock.patch.dict(native_deploy.os.environ, {
            "PROJECT_ID": "salon-reserve-bg", "REGION": "asia-east1", "API_REGION": "asia-northeast1",
            "BUILD_ID": BUILD_ID, "COMMIT_SHA": COMMIT,
            "GIT_REPOSITORY_LINK": REPOSITORY_LINK,
        }), mock.patch.object(sys, "argv", [
            "native-deploy.py", "mark-intent", "--generation", "42",
            "--phase", "jobExecutionRequested", "--baseline", "",
        ]), mock.patch.object(native_deploy, "GoogleApi", return_value=api):
            native_deploy.main()
        self.assertEqual(api.intents(), {"jobExecutionRequested": {
            "baselineExecution": "", "expectedExecutionDigest": DIGEST,
        }})
        self.assertEqual(api.generation, "42")

    def test_mark_intent_cli_rejects_another_builds_lease(self):
        api = FakeGoogleApi()
        self.lease(api).acquire()
        with mock.patch.dict(native_deploy.os.environ, {
            "PROJECT_ID": "salon-reserve-bg", "REGION": "asia-east1", "API_REGION": "asia-northeast1",
            "BUILD_ID": OTHER_BUILD_ID, "COMMIT_SHA": COMMIT,
            "GIT_REPOSITORY_LINK": REPOSITORY_LINK,
        }), mock.patch.object(sys, "argv", [
            "native-deploy.py", "mark-intent", "--generation", "42",
            "--phase", "appBuildRequested",
        ]), mock.patch.object(native_deploy, "GoogleApi", return_value=api):
            with self.assertRaisesRegex(SystemExit, "does not belong"):
                native_deploy.main()
        self.assertEqual(api.intents(), {})
        self.assertEqual([call for call in api.calls if call[0] == "PATCH"], [])

    def test_same_commit_other_build_image_cannot_discharge_run_intent(self):
        for phase, resource_name in (
            ("jobDeployRequested", "job"), ("apiDeployRequested", "service"),
        ):
            for wrong_image in (IMAGE.replace(BUILD_ID, OTHER_BUILD_ID), IMAGE.replace("-" + BUILD_ID, "")):
                with self.subTest(phase=phase, wrong_image=wrong_image):
                    api = FakeGoogleApi()
                    lease = self.lease(api)
                    lease.acquire()
                    native_deploy.mark_deployment_intent(api, "42", phase, "9")
                    resource = getattr(api, resource_name)
                    template = resource["template"]
                    template.get("template", template)["containers"][0]["image"] = wrong_image
                    # Even a matching build label cannot excuse another build's
                    # image, or the older commit-only mutable image tag.
                    self.assertEqual(resource["labels"]["native-deploy-build"], BUILD_ID)
                    lease.release()
                    self.assertEqual(api.generation, "42")
                    self.assertEqual(api.deletes(), [])

    def test_execution_digest_lookup_uses_lease_owners_unique_build_tag(self):
        api = FakeGoogleApi({"buildId": OLD_BUILD_ID, "commitSha": COMMIT})
        self.digest_lookup.side_effect = None
        self.digest_lookup.return_value = DIGEST + "\n"
        native_deploy.mark_deployment_intent(api, "41", "jobExecutionRequested", "")
        self.assertEqual(self.digest_lookup.call_args.args[0][5], IMAGE.replace(BUILD_ID, OLD_BUILD_ID))
        self.assertEqual(api.intents()["jobExecutionRequested"]["expectedExecutionDigest"], DIGEST)

    def test_tokyo_web_intent_records_owner_digest_before_deploy(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        native_deploy.mark_deployment_intent(api, lease.generation, "webDeployRequested", "9")
        intent = api.intents()["webDeployRequested"]
        self.assertEqual(intent, {"baselineGeneration": "9", "expectedWebDigest": DIGEST})
        self.assertEqual(self.digest_lookup.call_args.args[0][5], WEB_IMAGE)
        lease.release()
        self.assertIsNone(api.owner)

    def test_tokyo_first_creation_can_use_zero_generation_baseline(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        native_deploy.mark_deployment_intent(api, lease.generation, "webDeployRequested", "0")
        api.web["generation"] = "1"
        api.web["observedGeneration"] = "1"
        lease.release()
        self.assertIsNone(api.owner)

    def test_tokyo_web_intent_keeps_lease_until_owned_generation_settles(self):
        cases = ("missing", "forbidden", "stale", "wrong-owner", "wrong-image", "tag-image", "reconciling", "pending", "unknown")
        for case in cases:
            with self.subTest(case=case):
                api = FakeGoogleApi()
                lease = self.lease(api)
                lease.acquire()
                native_deploy.mark_deployment_intent(api, lease.generation, "webDeployRequested", "9")
                if case == "missing":
                    api.web = native_deploy.ApiError(404)
                elif case == "forbidden":
                    api.web = native_deploy.ApiError(403)
                elif case == "stale":
                    api.web["generation"] = "9"
                elif case == "wrong-owner":
                    api.web["labels"]["native-deploy-build"] = OLD_BUILD_ID
                elif case in ("wrong-image", "tag-image"):
                    api.web["template"]["containers"][0]["image"] = IMAGE if case == "wrong-image" else WEB_IMAGE
                elif case == "reconciling":
                    api.web["reconciling"] = True
                else:
                    api.web["terminalCondition"]["state"] = "CONDITION_RECONCILING" if case == "pending" else "UNKNOWN"
                lease.release()
                self.assertEqual(api.deletes(), [])
                self.assertIsNotNone(api.owner)

    def test_tokyo_failed_owned_revision_allows_recovery_without_hiding_failure(self):
        api = FakeGoogleApi()
        lease = self.lease(api)
        lease.acquire()
        native_deploy.mark_deployment_intent(api, lease.generation, "webDeployRequested", "9")
        api.web["terminalCondition"]["state"] = "CONDITION_FAILED"
        lease.release()
        self.assertIsNone(api.owner)

    def test_tokyo_unknown_digest_metadata_never_releases_lease(self):
        for digest in (None, "", "sha256:invalid"):
            with self.subTest(digest=digest):
                api = FakeGoogleApi()
                lease = self.lease(api)
                lease.acquire()
                api.custom_metadata[native_deploy.INTENT_METADATA_KEY] = json.dumps({"webDeployRequested": {"baselineGeneration": "9", "expectedWebDigest": digest}})
                lease.release()
                self.assertEqual(api.deletes(), [])

    def test_legacy_lease_does_not_require_new_tokyo_service(self):
        api = FakeGoogleApi()
        api.web = native_deploy.ApiError(404)
        lease = self.lease(api)
        lease.acquire()
        lease.release()
        self.assertIsNone(api.owner)
        self.assertFalse(any("/services/salon-reserve-web" in url for method, url, payload in api.calls))

    def test_app_hosting_ids_are_deterministic_distinct_and_30_characters(self):
        actual = []
        for build_id, expected in APP_HOSTING_IDS.items():
            with self.subTest(build_id=build_id):
                self.assertEqual(native_deploy.app_hosting_id(build_id), expected)
                self.assertEqual(native_deploy.app_hosting_id(build_id), expected)
                self.assertEqual(len(expected), 30)
                self.assertRegex(expected, r"^native-[0-9a-f]{23}$")
                actual.append(native_deploy.app_hosting_id(build_id))
        self.assertEqual(len(set(actual)), len(APP_HOSTING_IDS))

    def test_recovery_looks_up_short_app_hosting_id_for_the_lock_owner(self):
        api = FakeGoogleApi({"buildId": OLD_BUILD_ID}, "SUCCESS")
        self.lease(api).acquire()
        app_urls = [url for method, url, _ in api.calls
                    if method == "GET" and "firebaseapphosting.googleapis.com" in url]
        backend = "https://firebaseapphosting.googleapis.com/v1beta/projects/salon-reserve-bg/locations/asia-east1/backends/salon-reserve-web"
        self.assertEqual(app_urls, [
            backend + "/builds/" + APP_HOSTING_IDS[OLD_BUILD_ID],
            backend + "/rollouts/" + APP_HOSTING_IDS[OLD_BUILD_ID],
        ])

PROVISION_JOB = f"projects/{native_deploy.PROJECT}/locations/{native_deploy.API_REGION}/jobs/reservation-tenant-provision"
PROVISION_EXECUTION = PROVISION_JOB + "/executions/reservation-tenant-provision-test"
PROVISION_OPERATION = f"projects/42401528382/locations/{native_deploy.API_REGION}/operations/provision-123"
PROVISION_VALUES = {"OWNER_EMAIL": "owner@example.test", "OWNER_DISPLAY_NAME": "Owner", "TENANT_NAME": "A, B | Co", "TENANT_SLUG": "test-salon", "SALON_NAME": "Salon", "TIMEZONE": "Asia/Tokyo"}


class FakeProvisionApi(FakeGoogleApi):
    def __init__(self):
        super().__init__()
        self.provision_job = None
        self.active_revision = {
            "serviceAccount": f"reservation-api-runtime@{native_deploy.PROJECT}.iam.gserviceaccount.com",
            "containers": [{"image": EXECUTION_IMAGE, "env": [{"name": "DATABASE_URL", "valueSource": {"secretKeyRef": {"secret": "reservation-database-url-tokyo", "version": "1"}}}]}],
        }
        self.service.update({"observedGeneration": "10", "latestReadyRevision": "reservation-api-00001-prod", "latestCreatedRevision": "reservation-api-00001-prod", "trafficStatuses": [{"revision": "reservation-api-00001-prod", "percent": 100}]})
        self.provision_operation = {"name": PROVISION_OPERATION, "done": True, "response": {"name": PROVISION_EXECUTION}}
        self.provision_execution = {"completionTime": "2026-10-23T00:00:00Z", "succeededCount": 1, "template": {"containers": [{"image": EXECUTION_IMAGE}]}}

    def request(self, method, url, payload=None):
        if "run.googleapis.com" in url:
            self.calls.append((method, url, payload))
            if url.endswith("/services/reservation-api"):
                return self.service
            if url.endswith("/revisions/reservation-api-00001-prod"):
                return self.active_revision
            if url.endswith(PROVISION_JOB):
                if self.provision_job is None:
                    raise native_deploy.ApiError(404)
                return self.provision_job
            if url.endswith(PROVISION_JOB + ":run"):
                assert method == "POST"
                return {"name": PROVISION_OPERATION}
            if url.endswith(PROVISION_OPERATION):
                return self.provision_operation
            if url.endswith(PROVISION_EXECUTION):
                return self.provision_execution
            raise AssertionError(url)
        return super().request(method, url, payload)

    def deploy(self, command, **kwargs):
        self.provision_job = {"generation": "1", "labels": {"tenant-provision-run": "12345-1"}, "terminalCondition": {"state": "CONDITION_SUCCEEDED"}, "template": {"template": {"serviceAccount": f"reservation-provisioner@{native_deploy.PROJECT}.iam.gserviceaccount.com", "vpcAccess": {"egress": "PRIVATE_RANGES_ONLY", "networkInterfaces": [{"network": "salon-reserve-vpc", "subnetwork": "salon-reserve-run-asia-northeast1"}]}, "containers": [{"image": EXECUTION_IMAGE, "env": [{"name": "DATABASE_URL", "valueSource": {"secretKeyRef": {"secret": "reservation-database-url-tokyo", "version": "1"}}}]}]}}}
        return native_deploy.subprocess.CompletedProcess(command, 0)


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(mock.patch.object(native_deploy.urllib.request, "urlopen", side_effect=AssertionError("No network in tests")))
        self.stack.enter_context(mock.patch.object(native_deploy.subprocess, "check_output", side_effect=AssertionError("No token in tests")))
        self.api = FakeProvisionApi()
        self.command = self.stack.enter_context(mock.patch.object(native_deploy.subprocess, "run", side_effect=self.api.deploy))
        self.clock = FakeClock()
        self.stack.enter_context(mock.patch.object(native_deploy.time, "monotonic", self.clock.monotonic))

    def run_provision(self, values=None):
        return native_deploy.run_provisioning(self.api, "12345-1", COMMIT, values or PROVISION_VALUES, sleep=self.clock.sleep)

    def test_current_serving_digest_and_fixed_tokyo_database_are_used(self):
        captured = {}
        def deploy(command, **kwargs):
            file = next(arg.removeprefix("--env-vars-file=") for arg in command if arg.startswith("--env-vars-file="))
            captured.update(json.loads(pathlib.Path(file).read_text()))
            return self.api.deploy(command, **kwargs)
        self.command.side_effect = deploy
        self.run_provision()
        command = self.command.call_args[0][0]
        for value in ("--image=" + EXECUTION_IMAGE, "--region=asia-northeast1", "--set-secrets=DATABASE_URL=reservation-database-url-tokyo:1", "--subnet=salon-reserve-run-asia-northeast1", "--max-retries=0"):
            self.assertIn(value, command)
        self.assertEqual(captured["PROVISION_TENANT_NAME"], "A, B | Co")
        self.assertEqual(len(self.api.deletes()), 1)
        self.assertIsNone(self.api.owner)

    def test_wrong_active_digest_secret_or_identity_never_starts_job(self):
        for bad in ("image", "secret", "identity"):
            with self.subTest(bad=bad):
                self.api = FakeProvisionApi()
                if bad == "image":
                    self.api.active_revision["containers"][0]["image"] = IMAGE
                elif bad == "secret":
                    self.api.active_revision["containers"][0]["env"][0]["valueSource"]["secretKeyRef"]["version"] = "latest"
                else:
                    self.api.active_revision["serviceAccount"] = "wrong"
                with self.assertRaises(RuntimeError):
                    self.run_provision()
                self.assertIsNone(self.api.owner)
        self.command.assert_not_called()

    def test_unobserved_or_split_api_traffic_never_starts_job(self):
        for bad in ("observed", "traffic", "ready", "pending"):
            with self.subTest(bad=bad):
                self.api = FakeProvisionApi()
                if bad == "observed":
                    self.api.service["observedGeneration"] = "9"
                elif bad == "traffic":
                    self.api.service["trafficStatuses"][0]["percent"] = 50
                elif bad == "ready":
                    self.api.service["latestCreatedRevision"] = "reservation-api-00002-new"
                else:
                    self.api.service["reconciling"] = True
                with self.assertRaises(RuntimeError):
                    self.run_provision()
        self.command.assert_not_called()

    def test_ambiguous_job_deploy_retains_shared_lease(self):
        self.command.side_effect = native_deploy.subprocess.TimeoutExpired("gcloud", 300)
        with self.assertRaisesRegex(RuntimeError, "deployment could not be verified"):
            self.run_provision()
        self.assertEqual(self.api.owner["kind"], "tenantProvisioning")
        self.assertEqual(self.api.deletes(), [])
        self.assertFalse(any(method == "POST" and url.endswith(":run") for method, url, _ in self.api.calls))

    def test_failed_execution_retains_shared_lease(self):
        self.api.provision_operation["error"] = {"code": 13}
        with self.assertRaisesRegex(RuntimeError, "execution failed"):
            self.run_provision()
        self.assertEqual(self.api.deletes(), [])
        self.assertEqual(self.api.custom_metadata["tenantProvisioningPhase"], "jobExecutionRequested")

    def test_unapproved_actual_job_identity_database_or_network_never_executes(self):
        for bad in ("identity", "secret", "subnet", "connector"):
            with self.subTest(bad=bad):
                self.api = FakeProvisionApi()
                def deploy(command, **kwargs):
                    result = self.api.deploy(command, **kwargs)
                    template = self.api.provision_job["template"]["template"]
                    if bad == "identity":
                        template["serviceAccount"] = "wrong"
                    elif bad == "secret":
                        template["containers"][0]["env"][0]["valueSource"]["secretKeyRef"]["version"] = "latest"
                    elif bad == "subnet":
                        template["vpcAccess"]["networkInterfaces"][0]["subnetwork"] = "salon-reserve-run-asia-east1"
                    else:
                        template["vpcAccess"]["connector"] = "old-connector"
                    return result
                self.command.side_effect = deploy
                with self.assertRaises(RuntimeError):
                    self.run_provision()
                self.assertFalse(any(method == "POST" and url.endswith(":run") for method, url, _ in self.api.calls))
                self.assertEqual(self.api.deletes(), [])

    def test_running_or_wrong_execution_image_retains_lease(self):
        for bad in ("completion", "image", "failed", "running"):
            with self.subTest(bad=bad):
                self.api = FakeProvisionApi()
                self.command.side_effect = self.api.deploy
                if bad == "completion":
                    self.api.provision_execution.pop("completionTime")
                elif bad == "image":
                    self.api.provision_execution["template"]["containers"][0]["image"] = WEB_DIGEST_IMAGE
                elif bad == "failed":
                    self.api.provision_execution["failedCount"] = 1
                else:
                    self.api.provision_execution["runningCount"] = 1
                with self.assertRaises(RuntimeError):
                    self.run_provision()
                self.assertEqual(self.api.deletes(), [])

    def test_existing_running_provision_job_keeps_fence(self):
        self.api.provision_job = {"generation": "3", "latestCreatedExecution": {"completionStatus": "EXECUTION_RUNNING"}}
        with self.assertRaisesRegex(RuntimeError, "already running"):
            self.run_provision()
        self.command.assert_not_called()
        self.assertEqual(self.api.deletes(), [])

    def test_lost_fence_prevents_job_deploy(self):
        self.api.before_patch = self.api.replace_with_live_owner
        with self.assertRaises(native_deploy.ApiError):
            self.run_provision()
        self.command.assert_not_called()
        self.assertEqual(self.api.owner["buildId"], OTHER_BUILD_ID)

    def test_validation_failure_does_not_acquire_lease(self):
        for key, value in (("OWNER_EMAIL", "bad"), ("TENANT_SLUG", "../other"), ("TIMEZONE", "Unknown/Timezone"), ("TENANT_NAME", "name\nsecond")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.run_provision(dict(PROVISION_VALUES, **{key: value}))
        self.assertEqual(self.api.calls, [])
        self.command.assert_not_called()

    def test_release_does_not_delete_replaced_owner(self):
        lease = native_deploy.ProvisioningLease(self.api, "12345-1", COMMIT, sleep=self.clock.sleep)
        lease.acquire()
        self.api.before_delete = self.api.replace_with_live_owner
        with self.assertRaisesRegex(RuntimeError, "changed before release"):
            lease.release()
        self.assertEqual(self.api.owner["buildId"], OTHER_BUILD_ID)


if __name__ == "__main__":
    unittest.main()
