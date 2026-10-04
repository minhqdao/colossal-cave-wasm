# Colossal Cave Adventure (WebAssembly Build)

[![CI](https://img.shields.io/github/actions/workflow/status/minhqdao/colossal-cave-wasm/ci.yml?logo=github&label=CI)](https://github.com/minhqdao/colossal-cave-wasm/actions/workflows/ci.yml)
[![Play online](https://img.shields.io/website?url=https%3A%2F%2Fminhqdao.github.io%2Fcolossal-cave-wasm%2F&logo=webassembly&label=play%20online)](https://minhqdao.github.io/colossal-cave-wasm/)
[![License](https://img.shields.io/github/license/minhqdao/colossal-cave-wasm)](LICENSE)

Colossal Cave Adventure is a foundational text adventure game, originally written in FORTRAN IV by Will Crowther in 1976 and expanded by Don Woods in 1977.

This project is based on the 1977-03-31 sources, preserved together with the game database `adventure.dat` in the [adventure](https://github.com/wh0am1-dev/adventure) repository.

The goal is to explore Fortran-to-WebAssembly compilation using modern Fortran compilers such as LFortran and LLVM Flang. The game is currently built with LFortran and Emscripten and runs entirely in the browser.

## Changes to the 1977 Source

<details> <summary>Show</summary>

The port keeps the original program structure, statements, and data statements. Only changes required by modern compilers were made:

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

</details>

## Native Build

Tested with `gfortran`, `lfortran`, and `flang`.

```bash
# gfortran
gfortran src/adventure.f src/adventure_shims.f -o adventure

# lfortran (single compilation unit: both files emit identical helper symbols)
mkdir -p build && cat src/adventure.f src/adventure_shims.f > build/adventure_all.f
lfortran --fixed-form --implicit-interface --implicit-typing build/adventure_all.f -o adventure

# flang
flang src/adventure.f src/adventure_shims.f -o adventure
```

Run the game from the repository root with `./adventure`. The executable looks for `adventure.dat` in the working directory and then in `src/`.

## WebAssembly Build

Prebuilt `web/adventure.js` and `web/adventure.wasm` are committed, so no toolchain is needed to run the web version. CI rebuilds them for each deployment.

To rebuild them locally, install [LFortran](https://lfortran.org/) and [Emscripten](https://emscripten.org/), make sure both are on your `PATH`, and run:

```bash
npm run build:wasm
````

> Web builds use LFortran 0.65.0. LFortran 0.66.0 currently breaks sequential stdin reads on WebAssembly.

To run locally:

```bash
npm run dev
```

Then open [http://localhost:8080](http://localhost:8080).

## Deployment

Every push to `main` is checked and deployed to GitHub Pages automatically via GitHub Actions.

## Checks

Run the test suite, browser smoke tests, and typecheck with:

```bash
npm run verify
```

The test suite runs scripted game sessions against the WebAssembly build and checks their transcripts against a native gfortran build. `--no-parity` skips the native comparison, and a test name can be passed to run a subset of scenarios.

## License

The original FORTRAN source of Colossal Cave Adventure was written by Will Crowther (1976) and extended by Don Woods (1977). It was distributed without a license notice and is widely treated as public domain. The source in this repository was obtained from the [adventure](https://github.com/wh0am1-dev/adventure) repository. This repository makes no copyright claim on the original game source or its database file.

All additions in this repository — the source patches, runtime shims (`IFILE`, `ADVRAN`, `GETLIN`/`NXTINT`), build scripts, web launcher, and CI — are licensed under the [MIT License](LICENSE).
