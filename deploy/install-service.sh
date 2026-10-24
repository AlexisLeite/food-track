#!/bin/bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
backup_dir=$(mktemp -d /var/backups/foodtrack-independent-storage-XXXXXXXX)
for file in /etc/systemd/system/foodtrack.service \
    /etc/systemd/system/foodtrack.service.d/audio-archive.conf \
    /etc/systemd/system/foodtrack.service.d/external-disk-recovery.conf \
    /repos/foodtrack/data/audio-debug/persistent.json; do
    if [[ -f $file ]]; then cp --parents -- "$file" "$backup_dir"; fi
done
install -m 0644 "$source_dir/foodtrack.service" /etc/systemd/system/foodtrack.service
# These two legacy drop-ins made the whole app depend on the external mount.
rm -f /etc/systemd/system/foodtrack.service.d/audio-archive.conf \
    /etc/systemd/system/foodtrack.service.d/external-disk-recovery.conf
python3 - <<'PY'
import json, os
from pathlib import Path
config = Path('/repos/foodtrack/data/audio-debug/persistent.json')
if config.exists():
    data = json.loads(config.read_text())
    data.update(mountPoint='/mnt/scraper-db', mountUuid='301f3153-374a-4a01-99ba-7d9979e3bf01')
    temporary = config.with_suffix('.tmp')
    with temporary.open('w') as output:
        os.chmod(temporary, 0o600)
        json.dump(data, output)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(config)
PY
systemctl daemon-reload
systemctl enable foodtrack.service
systemctl restart foodtrack.service
echo "Foodtrack installed; previous service configuration: $backup_dir"
