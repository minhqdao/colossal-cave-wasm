#!/usr/bin/env bash
#
# Builds the browser artifacts web/adventure.js and web/adventure.wasm from
# the FORTRAN IV sources using LFortran (compile) and Emscripten (link).
#
# LFortran's own Emscripten link step cannot carry `-s` settings (its `-W`
# option forwards them to emcc prefixed in a form clang parses as warning
# options, so they are ignored), therefore the sources are compiled to object
# files with lfortran and linked with emcc, which adds -sMODULARIZE/-sEXPORT_ES6
# so the runner worker can import the module factory as an ES module.
#
# The port compiles as a single compilation unit: LFortran emits identical
# per-file helper symbols (e.g. __lcompilers_ichar_str) into every object
# file, which collide at link time when the two source files are compiled
# separately. The script concatenates src/*.f into build/adventure_all.f,
# which is also how the native lfortran build is documented in the README.
#
# The game database src/adventure.dat is embedded into the module, so the
# web build ships exactly two files; IFILE opens it as ./adventure.dat in
# the virtual filesystem.
#
# Requirements:
#   - lfortran on PATH (override with $LFORTRAN)
#   - emcc from an Emscripten install on PATH (override with $EMCC)
#
# The LFortran WASM runtime object (lfortran_runtime_wasm_emcc.o) is located
# relative to the lfortran binary; set LFORTRAN_RUNTIME_LIBRARY_DIR to point
# at it directly.

set -euo pipefail
cd "$(dirname "$0")/.."

LFORTRAN="${LFORTRAN:-lfortran}"
EMCC="${EMCC:-emcc}"
BUILD_DIR="${BUILD_DIR:-build}"

if ! command -v "$LFORTRAN" > /dev/null; then
    echo "error: lfortran not found (install it and add it to your PATH, or set \$LFORTRAN)" >&2
    exit 1
fi
if ! command -v "$EMCC" > /dev/null; then
    echo "error: emcc not found (install Emscripten and add it to your PATH, or set \$EMCC)" >&2
    exit 1
fi

FFLAGS=(
    --fixed-form
    --implicit-interface
    --implicit-typing
    --target=wasm32-unknown-emscripten
)

find_runtime_object() {
    if [[ -n "${LFORTRAN_RUNTIME_LIBRARY_DIR:-}" ]]; then
        echo "${LFORTRAN_RUNTIME_LIBRARY_DIR%/}/lfortran_runtime_wasm_emcc.o"
        return
    fi

    local bin_dir prefix candidate
    bin_dir="$(cd "$(dirname "$(command -v "$LFORTRAN")")" && pwd)"
    prefix="$(dirname "$bin_dir")"
    for candidate in \
        "$prefix/share/lfortran/lib/lfortran_runtime_wasm_emcc.o" \
        "$prefix/lib/lfortran_runtime_wasm_emcc.o" \
        "$prefix/runtime/lfortran_runtime_wasm_emcc.o"; do
        if [[ -f "$candidate" ]]; then
            echo "$candidate"
            return
        fi
    done

    echo "error: lfortran_runtime_wasm_emcc.o not found (searched relative to $bin_dir; set LFORTRAN_RUNTIME_LIBRARY_DIR)" >&2
    return 1
}

RUNTIME_OBJECT="$(find_runtime_object)"

mkdir -p "$BUILD_DIR"

cat src/adventure.f src/adventure_shims.f > "$BUILD_DIR/adventure_all.f"

"$LFORTRAN" -c "${FFLAGS[@]}" -J "$BUILD_DIR" \
    "$BUILD_DIR/adventure_all.f" -o "$BUILD_DIR/adventure_all.o"

# 4 MB initial / 32 MB max grown memory. This project's whole history of iOS
# crashes is eager linear-memory reservation: a fixed 256 MB start aborted on
# reload under WebContent memory pressure, and a 16 MB start still exhausted
# a 2 GB iPhone 6s after a few refreshes (iOS reclaims the previous page's
# memory lazily, so refreshes overlap). Measured high-water mark: a 200-turn
# scripted playthrough never grows past the 4 MB start, so the reservation
# fits within one small page while 32 MB remains a generous ceiling.
# The 1 MB stack keeps >10x headroom over the 64 KB the suite's
# stack-overflow guards have actually observed in use.
"$EMCC" \
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
    --embed-file src/adventure.dat@adventure.dat \
    "$BUILD_DIR/adventure_all.o" \
    "$RUNTIME_OBJECT" \
    -o web/adventure.js

echo "Built web/adventure.js and web/adventure.wasm (runtime: $RUNTIME_OBJECT)"
