"""One-time knowledge migration; --verify rechecks files and the real app API.

Run with Python 3.11+ and the workstation's existing python-dotenv package.
Originals and private profile backups live only in ACL-protected org/.state.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile

from dotenv import dotenv_values, set_key
from dotenv.parser import parse_stream

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT.parent / "codex"
WORK = ROOT / "workdir"
PRIVATE = ROOT / "org/.state/codex-migration-20260920"
MANIFEST = PRIVATE / "manifest.json"
SKIP = {".assistant", ".git", ".codex", ".codex-automation", ".codex-platform",
        ".claude", ".cursor", ".pi", "node_modules", ".venv", "__pycache__",
        ".pytest_cache", ".ruff_cache", ".mypy_cache", ".sites-runtime", ".wrangler"}
DIRECTOR = "7db44efa-6d82-4f99-a19f-fe4b47e0500f"
DATA_VP = "53ddfeb9-0399-4bcf-b6c0-5051b48a60e4"
NEWTON = "c616eb0d-dc49-4e42-83c0-d537aa46f5a3"
ALVIN = "2a059b9d-3fa4-4d28-a679-ec8bc55e14fb"
SHAFIRA = "d1925c71-2850-4474-b3d2-89a5969b4952"

# Each team owns one real source domain; these are app agents, not a second runtime.
TEAMS = {
    "data-team-platform": ("data", "Data Platform", [
        "Own governed data, analytics, PostgreSQL/SurrealDB and the PISI ingestion contract.",
        "PISI: source PostgreSQL -> canonical materialized views -> SurrealDB canon -> agentic/dashboard views; CocoIndex/Nextflow are saved requirements, not verified deployments.",
        "Ingestion checkpoints are between rounds: discovery, repeatable mapping, mirror ingestion, views; retain audit, stop/resume and schema-change detection.",
        "aec-core-db means postgres18 on aec-server-1. Bare-metal aec-data-platform is a separate service: direct 5433, pooled 6432, S3 8333; verify live schema and endpoint before queries.",
        "Use parameterized queries, explicit units, lineage and row counts. Keep production schema administration separate from reporting access."]),
    "data-team-finance": ("data", "Finance", [
        "Own the owner's local finance ledger, reconciliation and financial analysis; Shafira remains Head of Finance.",
        "FINANCE_DB_PATH points to the single migrated finance.sqlite3. Use SQLite read-only for reports; never replace local records with Notion data.",
        "Read schema.sql; reconcile transaction_entries, account_transfers and untracked_balance_entries together, excluding superseded conflicts.",
        "Amounts are integer hundredths of IDR. Retain provenance and transfers; do not count both transfer legs as spending.",
        "Old documented balances are historical. Query current rows and snapshot views, state the effective date, and never infer missing transactions from target balances."]),
    "engineering-team-infrastructure": ("engineering", "Infrastructure", [
        "Own Kalbe/AEC and Gaussian infrastructure, SSH/VPN, OCP, DNS, ingress, container operations, backups and RunPod.",
        "Use scoped environment names and native CLI/API first. Kalbe topology under knowledge/sub-workspace/kalbe is canonical; root docs are compatibility mirrors.",
        "Inspect current processes and endpoints before changes. Solaris aec-compute-2 requires Solaris tools; RunPod IDs and ports are ephemeral.",
        "Use narrow backup -> validate -> change -> identical probe -> rollback workflow. Preserve stateful volumes, PVC/PV names and running simulations.",
        "Gaussian traffic enters gauss-server-0 NPM; remote Portainer agents use reverse tunnels. Verify routes rather than exposing worker ports.",
        "Legacy credential references are private environment variables. Never print, copy into reports, or broadly forward them."]),
    "engineering-team-simulation": ("engineering", "Simulation", [
        "Own CAE/CFD/DEM studies, solver validation, simulation process checks and EMAM FVM/LBM research.",
        "A running claim requires process owner, PID, command, cwd, runtime and output/time advancement on a short recheck; utilization alone is insufficient.",
        "Keep monitoring read-only and do not disrupt active runs. Inaccessible hosts are unverified; use No simulation run only after verified absence.",
        "Keep immutable input, checkpoint and generated-output provenance distinct. A forecast or reconstructed result is not a solver execution.",
        "EMAM's documented 10.04x gain is a historical workflow comparison with differing hardware/physics, not a universal solver speedup.",
        "Coordinate 2027 mixing/drying PRDs with Product Delivery. Report numerical stability, validation limits and decision applicability."]),
    "engineering-team-devices": ("engineering", "Devices", [
        "Own IoT, robotics and smart-device technical planning using the migrated 2027 PRDs.",
        "Keep site, asset, signal, unit, source timestamp, quality and ownership explicit; validate the entire edge-to-consumer path.",
        "Use aec-compute-3 as the documented jump host for IoT edges and verify current routes before access.",
        "Keep hardware calibration and physical safety controls. Require measured acceptance evidence before describing a prototype as deployed.",
        "Product Delivery owns capacity and commitments; inferred mandays are estimates, not approved staffing."]),
    "engineering-team-software": ("engineering", "Software", [
        "Own migrated application source: the simulation portal and Workday/Keycloak authenticator.",
        "Read each project's README and dependency lock before running. Preserve auth, routing, persistence and validation; deliver real app execution evidence.",
        "The simulation portal is a migrated draft with local development auth; its presence is not deployment or production-auth proof.",
        "Workday login is a Java/Maven Keycloak provider. Its integration mock is a test fixture, not an external-service validation.",
        "Do not deploy or change remote credentials merely to verify relocation. Coordinate infrastructure access with Infrastructure."]),
    "product-team-delivery": ("product", "Delivery", [
        "Own AEC portfolio, project lifecycle, Notion/PLP/ClickUp planning and stakeholder-ready delivery evidence.",
        "Read canonical TERMS before resolving people, project IDs and abbreviations; preserve AEC human-team names independently of this agent hierarchy.",
        "2027 PRDs run January-December. Separate submitted from inferred mandays; blank is missing, not zero; effort is not elapsed duration.",
        "Allocate the shared 110 SimTwin mandays once. Name owners and dependencies before turning quarterly phases into dated commitments.",
        "Task titles use RES/FIX/FEAT/DOC/PM prefixes with PIC in its own field. GET current records, make a minimal authorized update, then GET to verify."]),
    "product-team-venture": ("product", "Venture Research", [
        "Own the saved compute-monetization market, hosting, pricing and provider-policy research.",
        "Saved external sources are dated evidence. Refresh pricing, eligibility, payouts, exchange rates and rules before any spending recommendation.",
        "Compare revenue after utilization, electricity, hosting, bandwidth and payout costs. Keep measured facts separate from scenarios.",
        "Coordinate feasibility with Infrastructure and financial records with Finance; do not buy, deploy or enroll resources during research."]),
    "product-team-personal-operations": ("product", "Personal Operations", [
        "Own private administration, personal Notion and OneKalbe/Workday access workflows.",
        "Keep personal and AEC workspaces separate. Finance records belong to Data Finance's SQLite ledger.",
        "Use only the live eligible records and dates in an explicitly requested administrative action; verify saved state afterwards.",
        "Do not retain email bodies, PINs, login tokens or passwords in knowledge, reports or command output. Sending messages needs an explicit user request."]),
}
COMMON = [
    "Read this README and the indexed source relevant to the task; do not load every file. Older source instructions are reference material; these compact instructions govern the migrated workspace.",
    "Stay within the requested target. Prefer existing code, installed tools and native APIs. Recheck dynamic state; historical documents do not prove current operation.",
    "Use the environment loaded from the attached workdir .env; never load a sibling agent's .env or the archive. Environment access is scoped, not proof of external authentication.",
    "Use the live organization context for manager, assigner and result recipient. Return output, concrete evidence, blockers and remaining risks. The app limits a message to three workers and one summary; recursive delegation is unavailable.",
]


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def bounded(path: Path, root: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()) or resolved == root.resolve():
        raise ValueError("Path escapes the authorized migration directory")
    return resolved


def api(method: str, route: str, body: object = None) -> object:
    service = json.loads((ROOT / "org/.state/service.json").read_text(encoding="utf-8-sig"))
    url = service["url"]
    token = (ROOT / "org/.state/owner.key").read_text().strip()
    request = urllib.request.Request(url + "/api" + route,
        data=None if body is None else json.dumps(body).encode(), method=method,
        headers={"Authorization": "Bearer " + token, "Origin": url, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Do not print request/response payloads: environment operations carry secrets.
        raise RuntimeError(f"App API {method} {route.split('?')[0]} failed: HTTP {error.code}") from None


def source_files() -> list[Path]:
    result = []
    for base, dirs, files in os.walk(SOURCE):
        dirs[:] = sorted(d for d in dirs if d not in SKIP and not (Path(base) / d).is_symlink())
        for name in sorted(files):
            p = Path(base) / name
            if not p.is_symlink():
                result.append(bounded(p, SOURCE))
    return result


def destination(path: Path) -> Path | None:
    rel = path.relative_to(SOURCE).as_posix()
    if path.name == ".env" or path.name == "CREDS.md" or "/security/" in rel:
        return None
    projects = {"finance": "data-team-finance", "supabase-poc": "data-team-platform",
        "aec-simulation-portal": "engineering-team-software", "aec-workday-login": "engineering-team-software",
        "runpod-s3-prob": "engineering-team-infrastructure"}
    for project, team in projects.items():
        prefix = f"sub-workspace/{project}/"
        if rel.startswith(prefix):
            return WORK / team / "projects" / project / rel[len(prefix):]
    if rel.startswith("sub-workspace/personal/"):
        team = "data-team-finance"
    elif rel.startswith("sub-workspace/gaussian/projects/pisi/"):
        team = "data-team-platform"
    elif rel.startswith(("docs/infrastructure/", "docs/operations/", "sub-workspace/kalbe/docs/", "sub-workspace/gaussian/docs/")):
        team = "engineering-team-infrastructure"
    elif rel.startswith("docs/research/") or rel == "docs/template/simulation-probe.md":
        team = "engineering-team-simulation"
    elif rel.startswith("docs/finance/"):
        team = "data-team-finance"
    elif rel.startswith("docs/projects/2027-activities/"):
        team = "engineering-team-devices" if path.name in {"iot-platform-2-0.md", "robotics-platform-2-0.md", "smart-device-prototyping.md"} else "product-team-delivery"
    elif rel == "docs/template/project-lifecycle.md":
        team = "product-team-delivery"
    elif rel.startswith("external-sources/"):
        team = "product-team-venture"
    elif rel in {"TERMS.md", "REMINDER.md", "INSTRUCTIONS.md", "docs/README.md", "sub-workspace/README.md", "sub-workspace/kalbe/README.md", "sub-workspace/kalbe/TERMS.md", "sub-workspace/gaussian/README.md", "sub-workspace/gaussian/TERMS.md"}:
        team = "organization"
    else:
        return None
    return WORK / team / "knowledge" / rel


def environments() -> tuple[dict[str, dict[str, str]], dict[str, str], list[str]]:
    values: dict[str, str] = {}
    conflicts = []
    # Root is the newest compatibility bundle and wins if a scoped copy differs.
    for path in [*sorted((SOURCE / "sub-workspace").glob("*/.env")), SOURCE / ".env"]:
        with path.open(encoding="utf-8-sig") as stream:
            if any(binding.error for binding in parse_stream(stream)):
                raise ValueError(f"Invalid dotenv syntax in {path.name}; values withheld")
        for key, value in dotenv_values(path, encoding="utf-8-sig", interpolate=False).items():
            if value is None:
                raise ValueError(f"Environment key has no assignment: {key}")
            if key in values and values[key] != value:
                conflicts.append(key)
            values[key] = value
    scoped = {team: {} for team in TEAMS}
    for key, value in values.items():
        if key.startswith(("MAC_PERSONAL_", "ONEKALBE_")) or key == "NOTION_PERSONAL_TOKEN":
            owners = ["product-team-personal-operations"]
        elif key.startswith(("PLP_", "CLICKUP_")):
            owners = ["product-team-delivery"]
        elif key == "NOTION_AEC_TOKEN":
            owners = ["product-team-delivery", "data-team-platform"]
        else:
            owners = ["engineering-team-infrastructure"]
            if key.startswith(("AEC_COMPUTE", "AEC_VM_", "AEC_NETBIRD_VM_", "RUNPOD_", "KALBE_RUNPOD_", "DC_KFDC1_")):
                owners.append("engineering-team-simulation")
            if key.startswith(("AEC_IOT_EDGE", "AEC_COMPUTE3_")):
                owners.append("engineering-team-devices")
            if key.startswith(("AEC_SERVER1_", "AEC_NETBIRD_VM_", "DC_KFDC1_")):
                owners.append("data-team-platform")
        for team in owners:
            scoped[team][key] = value
    legacy = {
        "engineering-team-infrastructure": ["CREDS.md", "ADMIN-SYSADMIN.txt", "sub-workspace/kalbe/CREDS.md", "sub-workspace/gaussian/CREDS.md"],
        "data-team-platform": ["docs/security/scdt-credentials.md", "sub-workspace/kalbe/docs/security/scdt-credentials.md"],
    }
    for team, files in legacy.items():
        for i, name in enumerate(files, 1):
            scoped[team][f"LEGACY_CREDENTIAL_REFERENCE_{i}"] = (SOURCE / name).read_text(encoding="utf-8-sig")
    scoped["data-team-finance"]["FINANCE_DB_PATH"] = str(WORK / "data-team-finance/projects/finance/finance.sqlite3")
    return scoped, values, sorted(set(conflicts))


def markdown(text: str, original: Path, target: Path, mapping: dict[Path, Path], values: dict[str, str]) -> str:
    for key, value in sorted(values.items(), key=lambda pair: len(pair[1]), reverse=True):
        if value and len(value) >= 5 and re.search(r"PASS|TOKEN|KEY|PAT|BEARER", key):
            text = text.replace(value, "${" + key + "}")
    # Historical credential-bearing lines not represented in dotenv stay private.
    text = re.sub(r"(?im)^.*(?:password|passwd|api[_ -]?key|bearer)\s*[:=]\s*[^\n]+$",
                  "[Credential-bearing line retained only in the private archive; use the attached workdir .env.]", text)
    def link(match: re.Match[str]) -> str:
        label, ref = match.groups()
        ref = ref.strip("<>")
        if re.match(r"[a-z]+://|#|mailto:", ref):
            return match.group(0)
        path_part, _, anchor = ref.partition("#")
        old = (original.parent / path_part).resolve()
        if old in mapping:
            dest = mapping[old]
            return f"[{label}](<{os.path.relpath(dest, target.parent).replace(os.sep, '/')}" + ("#" + anchor if anchor else "") + ">)"
        if old.is_relative_to(SOURCE):
            return f"{label} (legacy reference: `{path_part}`; excluded or archived, not migrated)"
        return match.group(0)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, text)
    if original.name == "personal-finance-database.md":
        text = text.replace("/home/ubuntu/codex/sub-workspace/finance", (WORK / "data-team-finance/projects/finance").as_posix())
    return text


def configure(scoped: dict[str, dict[str, str]], state: dict) -> list[dict]:
    existing = {a["id"]: a for a in state["agents"]}
    records = []
    def save(agent_id: str, name: str, position: str, team: str, manager: str | None, model: str, effort: str, role: str) -> str:
        profile = dict(existing.get(agent_id, {"id": agent_id, "name": name, "color": "#2563eb", "permission": "workspace-write", "timeout_seconds": 3600, "enabled": True, "deleted_at": None, "revision": 0}))
        profile.update(position=position, role=role, reports_to=manager, model=model, reasoning=effort,
            agents_md="", instructions=(WORK / team / "AGENTS.md").read_text(encoding="utf-8") + f"\nYour position: {position}. {role}\n",
            workdir={"path": str(WORK / team), "canonical_path": str(WORK / team), "git_root": None})
        actual = api("PUT" if agent_id in existing else "POST", "/agents/" + agent_id if agent_id in existing else "/agents", profile)
        env = scoped.get(team, {})
        env_path = WORK / team / ".env"
        current = dotenv_values(env_path, interpolate=False) if env_path.exists() else {}
        if any(key in current and current[key] != value for key, value in env.items()):
            raise RuntimeError("Workdir .env conflicts with import; existing values retained")
        for key, value in env.items():
            if key not in current:
                set_key(env_path, key, value)
        if any(dotenv_values(env_path, interpolate=False).get(k) != v for k, v in env.items()):
            raise RuntimeError("Workdir .env round-trip mismatch; values withheld")
        records.append({"id": agent_id, "name": actual["name"], "position": position, "team": team,
            "manager": manager, "model": model, "reasoning": effort,
            "environment_keys": sorted(set(current) | set(env))})
        write_json(PRIVATE / "agents-progress.json", records)
        return agent_id
    # Preserve the owner's director instructions and position; append only the local index entry.
    director = dict(existing[DIRECTOR])
    director["instructions"] += "\n\nDepartment routing and migrated knowledge: read README.md in your organization workdir. Each agent loads only its attached workdir .env.\n"
    api("PUT", "/agents/" + DIRECTOR, director)
    heads = {}
    for dept in ["data", "engineering", "product"]:
        aid = DATA_VP if dept == "data" else str(uuid.uuid5(uuid.NAMESPACE_URL, "tirta/department/" + dept))
        heads[dept] = save(aid, dept.title() + " VP", "VP of " + dept.title(), "department-of-" + dept,
            DIRECTOR, "gpt-5.6-luna", "xhigh", "Own department priorities, team coordination, evidence review and cross-department handoffs.")
    save(SHAFIRA, "Shafira", "Head of Finance", "data-team-finance", heads["data"], "gpt-5.6-luna", "xhigh",
         "Finance specialist: own reconciliation policy, owner financial analysis and review Finance team results.")
    for team, (dept, title, _) in TEAMS.items():
        lead = NEWTON if team == "data-team-platform" else str(uuid.uuid5(uuid.NAMESPACE_URL, "tirta/" + team + "/lead"))
        officer = ALVIN if team == "data-team-platform" else str(uuid.uuid5(uuid.NAMESPACE_URL, "tirta/" + team + "/officer"))
        manager = SHAFIRA if team == "data-team-finance" else heads[dept]
        save(lead, title + " Lead", "Member of " + dept.title() + " Staff", team, manager,
             "gpt-6-astra", "high", "Team lead: solve complex work, define bounded execution tasks and verify team outcomes.")
        save(officer, title + " Officer", dept.title() + " Officer", team, lead,
             "gpt-5.6-luna", "xhigh", "Team member: execute scoped work using the team's source material and return concrete proof.")
    return records


def instructions(mapping: dict[Path, Path]) -> None:
    for team, (dept, title, rules) in TEAMS.items():
        folder = WORK / team
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "AGENTS.md").write_text(f"# {title} — Department of {dept.title()}\n\n" + "\n".join("- " + line for line in rules + COMMON) + "\n", encoding="utf-8")
        owned = sorted(p for p in mapping.values() if p.is_relative_to(folder))
        links = [f"- [{p.relative_to(folder).as_posix()}](<{p.relative_to(folder).as_posix()}>)" for p in owned if p.suffix == ".md" or p.name in {"finance.sqlite3", "schema.sql"}]
        if team == "product-team-personal-operations":
            links.append("- Operational context is the injected OneKalbe, Mac and personal Notion environment; no standalone runbook was supplied outside .assistant.")
        links.append("- [Organization terms](../organization/knowledge/TERMS.md)")
        if team in {"engineering-team-simulation", "product-team-delivery", "engineering-team-devices"}:
            links.append("- [2027 portfolio](../product-team-delivery/knowledge/docs/projects/2027-activities/README.md)")
        (folder / "README.md").write_text(f"# {title}\n\nDepartment: {dept.title()}. Read [compact instructions](AGENTS.md).\n\n" + "\n".join(links) + "\n", encoding="utf-8")
    for dept in ["data", "engineering", "product"]:
        folder = WORK / ("department-of-" + dept)
        folder.mkdir(exist_ok=True)
        (folder / "AGENTS.md").write_text(f"# Department of {dept.title()}\n\n- VP owns priorities, governance and acceptance; team leads own technical plans; officers execute; specialists review their domain.\n- Read README.md to route work to the team with the matching workdir and environment. Department heads do not receive every team's credentials.\n" + "\n".join("- " + s for s in COMMON) + "\n", encoding="utf-8")
        (folder / "README.md").write_text(f"# Department of {dept.title()}\n\n" + "\n".join(f"- [{title}](../{team}/README.md) — `{team}`" for team, (d, title, _) in TEAMS.items() if d == dept) + "\n", encoding="utf-8")


def verify(manifest: dict, terminals: bool = False) -> dict:
    state = api("GET", "/state")
    live = {a["id"]: a for a in state["agents"]}
    checked = 0
    for entry in manifest["files"]:
        p = bounded(WORK / entry["destination"], WORK)
        if digest(p.read_bytes()) != entry["destination_sha256"]:
            raise RuntimeError("Migrated file verification failed: " + entry["destination"])
        checked += 1
    for entry in manifest.get("preserved_skill_files", []):
        if digest(bounded(WORK / entry["path"], WORK).read_bytes()) != entry["sha256"]:
            raise RuntimeError("Preserved project skill changed: " + entry["path"])
    if manifest.get("finance_compatibility_junction"):
        if not os.path.samefile(SOURCE / "sub-workspace/finance/finance.sqlite3", WORK / "data-team-finance/projects/finance/finance.sqlite3"):
            raise RuntimeError("Finance compatibility path is not the canonical database")
    with zipfile.ZipFile(PRIVATE / "codex-originals-and-remainder.zip") as archive:
        if archive.testzip() is not None:
            raise RuntimeError("Archive CRC verification failed")
    runs = []
    for expected in manifest["agents"]:
        actual = live[expected["id"]]
        for key in ["position", "model", "reasoning"]:
            if actual[key] != expected[key]:
                raise RuntimeError("Agent profile drift: " + expected["name"])
        if actual["reports_to"] != expected["manager"] or Path(actual["workdir"]["path"]).resolve() != (WORK / expected["team"]).resolve():
            raise RuntimeError("Agent routing mismatch")
        env_path = Path(actual["workdir"]["path"]) / ".env"
        env = dotenv_values(env_path, interpolate=False) if env_path.exists() else {}
        if sorted(env) != expected["environment_keys"]:
            raise RuntimeError("Environment key mismatch")
        context = api("GET", f"/agents/{expected['id']}/organization-context")
        if not context:
            raise RuntimeError("Missing runtime organization context")
        if terminals:
            checks = "; ".join(f"if ($null -eq [Environment]::GetEnvironmentVariable('{k}')) {{ throw 'Missing environment key: {k}' }}" for k in expected["environment_keys"])
            command = "$ErrorActionPreference='Stop'; if (!(Test-Path -LiteralPath 'AGENTS.md')) { throw 'Missing team instructions' }; if (!(Test-Path -LiteralPath 'README.md')) { throw 'Missing knowledge index' }; " + checks + "; Write-Output 'TEAM_WORKDIR_AND_ENV_OK'"
            run = api("POST", f"/agents/{expected['id']}/terminal", {"id": str(uuid.uuid4()), "command": command})
            for _ in range(60):
                current = api("GET", f"/agents/{expected['id']}/terminal/{run['id']}")
                if current["status"] != "running":
                    break
                time.sleep(0.5)
            if current["exit_code"] != 0 or "TEAM_WORKDIR_AND_ENV_OK" not in current["output"]:
                raise RuntimeError("Real agent terminal verification failed: " + expected["name"])
            runs.append({"agent": expected["name"], "id": run["id"], "exit_code": current["exit_code"]})
    db = WORK / "data-team-finance/projects/finance/finance.sqlite3"
    with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True) as conn:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        rows = {t: conn.execute('SELECT count(*) FROM "' + t + '"').fetchone()[0] for t in ["transaction_entries", "account_transfers", "untracked_balance_entries"]}
    if integrity != "ok":
        raise RuntimeError("Finance integrity check failed")
    return {"files_sha256_verified": checked, "archive_crc": "ok", "agents_verified": len(manifest["agents"]),
        "finance_integrity": integrity, "finance_rows": rows, "terminal_runs": runs, "mocks": "none"}


def migrate() -> None:
    if MANIFEST.exists() or PRIVATE.exists():
        raise RuntimeError("Migration already started; inspect its protected journal and use --verify after completion")
    state = api("GET", "/state")
    if any(r["status"] in {"running", "queued", "starting"} for r in state["runs"]):
        raise RuntimeError("Wait for active app runs before moving workdirs")
    for agent in state["agents"]:
        if any(r["status"] == "running" for r in api("GET", f"/agents/{agent['id']}/terminal")):
            raise RuntimeError("Wait for active terminal commands before migration")
    scoped, values, conflicts = environments()
    files = source_files()
    mapping = {p: bounded(target, WORK) for p in files if (target := destination(p)) is not None}
    if any(p.exists() for p in mapping.values()):
        raise RuntimeError("Destination file collision; nothing moved")
    PRIVATE.mkdir(parents=True)
    write_json(PRIVATE / "profiles-before.json", state["agents"])
    env_before = {a["id"]: (Path(a["workdir"]["path"]) / ".env").read_text(encoding="utf-8")
                  for a in state["agents"] if a.get("workdir") and (Path(a["workdir"]["path"]) / ".env").is_file()}
    write_json(PRIVATE / "environments-before.json", env_before)
    originals = {}
    with zipfile.ZipFile(PRIVATE / "codex-originals-and-remainder.zip", "x", zipfile.ZIP_DEFLATED) as archive:
        for p in files:
            data = p.read_bytes()
            rel = p.relative_to(SOURCE).as_posix()
            archive.writestr(rel, data)
            originals[rel] = digest(data)
    with zipfile.ZipFile(PRIVATE / "codex-originals-and-remainder.zip") as archive:
        for rel, sha in originals.items():
            if digest(archive.read(rel)) != sha:
                raise RuntimeError("Original backup hash mismatch")
    write_json(PRIVATE / "original-hashes.json", originals)
    print(f"BACKUP_OK files={len(files)}; preparing {len(mapping)} migrated files", flush=True)
    entries = []
    for old, new in mapping.items():
        data = old.read_bytes()
        if digest(data) != originals[old.relative_to(SOURCE).as_posix()]:
            raise RuntimeError("Source changed during migration; original retained")
        new.parent.mkdir(parents=True, exist_ok=True)
        if old.suffix.lower() == ".md":
            data = markdown(data.decode("utf-8-sig"), old, new, mapping, values).encode("utf-8")
        new.write_bytes(data)
        entries.append({"source": old.relative_to(SOURCE).as_posix(), "destination": new.relative_to(WORK).as_posix(),
            "original_sha256": originals[old.relative_to(SOURCE).as_posix()], "destination_sha256": digest(data)})
    instructions(mapping)
    write_json(PRIVATE / "files-progress.json", entries)
    agents = configure(scoped, state)
    manifest = {"source": str(SOURCE), "workdir": str(WORK), "archive": str(PRIVATE / "codex-originals-and-remainder.zip"),
        "files": entries, "agents": agents, "source_keys": sorted(values), "root_precedence_conflicts": conflicts,
        "archived_entries": len(files), "excluded_directory_names": sorted(SKIP), "source_removal_complete": False}
    write_json(MANIFEST, manifest)
    proof = verify(manifest, terminals=True)
    print(f"APP_PROOF_OK agents={proof['agents_verified']} terminals={len(proof['terminal_runs'])}", flush=True)
    # Only now remove exact verified source files, never directories or unverified paths.
    for entry in entries:
        old = bounded(SOURCE / entry["source"], SOURCE)
        if digest(old.read_bytes()) != entry["original_sha256"]:
            raise RuntimeError("Source changed before final move; retained source: " + entry["source"])
    for entry in entries:
        bounded(SOURCE / entry["source"], SOURCE).unlink()
    manifest["source_removal_complete"] = True
    write_json(MANIFEST, manifest)
    report(manifest, proof)
    print(json.dumps(proof, ensure_ascii=True), flush=True)


def report(manifest: dict, proof: dict) -> None:
    readme = "# Organization knowledge and team directory\n\nMigrated from `F:/Engineering/codex` on 2026-09-20 (Asia/Jakarta). `.assistant` and runtime/cache directories were excluded.\n\n"
    readme += "Folders remain siblings, matching the existing workdir convention; reporting lines express department/team membership.\n\n"
    readme += "| Department | Team workdir | Responsibility |\n|---|---|---|\n"
    for team, (dept, title, _) in TEAMS.items():
        readme += f"| [Department of {dept.title()}](../department-of-{dept}/README.md) | [{team}](../{team}/README.md) | {title} |\n"
    readme += "\nVPs use Luna xhigh; team leads use Astra high; officers and the Finance specialist use Luna xhigh. Existing director and agent names are preserved. Shafira reports to Data VP, Finance lead reports to Shafira, and Finance officer reports to Finance lead.\n\n"
    readme += "Detailed sources are indexed by each team's README. [TERMS](knowledge/TERMS.md), [REMINDER](knowledge/REMINDER.md) and [legacy standards](knowledge/INSTRUCTIONS.md) preserve earlier context without making historical instructions active.\n\n"
    readme += f"Moved {len(manifest['files'])} files; {manifest['archived_entries']} original/remainder files are in `{manifest['archive']}`. The ZIP contains private originals and must remain inside the protected org directory. It is an archive, not an agent workdir.\n\n"
    readme += "Root/scoped .env and non-migrated files, including original credential references, remain at the source for compatibility; originals are also archived. Credential Markdown was not copied into team knowledge; it is supplied through scoped private environment variables. Agent/runtime folders, Git metadata and reproducible caches were left untouched.\n\n"
    readme += "Newton and Alvin retain the Data department's three installed project skills in Data Platform. The former finance directory is a compatibility junction to the single migrated database, so existing local finance paths still work without a duplicate ledger. Root TERMS, REMINDER and INSTRUCTIONS files redirect to their migrated references.\n\n"
    readme += "Known source limitations: saved endpoints/status can be stale; references to excluded .assistant material were labeled; migrated software is retained source, not a newly deployed or validated application. Other older jobs using moved paths need migration to the paths in the manifest. External credentials were imported exactly and injected successfully; no remote credential-validity claim is made.\n\n"
    readme += "Verification: `python src/scripts/Organize-Codex.py --verify` from the platform root. Add `--terminals` to recheck actual per-agent workdir and environment injection. Private rollback originals, pre-migration profiles and environment snapshots are beside the ZIP; stop affected agent work before restoring selected files or profiles through the API.\n"
    (WORK / "organization/README.md").write_text(readme, encoding="utf-8")
    write_json(WORK / "organization/migration-manifest.json", manifest)
    write_json(WORK / "organization/migration-proof.json", proof)
    (WORK / "organization/AGENTS.md").write_text("# Organization routing\n\n- Read README.md for department/team ownership and migrated sources.\n- Preserve the owner's objective and return one evidence-backed result.\n- Route to agents using their live workdir, model, reporting relationship and environment key names. Never forward secret values or read private migration archives as task context.\n", encoding="utf-8")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--terminals", action="store_true")
    args = parser.parse_args()
    if args.verify:
        saved = json.loads(MANIFEST.read_text(encoding="utf-8"))
        result = verify(saved, terminals=args.terminals)
        if args.terminals:
            report(saved, result)
        print(json.dumps(result, indent=2))
    else:
        migrate()
