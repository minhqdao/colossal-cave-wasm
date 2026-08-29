# Colossal Cave Adventure (FORTRAN IV → WebAssembly)

[![CI](https://img.shields.io/github/actions/workflow/status/minhqdao/colossal-cave-wasm/ci.yml?logo=github&label=CI)](https://github.com/minhqdao/colossal-cave-wasm/actions/workflows/ci.yml)
[![Play online](https://img.shields.io/website?url=https%3A%2F%2Fminhqdao.github.io%2Fcolossal-cave-wasm%2F&logo=webassembly&label=play%20online)](https://minhqdao.github.io/colossal-cave-wasm/)
[![License](https://img.shields.io/github/license/minhqdao/colossal-cave-wasm)](LICENSE)

Colossal Cave Adventure is the original text adventure game, written in FORTRAN IV by Will Crowther in 1976 and expanded by Don Woods in 1977.

The code is based on the 1977-03-31 sources preserved (together with the game database `adventure.dat`) in the [wh0am1-dev/adventure](https://github.com/wh0am1-dev/adventure) repository.

The goal of this project is to explore Fortran-to-WebAssembly compilation using modern Fortran compilers such as LFortran and LLVM Flang. The game is built with LFortran and Emscripten and runs entirely in the browser — [play it online](https://minhqdao.github.io/colossal-cave-wasm/).

## Changes to the 1977 Source

The port keeps the original program structure, statements and data statements; only what modern compilers reject was changed:

- `DO n` loops terminated by an assignment now terminate on a labeled `CONTINUE`.
- `TYPE` statements became `PRINT`.
- `PAUSE` became `PRINT`, with `STOP` where the original trapped fatal conditions; interactive end-of-play paths keep their original flow.
- Multi-line character literals in `FORMAT` were split into complete literals.
- The `CHARACTER`/array packing of `LLINE` was replaced by explicit integer (`LNEXT`, `LNCH`) and `CHARACTER*5` (`LTEXT5`) arrays shared through `COMMON`.
- Statement labels were padded so the label field ends in column 5 (LFortran's fixed-form tokenizer rejects labels followed by a tab in earlier columns).
- The `FORMAT(G...)` tape-format database loader was rewritten around small line/token readers (`GETLIN`, `NXTINT`) that parse the same `adventure.dat` layout.
- Input is read one line at a time and parsed into two uppercase words, so terminal-style line input (including the browser runner) works without interactive echo.
- First-use initialization: arrays (`KEY`, `PROP`, the dwarf tracking arrays, ...) that the 1976 code relied on being zeroed memory are now explicitly zeroed, and never-written tail elements of `DATA`-initialized arrays are cleared.
- The hidden dwarf-movement table `DTRAV` was indexed past its 15 entries by the original code (harmless on PDP-10, a bounds-check fault today); out-of-range picks now leave the dwarf in place.
- Object inference for one-word verbs (`GET`, ...) tested `ICHAIN(IOBJ(J))` inside an `.OR.`; Fortran evaluates both operands, so an empty room produced an `ICHAIN(0)` subscript. gfortran and Flang read memory out of bounds silently, but LFortran's bounds checks abort the program, so the two conditions are tested separately.
- Killing a captive (caged) bird reused the pickup path's unlink-from-room-chain code, but the carried bird is in no room's chain, so the scan at label 9007 never terminates and the 1976 program hangs (on native builds it still hangs today; in the browser LFortran's bounds checks abort instead). The unlink is now skipped for a carried bird.
- `RAN` was renamed to `ADVRAN` so gfortran/Flang do not resolve it to their own intrinsic, keeping the Park–Miller sequence identical across compilers.

Platform shims (in `src/adventure_shims.f`): `IFILE` locates and opens `adventure.dat`, `ADVRAN` implements the Park–Miller minimal-standard generator (TOPS-10 style, seeded with 1 exactly like the original), and `GETLIN`/`NXTINT` provide line/token reading for the loader.

## Native Build

Make sure either `gfortran`, `lfortran`, or `flang` are installed on your system. Other compilers may work as well but have not been tested.

### gfortran

```bash
gfortran src/adventure.f src/adventure_shims.f -o adventure
```

### lfortran

LFortran emits identical per-file helper symbols into every object file, which collide when the two source files are compiled and linked separately. Build them as one compilation unit:

```bash
mkdir -p build && cat src/adventure.f src/adventure_shims.f > build/adventure_all.f
lfortran --fixed-form --implicit-interface --implicit-typing build/adventure_all.f -o adventure
```

### flang

```bash
flang src/adventure.f src/adventure_shims.f -o adventure
```

Start the game by running the executable from the repository root (it looks for `adventure.dat` in the working directory, then in `src/`):

```bash
./adventure
```

## WebAssembly Build

### Prebuilt Artifacts

`web/adventure.js` and `web/adventure.wasm` are committed for convenience so you can run the web version without installing the toolchain; they were generated with LFortran 0.65.0 and Emscripten 6.0.8. The game database is embedded in the module. You can proceed to [Run Web Server](#run-web-server).

### Local WASM Build

The WebAssembly build requires [LFortran](https://lfortran.org/) and [Emscripten](https://emscripten.org/). Install LFortran (e.g. with `conda install -c conda-forge lfortran`) and Emscripten, and make sure `lfortran` and `emcc` are on your `PATH`. The build is known to work with LFortran 0.65.0 and Emscripten 6.0.8, but other recent versions should work as well.

```bash
scripts/build-web.sh
```

The script compiles the port with `lfortran` (single compilation unit, see above) and links with `emcc`, embedding `src/adventure.dat` into the module and emitting `web/adventure.js` and `web/adventure.wasm`.

### Run Web Server

To play the game, start a local web server with [Node.js](https://nodejs.org/en/download/):

```bash
node scripts/dev-server.mjs 8080
```

Then open http://localhost:8080 in your browser.

## Tests

`scripts/run-tests.mjs` runs a regression suite of scripted game sessions (65 scenarios) against the WebAssembly build and asserts on the transcripts, plus synchronous invariant checks on the launcher/worker input-buffer protocol: the instructions prompt, `HELP`, unknown/truncated/lowercase input, bare verbs, object and lamp handling, the grate lock state machine, the `XYZZY`/`PLUGH` magic words, darkness and non-fatal pit falls, the bird puzzle, dwarf encounters and the 1976 quirks that come with them. Because the game is fully deterministic (the rng seed is a fixed `DATA` constant), even rng-driven events are reproducible and asserted directly. The suite also requires the wasm transcript to be identical to a native gfortran build's.

```bash
node scripts/run-tests.mjs               # wasm + native parity (needs gfortran)
node scripts/run-tests.mjs --no-parity   # wasm only
node scripts/run-tests.mjs grate         # only tests whose name matches
```

CI additionally runs the suite natively against each compiler of the build matrix (`ADVENTURE_NATIVE=./adventure node scripts/run-tests.mjs --native-only`).

## Typecheck

`scripts/typecheck.sh` type-checks the hand-written `// @ts-check` sources in `web/`, the same command CI runs.

```bash
scripts/typecheck.sh
```

## License

The 1977 Adventure sources ship with no license (see the [wh0am1-dev/adventure](https://github.com/wh0am1-dev/adventure) repository for details); this project makes no claim over them. All additions in this repository — the port, shims, build scripts, web launcher and CI — are covered by the ISC license; see [LICENSE](LICENSE).
