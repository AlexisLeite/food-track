#!/usr/bin/env bash
set -euo pipefail
umask 077
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -t 0 ]]; then
  echo 'Ejecutá este script desde una terminal interactiva.' >&2
  exit 1
fi
trap 'unset password confirmation' EXIT
IFS= read -r -s -p 'Nueva contraseña de alexis (12 a 128 caracteres): ' password
printf '\n'
IFS= read -r -s -p 'Repetir contraseña: ' confirmation
printf '\n'
[[ "$password" == "$confirmation" ]] || { echo 'Las contraseñas no coinciden.' >&2; exit 1; }
printf '%s' "$password" | /usr/bin/node "$app_dir/scripts/change-password.mjs"
