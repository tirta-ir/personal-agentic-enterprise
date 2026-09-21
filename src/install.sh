#!/usr/bin/env bash
set -euo pipefail
command -v gh >/dev/null || { echo 'Install GitHub CLI and sign in with gh auth login for this private repository.' >&2; exit 1; }
install_root="${AE_INSTALL_DIR:-$HOME/.local/share/agentic-enterprise}"
ref="${AE_REF:-main}"
case "$(uname -s)" in
  Darwin)
    command -v brew >/dev/null || { echo 'Install Homebrew (brew.sh), then rerun.' >&2; exit 1; }
    xcode-select -p >/dev/null || { echo 'Install Xcode command line tools first: xcode-select --install' >&2; exit 1; }
    brew install git node protobuf cmake pkg-config openssl rustup
    ;;
  Linux)
    command -v apt-get >/dev/null || { echo 'This installer supports Debian/Ubuntu. Other distributions need git, node/npm, Rust 1.94+, protobuf headers, clang, cmake and OpenSSL headers.' >&2; exit 1; }
    sudo apt-get update
    sudo apt-get install -y git curl build-essential bubblewrap clang cmake pkg-config libssl-dev protobuf-compiler libprotobuf-dev nodejs npm perl
    ;;
  *) echo 'Use install.ps1 on Windows.' >&2; exit 1;;
esac
if ! command -v rustup >/dev/null; then curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal; fi
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
if ! node -e 'if(Number(process.versions.node.split(".")[0])<22) process.exit(1)'; then
    case "$(uname -m)" in x86_64) node_arch=x64;; aarch64|arm64) node_arch=arm64;; *) echo 'Install Node 22+ for this architecture.' >&2; exit 1;; esac
    node_version=v22.22.0
    node_file="node-$node_version-linux-$node_arch.tar.xz"
    node_tmp=$(mktemp -d)
    curl -fsSL "https://nodejs.org/dist/$node_version/$node_file" -o "$node_tmp/$node_file"
    curl -fsSL "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -o "$node_tmp/SHASUMS256.txt"
    (cd "$node_tmp" && grep "  $node_file\$" SHASUMS256.txt | sha256sum -c -)
    mkdir -p "$HOME/.local"
    tar -xJf "$node_tmp/$node_file" -C "$HOME/.local" --strip-components=1
fi
rustup toolchain install 1.94.1 --profile minimal
if [ ! -d "$install_root/.git" ]; then git -c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential' clone https://github.com/tirta-ir/personal-agentic-enterprise.git "$install_root"; fi
git -C "$install_root" diff --quiet && git -C "$install_root" diff --cached --quiet || { echo 'Installation checkout has local changes; preserve them before updating.' >&2; exit 1; }
git -C "$install_root" -c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential' fetch origin "$ref"
git -C "$install_root" checkout --detach FETCH_HEAD
cd "$install_root/src"
export PROTOC="$(command -v protoc)"
export PROTOC_INCLUDE="$(dirname "$(dirname "$PROTOC")")/include"
cargo +1.94.1 build --locked
bash scripts/install-onnx.sh "$install_root/src/target/debug"
(cd frontend && npm ci && npm run build)
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/agentic-enterprise" <<EOF
#!/bin/sh
export LD_LIBRARY_PATH="$install_root/src/target/debug:\${LD_LIBRARY_PATH:-}"
export DYLD_LIBRARY_PATH="$install_root/src/target/debug:\${DYLD_LIBRARY_PATH:-}"
exec "$install_root/src/target/debug/agentic-enterprise" --frontend "$install_root/src/frontend/dist" --org "$install_root/org" "\$@"
EOF
chmod 700 "$HOME/.local/bin/agentic-enterprise"
if [ -n "${AE_CONTROLLER_URL:-}" ]; then
    bash "$install_root/src/scripts/install-worker.sh"
else
    printf 'Installed. Run: %s\n' "$HOME/.local/bin/agentic-enterprise"
fi
