import contextlib
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
BUILD_PATH = f'{BACKEND}/builds/native-{BUILD}'
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
                return Response({'cloneUri': 'https://github.com/OIDEMA/other.git' if bad == 'wrong-repo' else 'https://github.com/OIDEMA/salon-reservation-system.git'})
            if url.endswith('/backends/salon-reserve-web'):
                return Response({'codebase': {'repository': LINK, 'rootDirectory': 'apps/web'}})
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
                name = 'build' if '/builds?' in url else 'rollout'
                return Response({'name': f'projects/42401528382/locations/asia-east1/operations/{name}'})
            if '/operations/' in url:
                return Response({'done': True})
            if '/builds/' in url:
                return Response({'state': 'READY', 'source': {'codebase': {'hash': 'b' * 40 if bad == 'wrong-build' else SHA, 'repository': LINK}}})
            if '/rollouts/' in url:
                return Response({'state': 'SUCCEEDED', 'build': BUILD_PATH})
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

        env = dict(ENV, **(changes or {}))
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
        writes = [data for method, _, data in self.requests if method == 'POST']
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
                app_writes = [request for request in self.requests if request[0] == 'POST']
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


if __name__ == '__main__':
    unittest.main()
