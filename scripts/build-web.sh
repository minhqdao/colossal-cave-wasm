#!/usr/bin/env bash
#
# Builds web/adventure.js and web/adventure.wasm with a single LFortran
# (>= 0.69.0) invocation: 0.69.0 forwards Emscripten -s settings to the emcc
# link it runs for --target=wasm32-unknown-emscripten (#16268) and finds its
# own runtime object. src/adventure.dat is embedded via --emcc-embed.
#
# The sources must be concatenated into one compilation unit: with
# --implicit-interface, LFortran emits no-argument prototypes for the external
# shim routines when they are compiled separately, and wasm-ld then produces
# an invalid module (signature mismatches for IFILE/GETLIN/NXTINT/ADVRAN).
#
# Needs lfortran >= 0.69.0 on PATH ($LFORTRAN) and Emscripten via EMSDK_PATH,
# else EMSDK, else emcc on PATH (shimmed below).

set -euo pipefail
cd "$(dirname "$0")/.."

LFORTRAN="${LFORTRAN:-lfortran}"
BUILD_DIR="${BUILD_DIR:-build}"
SHIM_ROOT=""

cleanup() {
    if [[ -n "$SHIM_ROOT" ]]; then rm -rf "$SHIM_ROOT"; fi
}
trap cleanup EXIT

if ! command -v "$LFORTRAN" > /dev/null; then
    echo "error: lfortran not found (install LFortran >= 0.69.0 and add it to your PATH, or set \$LFORTRAN)" >&2
    exit 1
fi
if [[ -z "${EMSDK_PATH:-}" || ! -x "${EMSDK_PATH%/}/upstream/emscripten/emcc" ]]; then
    if [[ -n "${EMSDK:-}" && -x "${EMSDK%/}/upstream/emscripten/emcc" ]]; then
        export EMSDK_PATH="${EMSDK%/}"
    elif command -v emcc > /dev/null; then
        EMCC_BIN="$(command -v emcc)"
        SHIM_ROOT="$(mktemp -d)"
        EMSDK_PATH="$SHIM_ROOT/shim"
        mkdir -p "$EMSDK_PATH/upstream/emscripten"
        printf '#!/bin/sh\nexec %q "$@"\n' "$EMCC_BIN" > "$EMSDK_PATH/upstream/emscripten/emcc"
        chmod +x "$EMSDK_PATH/upstream/emscripten/emcc"
        export EMSDK_PATH
    else
        echo "error: no Emscripten found (set EMSDK_PATH to an emsdk root, or put emcc on PATH)" >&2
        exit 1
    fi
fi

mkdir -p "$BUILD_DIR"
cat src/adventure.f src/adventure_shims.f > "$BUILD_DIR/adventure_all.f"

# 4 MB initial / 32 MB max grown memory. This project's whole history of iOS
# crashes is eager linear-memory reservation: a fixed 256 MB start aborted on
# reload under WebContent memory pressure, and a 16 MB start still exhausted
# a 2 GB iPhone 6s after a few refreshes (iOS reclaims the previous page's
# memory lazily, so refreshes overlap). Measured high-water mark: a 200-turn
# scripted playthrough never grows past the 4 MB start, so the reservation
# fits within one small page while 32 MB remains a generous ceiling.
# The 1 MB stack keeps >10x headroom over the 64 KB the suite's
# stack-overflow guards have actually observed in use.
"$LFORTRAN" \
    --fixed-form \
    --implicit-interface \
    --implicit-typing \
    --target=wasm32-unknown-emscripten \
    -sSTACK_SIZE=1mb \
    -sINITIAL_MEMORY=4mb \
    -sMAXIMUM_MEMORY=32mb \
    -sALLOW_MEMORY_GROWTH=1 \
    -sSTACK_OVERFLOW_CHECK=1 \
    -sEXIT_RUNTIME=1 \
    -sMODULARIZE \
    -sEXPORT_ES6 \
    -sEXPORTED_RUNTIME_METHODS=FS,callMain \
    --emcc-embed src/adventure.dat@adventure.dat \
    "$BUILD_DIR/adventure_all.f" \
    -o web/adventure.js

# wasm-ld only warns about the invalid module produced by separate
# compilation units, so fail the build here instead of shipping it.
node -e 'const fs = require("node:fs"); if (!WebAssembly.validate(fs.readFileSync("web/adventure.wasm"))) { console.error("error: generated WebAssembly module does not validate"); process.exit(1); }'

echo "Built web/adventure.js and web/adventure.wasm"
