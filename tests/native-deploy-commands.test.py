import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

SOURCE = (Path(__file__).resolve().parents[1] / 'scripts' / 'deploy-native.sh').read_text().split("python3 - <<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
SHA = 'a' * 40
BUILD = '11111111-2222-3333-4444-555555555555'
LINK = 'projects/salon-reserve-bg/locations/asia-east1/connections/firebase/gitRepositoryLinks/salon-reservation-system'
BACKEND = 'projects/salon-reserve-bg/locations/asia-east1/backends/salon-reserve-web'
APP_ID = 'native-666ff6ccaa5b3c07feaa3a9'
BUILD_PATH = f'{BACKEND}/builds/{APP_ID}'
ENV = {
    'PROJECT_ID': 'salon-reserve-bg', 'PROJECT_NUMBER': '42401528382', 'REGION': 'asia-east1',
    'API_SERVICE': 'reservation-api', 'CHART_PHOTOS_BUCKET': 'salon-reserve-bg-chart-photos',
    'API_RUNTIME_SERVICE_ACCOUNT': 'reservation-api-runtime@salon-reserve-bg.iam.gserviceaccount.com',
    'DB_INSTANCE': 'salon-reserve-db', 'VPC_NETWORK': 'salon-reserve-vpc',
    'VPC_SUBNET': 'salon-reserve-run-asia-east1', 'APP_HOSTING_BACKEND': 'salon-reserve-web',
    'GIT_REPOSITORY_LINK': LINK, 'COMMIT_SHA': SHA, 'BUILD_ID': BUILD,
    'NATIVE_DEPLOY_LOCK_GENERATION': '123456789',
    'API_IMAGE': f'asia-east1-docker.pkg.dev/salon-reserve-bg/cloud-run-source-deploy/reservation-api:{SHA}-{BUILD}',
}


class Response(io.BytesIO):
    def __init__(self, value):
        super().__init__((json.dumps(value) if not isinstance(value, str) else value).encode())


class NativeDeploymentTests(unittest.TestCase):
    def run_deploy(self, changes=None, bad=None):
        self.commands = []
        self.requests = []
        self.events = []
        self.validation_attempts = 0
        self.real_rollout_created = False
        self.build_reads = 0
        self.backend_reads = 0
        self.link_reads = 0
        env = dict(ENV, **(changes or {}))
        active_app_id = 'native-' + hashlib.sha256(env['BUILD_ID'].encode('utf-8')).hexdigest()[:23]
        active_build_path = f'{BACKEND}/builds/{active_app_id}'
        def run(command, **kwargs):
            self.commands.append(command)
            self.events.append(('command', command))
            output = ''
            if command[:3] == ['python3', 'scripts/native-deploy.py', 'mark-intent']:
                phase = command[command.index('--phase') + 1]
                if bad == 'intent-' + phase:
                    raise subprocess.CalledProcessError(1, command)
            if command[1:3] == ['auth', 'print-access-token']:
                output = 'test-token'
            elif command[1:4] == ['sql', 'instances', 'describe']:
                output = json.dumps({'settings': {'ipConfiguration': {
                    'ipv4Enabled': bad == 'public-db',
                    'privateNetwork': 'projects/salon-reserve-bg/global/networks/salon-reserve-vpc',
                }}})
            elif command[1:4] == ['storage', 'buckets', 'describe']:
                output = json.dumps({'uniform_bucket_level_access': True, 'public_access_prevention': 'inherited' if bad == 'public-storage' else 'enforced'})
            elif command[1:4] in (['run', 'jobs', 'describe'], ['run', 'services', 'describe']):
                output = json.dumps({'spec': {'template': {'metadata': {'annotations': {
                    'run.googleapis.com/network-interfaces': json.dumps([{'network': 'salon-reserve-vpc', 'subnetwork': 'salon-reserve-run-asia-east1'}]),
                }}}}})
            return SimpleNamespace(stdout=output)

        def open_url(request, timeout=None):
            url = request if isinstance(request, str) else request.full_url
            method = 'GET' if isinstance(request, str) else request.get_method()
            data = None if isinstance(request, str) or request.data is None else json.loads(request.data)
            self.requests.append((method, url, data))
            self.events.append(('request', method, url, data))
            if 'developerconnect.googleapis.com' in url:
                self.link_reads += 1
                wrong = bad == 'wrong-repo' or (bad == 'source-clone-changed' and self.link_reads > 1)
                return Response({'cloneUri': 'https://github.com/OIDEMA/other.git' if wrong else 'https://github.com/OIDEMA/salon-reservation-system.git'})
            if url.endswith('/backends/salon-reserve-web'):
                self.backend_reads += 1
                codebase = {'repository': LINK, 'rootDirectory': 'apps/web'}
                if bad == 'source-backend-link-changed' and self.backend_reads > 1:
                    codebase['repository'] = LINK.replace('/connections/firebase/', '/connections/other/')
                if bad == 'source-backend-root-changed' and self.backend_reads > 1:
                    codebase['rootDirectory'] = 'apps/other'
                if bad == 'source-final-backend-changed' and self.backend_reads > 2:
                    codebase['repository'] = LINK.replace('/connections/firebase/', '/connections/other/')
                return Response({'codebase': codebase})
            if url.endswith('/traffic'):
                policy = {} if bad == 'rollout-policy-missing' else {'disabled': False if bad == 'auto-rollout' else ('true' if bad == 'rollout-policy-string' else True)}
                return Response({'rolloutPolicy': policy})
            if url.endswith('/jobs/reservation-db-migrate'):
                latest = None if bad == 'no-execution' else {'name': f'projects/salon-reserve-bg/locations/asia-east1/jobs/reservation-db-migrate/executions/previous'}
                if bad == 'wrong-execution':
                    latest = {'name': 'projects/other/locations/asia-east1/jobs/reservation-db-migrate/executions/previous'}
                if bad == 'short-execution':
                    latest = {'name': 'reservation-db-migrate-8z99g'}
                return Response({
                    'generation': None if bad == 'job-generation-missing' else '10',
                    'latestCreatedExecution': latest,
                })
            if url.endswith('/services/reservation-api'):
                return Response({'generation': '20'})
            if method == 'POST':
                if '/builds?' in url and bad == 'build-id-error':
                    body = {'error': {'code': 400, 'message': 'build_id must have length between 3 and 30.\nAuthorization: Bearer test-token\nHeaders: {"Cookie":"top-secret"}', 'details': [{'headers': {'secret': 'hidden-detail'}}]}}
                    raise urllib.error.HTTPError(url, 400, 'bad request', {'Authorization': 'private-header'}, Response(body))
                if 'validateOnly=true' in url:
                    self.validation_attempts += 1
                    status = 403 if bad == 'validation-fatal' else 400
                    if bad in ('validation-fatal', 'validation-always400') or (bad == 'validation-pending' and self.validation_attempts < 3):
                        raise urllib.error.HTTPError(url, status, 'validation error', {}, Response({'error': {'message': 'Build reference is not ready.'}}))
                    return Response({'name': 'projects/42401528382/locations/asia-east1/operations/validation'})
                if '/rollouts?' in url:
                    self.real_rollout_created = True
                name = 'build' if '/builds?' in url else 'rollout'
                return Response({'name': f'projects/42401528382/locations/asia-east1/operations/{name}'})
            if '/operations/' in url:
                if bad == 'operation-error':
                    return Response({'done': True, 'error': {'code': 7, 'message': 'Build compilation failed.\nAuthorization: Bearer test-token\nHeaders: {"Cookie":"top-secret"}'}})
                return Response({'done': True})
            if '/builds/' in url:
                self.build_reads += 1
                state = 'READY' if self.real_rollout_created else 'BUILT'
                if bad == 'build-pending' and self.build_reads == 1:
                    state = 'BUILDING'
                source = {
                    'hash': 'b' * 40 if bad == 'wrong-build' else SHA,
                    'commit': SHA, 'repository': LINK,
                    'uri': f'https://github.com/OIDEMA/salon-reservation-system/commit/{SHA}',
                }
                if bad and bad.startswith('source-') and not bad.startswith('source-explicit-'):
                    source.pop('repository')
                if bad == 'source-wrong-uri':
                    source['uri'] = f'https://github.com/OIDEMA/other/commit/{SHA}'
                if bad == 'source-missing-uri':
                    source.pop('uri')
                if bad == 'source-missing-hash':
                    source.pop('hash')
                if bad == 'source-wrong-commit':
                    source['commit'] = 'b' * 40
                if bad == 'source-no-repository-no-commit':
                    source.pop('commit')
                if bad == 'source-explicit-wrong-repository':
                    source['repository'] = LINK.replace('/connections/firebase/', '/connections/other/')
                if bad == 'source-explicit-empty-repository':
                    source['repository'] = ''
                if bad == 'source-explicit-null-repository':
                    source['repository'] = None
                if bad == 'source-explicit-wrong-commit':
                    source['commit'] = 'b' * 40
                return Response({'state': state, 'source': {'codebase': source}})
            if '/rollouts/' in url:
                return Response({'state': 'SUCCEEDED', 'build': active_build_path})
            if url.endswith('/login'):
                return Response('サロン管理へログイン')
            if url.endswith('/ready'):
                return Response('ready')
            if url.endswith('/api/calendar/backend/dashboard'):
                raise urllib.error.HTTPError(url, 404, 'not found', {}, None)
            raise AssertionError(url)

        class Opener:
            def open(self, url, timeout=None):
                raise urllib.error.HTTPError(url, 307, 'redirect', {'Location': '/login'}, None)

        with patch.dict(os.environ, env, clear=True), patch('subprocess.run', side_effect=run), patch('urllib.request.urlopen', side_effect=open_url), patch('urllib.request.build_opener', return_value=Opener()), patch('time.sleep'), contextlib.redirect_stdout(io.StringIO()):
            exec(compile(SOURCE, 'deploy-native', 'exec'), {})

    def test_preflight_does_not_deploy(self):
        with self.assertRaises(SystemExit) as error:
            self.run_deploy({'DEPLOY_PREFLIGHT_ONLY': '1'})
        self.assertEqual(error.exception.code, 0)
        self.assertFalse(any(command[1:2] == ['run'] for command in self.commands))
        self.assertFalse(any(method == 'POST' for method, _, _ in self.requests))

    def test_production_commands_and_rollout_use_one_commit(self):
        self.run_deploy()
        mutations = [command for command in self.commands if command[1:2] == ['run'] and (command[2] == 'deploy' or command[3] in ('deploy', 'execute'))]
        self.assertEqual([command[1:4] for command in mutations], [['run', 'jobs', 'deploy'], ['run', 'jobs', 'execute'], ['run', 'deploy', 'reservation-api']])
        self.assertIn(f"--image={ENV['API_IMAGE']}", mutations[0])
        self.assertIn('--set-secrets=DATABASE_URL=reservation-database-url:latest', mutations[0])
        self.assertIn('--max-retries=0', mutations[0])
        self.assertIn(f'--labels=native-deploy-build={BUILD}', mutations[0])
        self.assertIn('--wait', mutations[1])
        self.assertIn(f"--image={ENV['API_IMAGE']}", mutations[2])
        self.assertIn(f'--labels=native-deploy-build={BUILD}', mutations[2])
        api_environment = next(value for value in mutations[2] if value.startswith("--set-env-vars="))
        self.assertIn("MEMBER_BOOKING_TENANTS=mens-gentle:gentle;missmrs-takamatsu:missmrs", api_environment)
        self.assertNotIn("FIREBASE_AUTH_EMULATOR_HOST", api_environment)
        writes = [data for method, url, data in self.requests if method == 'POST' and 'validateOnly=true' not in url]
        self.assertEqual(writes, [{'source': {'codebase': {'commit': SHA}}}, {'build': BUILD_PATH}])

    def test_each_mutation_has_an_intent_written_immediately_before_it(self):
        self.run_deploy()
        expected = [
            ('jobDeployRequested', '10'),
            ('jobExecutionRequested', 'projects/salon-reserve-bg/locations/asia-east1/jobs/reservation-db-migrate/executions/previous'),
            ('apiDeployRequested', '20'),
            ('appBuildRequested', None),
            ('appRolloutRequested', None),
        ]
        intents = [event for event in self.events if event[0] == 'command' and event[1][:3] == ['python3', 'scripts/native-deploy.py', 'mark-intent']]
        self.assertEqual(len(intents), len(expected))
        for intent, (phase, baseline) in zip(intents, expected):
            command = intent[1]
            self.assertEqual(command[command.index('--generation') + 1], ENV['NATIVE_DEPLOY_LOCK_GENERATION'])
            self.assertEqual(command[command.index('--phase') + 1], phase)
            if baseline is None:
                self.assertNotIn('--baseline', command)
            else:
                self.assertEqual(command[command.index('--baseline') + 1], baseline)
            following = self.events[self.events.index(intent) + 1]
            if phase == 'appBuildRequested':
                self.assertEqual(following[0:2], ('request', 'POST'))
                self.assertIn('/builds?', following[2])
            elif phase == 'appRolloutRequested':
                self.assertEqual(following[0:2], ('request', 'POST'))
                self.assertIn('/rollouts?', following[2])
            else:
                self.assertEqual(following[0], 'command')
                self.assertEqual(following[1][0:2], ['gcloud', 'run'])

    def test_failed_intent_record_never_runs_its_mutation(self):
        phases = ['jobDeployRequested', 'jobExecutionRequested', 'apiDeployRequested', 'appBuildRequested', 'appRolloutRequested']
        for completed, phase in enumerate(phases):
            with self.subTest(phase=phase):
                with self.assertRaises(subprocess.CalledProcessError):
                    self.run_deploy(bad='intent-' + phase)
                mutations = [command for command in self.commands if command[1:2] == ['run'] and (command[2] == 'deploy' or command[3] in ('deploy', 'execute'))]
                app_writes = [request for request in self.requests if request[0] == 'POST' and 'validateOnly=true' not in request[1]]
                self.assertEqual(len(mutations) + len(app_writes), completed)

    def test_automatic_rollouts_must_be_explicitly_disabled(self):
        for bad in ('auto-rollout', 'rollout-policy-missing', 'rollout-policy-string'):
            with self.subTest(policy=bad):
                with self.assertRaises(SystemExit):
                    self.run_deploy(bad=bad)
                self.assertFalse(any(command[1:2] == ['run'] for command in self.commands))
                self.assertFalse(any(method == 'POST' for method, _, _ in self.requests))

    def test_unknown_cloud_run_generation_prevents_job_deployment(self):
        with self.assertRaises(RuntimeError):
            self.run_deploy(bad='job-generation-missing')
        self.assertFalse(any(command[1:2] == ['run'] for command in self.commands))

    def test_job_without_previous_execution_records_empty_baseline(self):
        self.run_deploy(bad='no-execution')
        intent = next(command for command in self.commands if command[:3] == ['python3', 'scripts/native-deploy.py', 'mark-intent'] and 'jobExecutionRequested' in command)
        self.assertEqual(intent[intent.index('--baseline') + 1], '')

    def test_unknown_execution_scope_prevents_job_execute(self):
        with self.assertRaises(RuntimeError):
            self.run_deploy(bad='wrong-execution')
        self.assertFalse(any(command[1:4] == ['run', 'jobs', 'execute'] for command in self.commands))

    def test_cloud_run_short_execution_baseline_is_preserved(self):
        self.run_deploy(bad='short-execution')
        intent = next(command for command in self.commands if command[:3] == ['python3', 'scripts/native-deploy.py', 'mark-intent'] and 'jobExecutionRequested' in command)
        self.assertEqual(intent[intent.index('--baseline') + 1], 'reservation-db-migrate-8z99g')

    def test_wrong_project_rejected_before_cloud_access(self):
        with self.assertRaises(SystemExit):
            self.run_deploy({'PROJECT_ID': 'other-project'})
        self.assertEqual(self.commands, [])
        self.assertEqual(self.requests, [])

    def test_missing_lease_rejected_before_cloud_access(self):
        with self.assertRaises(SystemExit):
            self.run_deploy({'NATIVE_DEPLOY_LOCK_GENERATION': ''})
        self.assertEqual(self.commands, [])
        self.assertEqual(self.requests, [])

    def test_an_image_from_a_different_build_of_the_same_commit_is_rejected(self):
        with self.assertRaises(SystemExit):
            self.run_deploy({'API_IMAGE': f'asia-east1-docker.pkg.dev/salon-reserve-bg/cloud-run-source-deploy/reservation-api:{SHA}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'})
        self.assertEqual(self.commands, [])
        self.assertEqual(self.requests, [])

    def test_wrong_repo_rejected_before_mutation(self):
        with self.assertRaises(SystemExit):
            self.run_deploy(bad='wrong-repo')
        self.assertFalse(any(command[1:2] == ['run'] for command in self.commands))

    def test_public_database_rejected_before_mutation(self):
        with self.assertRaises(SystemExit):
            self.run_deploy(bad='public-db')
        self.assertFalse(any(command[1:2] == ['run'] for command in self.commands))

    def test_public_storage_rejected_before_mutation(self):
        with self.assertRaises(SystemExit):
            self.run_deploy(bad='public-storage')
        self.assertFalse(any(command[1:2] == ['run'] for command in self.commands))

    def test_mismatched_frontend_commit_never_rolls_out(self):
        with self.assertRaises(RuntimeError):
            self.run_deploy(bad='wrong-build')
        self.assertFalse(any(method == 'POST' and '/rollouts?' in url for method, url, _ in self.requests))

    def test_repository_output_can_be_omitted_only_with_uri_and_fresh_connection_checks(self):
        for bad in ('source-no-repository', 'source-no-repository-no-commit'):
            with self.subTest(source=bad):
                self.run_deploy(bad=bad)
                self.assertTrue(self.real_rollout_created)
                self.assertEqual(self.backend_reads, 3)
                self.assertEqual(self.link_reads, 3)
                real_index = next(i for i, (method, url, _) in enumerate(self.requests) if method == 'POST' and '/rollouts?' in url and 'validateOnly=true' not in url)
                self.assertEqual(sum(url.endswith('/backends/salon-reserve-web') for _, url, _ in self.requests[:real_index]), 2)
                self.assertEqual(sum(url.endswith('/backends/salon-reserve-web') for _, url, _ in self.requests[real_index + 1:]), 1)

    def test_omitted_repository_rejects_missing_or_wrong_source_evidence(self):
        for bad in ('source-wrong-uri', 'source-missing-uri', 'source-missing-hash', 'source-wrong-commit'):
            with self.subTest(source=bad):
                with self.assertRaises(RuntimeError):
                    self.run_deploy(bad=bad)
                self.assertFalse(self.real_rollout_created)
                self.assertEqual(self.backend_reads, 1)

    def test_explicit_wrong_empty_or_null_repository_never_uses_the_uri_fallback(self):
        for bad in ('source-explicit-wrong-repository', 'source-explicit-empty-repository', 'source-explicit-null-repository'):
            with self.subTest(repository=bad):
                with self.assertRaises(RuntimeError):
                    self.run_deploy(bad=bad)
                self.assertFalse(self.real_rollout_created)
                self.assertEqual(self.backend_reads, 1)
                self.assertEqual(self.link_reads, 1)

    def test_changed_backend_or_repository_clone_blocks_the_fallback_before_rollout(self):
        for bad in ('source-backend-link-changed', 'source-backend-root-changed', 'source-clone-changed'):
            with self.subTest(connection=bad):
                with self.assertRaises(RuntimeError):
                    self.run_deploy(bad=bad)
                self.assertFalse(self.real_rollout_created)
                self.assertEqual(self.backend_reads, 2)

    def test_repository_fallback_is_revalidated_at_ready_not_only_before_rollout(self):
        with self.assertRaises(RuntimeError):
            self.run_deploy(bad='source-final-backend-changed')
        self.assertTrue(self.real_rollout_created)
        self.assertEqual(self.backend_reads, 3)

    def test_optional_commit_when_present_must_match_even_with_explicit_repository(self):
        with self.assertRaises(RuntimeError):
            self.run_deploy(bad='source-explicit-wrong-commit')
        self.assertFalse(self.real_rollout_created)

    def test_app_hosting_ids_are_short_deterministic_and_shared_by_build_and_rollout(self):
        cases = (
            (BUILD, APP_ID),
            ('11111111-1111-4111-8111-111111111111', 'native-bd7662a5eeb41614e720d47'),
        )
        for build, expected_id in cases:
            with self.subTest(build=build):
                self.run_deploy({'BUILD_ID': build, 'API_IMAGE': f'asia-east1-docker.pkg.dev/salon-reserve-bg/cloud-run-source-deploy/reservation-api:{SHA}-{build}'})
                self.assertEqual(len(expected_id), 30)
                self.assertEqual(expected_id, 'native-' + hashlib.sha256(build.encode('utf-8')).hexdigest()[:23])
                create_build = next(url for method, url, _ in self.requests if method == 'POST' and '/builds?' in url)
                rollout = next((url, payload) for method, url, payload in self.requests if method == 'POST' and '/rollouts?' in url and 'validateOnly=true' not in url)
                self.assertTrue(create_build.endswith('buildId=' + expected_id))
                self.assertTrue(rollout[0].endswith('rolloutId=' + expected_id))
                self.assertEqual(rollout[1]['build'], f'{BACKEND}/builds/{expected_id}')

    def test_compiled_source_is_checked_and_rollout_is_created_before_lro_waits(self):
        self.run_deploy(bad='build-pending')
        actual_index = next(i for i, event in enumerate(self.events) if event[0:2] == ('request', 'POST') and '/rollouts?' in event[2] and 'validateOnly=true' not in event[2])
        previous = [event for event in self.events[:actual_index] if event[0] == 'request']
        self.assertGreaterEqual(sum(event[1] == 'GET' and '/builds/' in event[2] for event in previous), 2)
        self.assertTrue(any(event[1] == 'POST' and 'validateOnly=true' in event[2] for event in previous))
        self.assertFalse(any('/operations/' in event[2] for event in previous))
        following = [event[2] for event in self.events[actual_index + 1:] if event[0] == 'request' and event[1] == 'GET']
        self.assertIn('/operations/build', following[0])
        self.assertIn('/operations/rollout', following[1])
        self.assertIn('/builds/' + APP_ID, following[2])
        self.assertIn('/rollouts/' + APP_ID, following[3])

    def test_rollout_validation_retries_400_without_repeating_real_rollout(self):
        self.run_deploy(bad='validation-pending')
        self.assertEqual(self.validation_attempts, 3)
        real = [request for request in self.requests if request[0] == 'POST' and '/rollouts?' in request[1] and 'validateOnly=true' not in request[1]]
        self.assertEqual(len(real), 1)

    def test_validation_failure_or_exhaustion_never_creates_real_rollout(self):
        for bad, attempts in (('validation-fatal', 1), ('validation-always400', 10)):
            with self.subTest(bad=bad):
                with self.assertRaises(RuntimeError):
                    self.run_deploy(bad=bad)
                self.assertEqual(self.validation_attempts, attempts)
                self.assertFalse(self.real_rollout_created)
                self.assertFalse(any('appRolloutRequested' in command for command in self.commands))

    def test_http_diagnostics_include_safe_message_without_tokens_headers_or_details(self):
        with self.assertRaises(RuntimeError) as error:
            self.run_deploy(bad='build-id-error')
        message = str(error.exception)
        self.assertIn('build_id must have length between 3 and 30.', message)
        for secret in ('test-token', 'top-secret', 'hidden-detail', 'private-header', 'Authorization:', 'Headers:'):
            self.assertNotIn(secret, message)

    def test_operation_diagnostics_redact_authorization_and_headers(self):
        with self.assertRaises(RuntimeError) as error:
            self.run_deploy(bad='operation-error')
        message = str(error.exception)
        self.assertIn('Build compilation failed.', message)
        for secret in ('test-token', 'top-secret', 'Authorization:', 'Headers:'):
            self.assertNotIn(secret, message)


if __name__ == '__main__':
    unittest.main()
