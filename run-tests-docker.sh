#!/bin/sh
# Run the server test suite inside node:20-alpine (matches the production image).
# Usage (from repo root, after creating ionsync-src.zip):
#   powershell> Compress-Archive -Force -Path packages,package.json,package-lock.json,tsconfig.base.json -DestinationPath ionsync-src.zip
#   powershell> docker run --rm -v ${PWD}:/repo:ro node:20-alpine sh /repo/run-tests-docker.sh
set -e
apk add --no-cache python3 make g++ >/dev/null 2>&1
mkdir -p /app && cd /app
python3 - <<'PY'
import zipfile, os
z = zipfile.ZipFile('/repo/ionsync-src.zip')
n = 0
for info in z.infolist():
    name = info.filename.replace('\\', '/')
    if name.endswith('/') or '/node_modules/' in name or name.startswith('node_modules/'):
        continue
    dest = os.path.join('.', name)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    open(dest, 'wb').write(z.read(info))
    n += 1
print('extracted', n, 'files')
PY
npm install --no-audit --no-fund
cd packages/protocol && npx tsc && cd ../..
cd packages/server && npm test
