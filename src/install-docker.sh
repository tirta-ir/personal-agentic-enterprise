#!/usr/bin/env bash
set -euo pipefail
command -v docker >/dev/null
docker compose version >/dev/null
install_root="${AE_INSTALL_DIR:-$HOME/agentic-enterprise-docker}"
if [ ! -d "$install_root/.git" ]; then git clone https://github.com/tirta-ir/personal-agentic-enterprise.git "$install_root"; fi
git -C "$install_root" diff --quiet && git -C "$install_root" diff --cached --quiet || { echo 'Preserve local checkout changes before updating.' >&2; exit 1; }
git -C "$install_root" fetch origin "${AE_REF:-main}"
git -C "$install_root" checkout --detach FETCH_HEAD
cd "$install_root/src"
if [ -n "${AE_CONTROLLER_URL:-}" ]; then
    docker compose -f compose.worker.yaml up -d --build
    printf 'Standalone worker installed. Native CLI login: cd "%s/src" && docker compose -f compose.worker.yaml exec worker codex login --device-auth\n' "$install_root"
    exit 0
fi
if [ ! -f .env ]; then (umask 077; printf 'AE_MATRIX_BOT_PASSWORD=%s\n' "$(openssl rand -hex 32)" >.env); fi
set -a; . ./.env; set +a
docker compose run --rm matrix generate
# Login traffic shares the controller IP; retain per-account failure throttling.
docker compose run --rm --entrypoint python matrix -c '
import yaml
p="/data/homeserver.yaml"
with open(p) as f: config=yaml.safe_load(f)
config.setdefault("rc_login",dict(address=dict(per_second=1,burst_count=100),account=dict(per_second=0.2,burst_count=10),failed_attempts=dict(per_second=0.17,burst_count=3)))
with open(p,"w") as f: yaml.safe_dump(config,f)
'
docker compose up -d matrix
for attempt in $(seq 1 30); do
    if docker compose exec -T matrix python -c 'import urllib.request; urllib.request.urlopen("http://localhost:8008/_matrix/client/versions")' >/dev/null 2>&1; then break; fi
    sleep 2
done
printf '%s' "$AE_MATRIX_BOT_PASSWORD" | docker compose exec -T matrix python -c '
import hashlib,hmac,json,sys,urllib.request,urllib.error,yaml
password=sys.stdin.read()
config=yaml.safe_load(open("/data/homeserver.yaml"))
url="http://localhost:8008/_synapse/admin/v1/register"
nonce=json.load(urllib.request.urlopen(url))["nonce"]
user="agentic"
mac=hmac.new(config["registration_shared_secret"].encode(),"\0".join([nonce,user,password,"notadmin"]).encode(),hashlib.sha1).hexdigest()
request=urllib.request.Request(url,data=json.dumps(dict(nonce=nonce,username=user,password=password,admin=False,mac=mac)).encode(),headers={"Content-Type":"application/json"})
try: urllib.request.urlopen(request).close()
except urllib.error.HTTPError as e:
    error=json.load(e)
    if error.get("errcode")!="M_USER_IN_USE": raise RuntimeError(error)
'
docker compose up -d --build platform
printf 'Platform: %s\nOwner key is in the platform volume: /data/org/.state/owner.key\n' "${AE_PUBLIC_URL:-http://localhost:18766}"
