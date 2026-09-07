import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, build_opener

APP = 'mochi'
REPOSITORY = 'Sappanwood/' + APP
ACA = 'mochi-agent'
REGISTRY = 'mochia4c005ba3f.azurecr.io'
ORIGIN = 'https://mochiadmin.whitemeadow-6e32159b.eastus.azurecontainerapps.io'
ANON_PATH = '/admin/providers'
SUBSCRIPTION = '7a7f509c-7a7a-41ee-bd40-9b03eb33dfc1'


def validate_manifest(value):
    if (value.get('repository') != REPOSITORY
            or not re.fullmatch(re.escape(REGISTRY + '/' + APP + '@sha256:') + '[0-9a-f]{64}', value.get('image', ''))
            or not re.fullmatch('[0-9a-f]{40}', value.get('commit', ''))
            or not re.fullmatch('[1-9][0-9]*', value.get('run_id', ''))):
        raise ValueError('Expected this repository, immutable ACR digest, commit SHA and numeric build run ID')


def validate_run(run, manifest):
    validate_manifest(manifest)
    if (str(run.get('id')) != manifest['run_id'] or run.get('head_sha') != manifest['commit']
            or run.get('head_branch') != 'main' or run.get('event') != 'push'
            or run.get('conclusion') != 'success' or run.get('path') != '.github/workflows/ci.yml'
            or run.get('repository', {}).get('full_name') != REPOSITORY):
        raise ValueError('Select a successful main push run of this repository CI workflow')


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=600)
    if result.returncode:
        # Azure responses can include configuration; expose only the failed operation.
        raise RuntimeError('Command failed: ' + ' '.join(args[:3]) + f' (exit {result.returncode})')
    return json.loads(result.stdout) if result.stdout.strip() else None


def ready(status, image):
    return (status.get('image') == image and status.get('status') == 'Running'
            and bool(status.get('latest')) and status['latest'] == status.get('ready'))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_status(url):
    try:
        with build_opener(NoRedirect).open(url, timeout=30) as response:
            return response.status
    except HTTPError as error:
        return error.code


def smoke():
    checks = [('/', 200), (ANON_PATH, 401)]
    for path, expected in checks:
        for attempt in range(6):
            try:
                status = http_status(ORIGIN + path)
            except (TimeoutError, URLError):
                status = None
            if status == expected:
                break
            if status not in (None, 502, 503, 504):
                raise ValueError('Unexpected public response: ' + path + f' ({status}, expected {expected})')
            if attempt == 5:
                raise ValueError('Public check timed out: ' + path)
            time.sleep(10)


def release(manifest):
    validate_manifest(manifest)
    image = manifest['image']
    digest = command(['az', 'acr', 'manifest', 'show-metadata', '--registry', REGISTRY.split('.')[0],
                      '--name', image.split('/', 1)[1], '--query', 'digest', '--output', 'json'])
    if digest != image.split('@')[1]:
        raise ValueError('ACR digest readback mismatch')
    show = ['az', 'containerapp', 'show', '--name', ACA, '--resource-group', 'mochi-shared', '--query',
            "{image:properties.template.containers[0].image,latest:properties.latestRevisionName,ready:properties.latestReadyRevisionName,status:properties.runningStatus}", '--output', 'json']
    before = command(show)
    if APP == 'mochi' and before.get('status') != 'Stopped':
        raise ValueError('Mochi must be stopped by the operator before manual publishing')
    command(['az', 'containerapp', 'update', '--name', ACA, '--resource-group', 'mochi-shared',
             '--container-name', APP, '--image', image, '--output', 'none'])
    status = command(show)
    if APP == 'mochi' and status.get('status') == 'Stopped':
        command(['az', 'rest', '--method', 'post', '--url', 'https://management.azure.com/subscriptions/' + SUBSCRIPTION
                 + '/resourceGroups/mochi-shared/providers/Microsoft.App/containerApps/' + ACA
                 + '/start?api-version=2025-07-01', '--output', 'none'])
    for _ in range(60):
        status = command(show)
        if ready(status, image):
            break
        time.sleep(10)
    else:
        raise ValueError('Timed out waiting for the requested image and ready revision')
    smoke()
    return dict(manifest, revision=status['latest'], result='succeeded')


def main():
    parser = argparse.ArgumentParser(description='Publish a verified build to the existing application ACA.')
    parser.add_argument('operation', choices=['record', 'resolve', 'deploy'])
    parser.add_argument('--file', default='release/image.json')
    parser.add_argument('--run-id')
    args = parser.parse_args()
    if os.environ.get('GITHUB_REPOSITORY') != REPOSITORY or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise ValueError('Publishing requires this repository main branch')
    target = Path(args.file)
    if args.operation == 'record':
        value = {'repository': REPOSITORY, 'image': os.environ['BUILD_IMAGE'],
                 'commit': os.environ['GITHUB_SHA'], 'run_id': os.environ['GITHUB_RUN_ID']}
        validate_manifest(value)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value, indent=2) + '\n')
    elif args.operation == 'resolve':
        if not re.fullmatch('[1-9][0-9]*', args.run_id or ''):
            raise ValueError('Build run ID must be numeric')
        run = command(['gh', 'api', f'repos/{REPOSITORY}/actions/runs/{args.run_id}'])
        target.parent.mkdir(parents=True, exist_ok=True)
        command(['gh', 'run', 'download', args.run_id, '--repo', REPOSITORY, '--name', 'image', '--dir', str(target.parent)])
        value = json.loads(target.read_text())
        validate_run(run, value)
    else:
        value = release(json.loads(target.read_text()))
        target.with_name('deployment.json').write_text(json.dumps(value, indent=2) + '\n')
    print(json.dumps(value))
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write('```json\n' + json.dumps(value, indent=2) + '\n```\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, KeyError, URLError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from None
