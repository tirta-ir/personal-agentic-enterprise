#!/usr/bin/env bash
set -euo pipefail
destination="${1:?Library destination required}"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset=linux-x64; checksum=3a211fbea252c1e66290658f1b735b772056149f28321e71c308942cdb54b747;;
  Linux-aarch64) asset=linux-aarch64; checksum=866109a9248d057671a039b9d725be4bd86888e3754140e6701ec621be9d4d7e;;
  Darwin-arm64) asset=osx-arm64; checksum=93787795f47e1eee369182e43ed51b9e5da0878ab0346aecf4258979b8bba989;;
  *) echo 'ONNX Runtime 1.24.4 has no prebuilt library for this architecture. Use Docker or provide ORT_DYLIB_PATH for knowledge indexing.' >&2; exit 0;;
esac
archive="onnxruntime-$asset-1.24.4.tgz"
temporary=$(mktemp -d)
curl -fsSL "https://github.com/microsoft/onnxruntime/releases/download/v1.24.4/$archive" -o "$temporary/$archive"
actual=$(shasum -a 256 "$temporary/$archive" | cut -d ' ' -f 1)
[ "$actual" = "$checksum" ] || { echo 'ONNX Runtime checksum mismatch' >&2; exit 1; }
tar -xzf "$temporary/$archive" -C "$temporary"
mkdir -p "$destination"
cp -P "$temporary/onnxruntime-$asset-1.24.4/lib/"libonnxruntime* "$destination/"
rm -f "$temporary/$archive"
