import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('deploy.py'))
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


class DeployTests(unittest.TestCase):
    def manifest(self):
        return {'image': deploy.REGISTRY + '/' + deploy.APP + '@sha256:' + 'a' * 64,
                'commit': 'b' * 40, 'run_id': '123', 'repository': deploy.REPOSITORY}

    def test_manifest_rejects_mutable_foreign_and_injected_images(self):
        deploy.validate_manifest(self.manifest())
        for image in ['latest', self.manifest()['image'] + ';echo bad', self.manifest()['image'].replace(deploy.REGISTRY, 'evil.invalid')]:
            with self.subTest(image=image), self.assertRaises(ValueError):
                deploy.validate_manifest(dict(self.manifest(), image=image))
        for field, value in [('commit', 'bad'), ('run_id', '../1'), ('repository', 'other/repo')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                deploy.validate_manifest(dict(self.manifest(), **{field: value}))

    def test_only_successful_main_build_can_be_selected(self):
        run = {'id': 123, 'head_branch': 'main', 'event': 'push', 'conclusion': 'success',
               'path': '.github/workflows/ci.yml', 'head_sha': 'b' * 40,
               'repository': {'full_name': deploy.REPOSITORY}}
        deploy.validate_run(run, self.manifest())
        for field, value in [('head_branch', 'dev'), ('event', 'pull_request'), ('conclusion', 'failure'),
                             ('path', '.github/workflows/other.yml'), ('id', 124), ('head_sha', 'c' * 40)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                deploy.validate_run(dict(run, **{field: value}), self.manifest())

    def test_update_failure_never_checks_or_reports_success(self):
        with patch.object(deploy, 'command', side_effect=RuntimeError('failed')), patch.object(deploy, 'smoke') as smoke:
            with self.assertRaises(RuntimeError):
                deploy.release(self.manifest())
            smoke.assert_not_called()

    def test_image_mismatch_or_failed_readiness_cannot_pass(self):
        self.assertFalse(deploy.ready({'image': 'wrong', 'latest': 'r1', 'ready': 'r1', 'status': 'Running'}, self.manifest()['image']))
        self.assertFalse(deploy.ready({'image': self.manifest()['image'], 'latest': 'r1', 'ready': 'old', 'status': 'Running'}, self.manifest()['image']))
        self.assertTrue(deploy.ready({'image': self.manifest()['image'], 'latest': 'r1', 'ready': 'r1', 'status': 'Running'}, self.manifest()['image']))

    def test_smoke_rejects_successful_anonymous_business_access(self):
        with patch.object(deploy, 'http_status', return_value=200):
            with self.assertRaises(ValueError):
                deploy.smoke()

    def test_smoke_accepts_expected_routes(self):
        with patch.object(deploy, 'http_status', side_effect=lambda url: 401 if url.endswith(deploy.ANON_PATH) else 200):
            deploy.smoke()

    def test_running_mochi_is_not_updated(self):
        if deploy.APP != 'mochi':
            return
        calls = []
        def command(args):
            calls.append(args)
            if args[:3] == ['az', 'acr', 'manifest']:
                return 'sha256:' + 'a' * 64
            return {'status': 'Running'}
        with patch.object(deploy, 'command', side_effect=command):
            with self.assertRaisesRegex(ValueError, 'stopped by the operator'):
                deploy.release(self.manifest())
        self.assertFalse(any('update' in args for args in calls))

    def test_missing_registry_digest_is_not_deployed(self):
        with patch.object(deploy, 'command', return_value='sha256:' + 'c' * 64) as command:
            with self.assertRaisesRegex(ValueError, 'digest readback mismatch'):
                deploy.release(self.manifest())
        self.assertEqual(command.call_count, 1)

    def test_release_updates_only_named_image_then_checks_readiness(self):
        calls = []
        def command(args):
            calls.append(args)
            if args[:3] == ['az', 'acr', 'manifest']:
                return 'sha256:' + 'a' * 64
            if args[:3] == ['az', 'containerapp', 'show']:
                return {'image': self.manifest()['image'], 'latest': 'r1', 'ready': 'r1',
                        'status': 'Stopped' if deploy.APP == 'mochi' and not any('update' in c for c in calls) else 'Running'}
        with patch.object(deploy, 'command', side_effect=command), patch.object(deploy, 'smoke') as smoke:
            deploy.release(self.manifest())
        update = next(args for args in calls if args[:3] == ['az', 'containerapp', 'update'])
        self.assertEqual(update, ['az', 'containerapp', 'update', '--name', deploy.ACA, '--resource-group', 'mochi-shared',
                                  '--container-name', deploy.APP, '--image', self.manifest()['image'], '--output', 'none'])
        smoke.assert_called_once()


if __name__ == '__main__':
    unittest.main()
