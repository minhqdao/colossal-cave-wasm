// Adventure regression suite.
//
// Runs scripted game sessions through the WebAssembly build and asserts on
// the transcript. When gfortran is available it also runs every session
// through a native build and requires byte-identical (normalized) output,
// which catches compiler-level divergences without hand-writing every
// expected line.
//
// The 1976 game is fully deterministic here: the random seed QZ is a fixed
// constant (DATA QZ/1/), so RNG-driven responses (the three "unknown word"
// messages, pit falls in the dark, the dwarf rolls) are stable across runs
// and safe to assert on.
//
// Usage:
//   node scripts/run-tests.mjs              # run everything
//   node scripts/run-tests.mjs grate        # only tests whose name matches
//   node scripts/run-tests.mjs --no-parity  # skip the native build/compare
//   node scripts/run-tests.mjs --native-only# skip wasm, test a native binary
//   node scripts/run-tests.mjs --show       # print output of failing tests
//
// Environment:
//   ADVENTURE_NATIVE=path   use this prebuilt binary instead of compiling
//                           one with gfortran (for CI matrix jobs that each
//                           built the game with a different compiler).
//
// Known 1976 quirks intentionally covered here:
//   - the game has no QUIT/SCORE/SAVE/INVENTORY words (those belong to the
//     1977 Woods revision),
//   - falling into a pit in the dark says GAME IS OVER but the game
//     continues,
//   - GET GRATE from the surface travels you to the depression,
//   - attacking a captive (caged) bird hung the 1976 program in its item-
//     chain scan (label 9007); the port fixes that hang (see 5302 in
//     src/adventure.f), so the sequence is now covered by a test.

import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runNative, runWasm, normalize } from "./game-driver.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const wasmPath = `${root}web/adventure.js`;
const nativeBinary = `${root}build/adventure-native`;
const sources = [`${root}src/adventure.f`, `${root}src/adventure_shims.f`];

// Deep cave route, reused by several tests: answer the instructions prompt,
// enter the building, collect equipment, and descend to the grate.
const caveRoute = ({ keys = true, lamp = true, lampOn = false } = {}) => [
  "N",
  "IN",
  ...(lamp ? ["GET LAMP"] : []),
  ...(lampOn ? ["LAMP ON"] : []),
  ...(keys ? ["GET KEYS"] : []),
  "OUT",
  "SOUTH",
  "SOUTH",
  "DOWN",
  "UNLOCK GRATE",
];

const birdChamberRoute = ({ rod = false, cage = false, lampOn = false } = {}) => [
  ...caveRoute({ lampOn }),
  "IN",
  "WEST",
  ...(cage ? ["GET CAGE"] : []),
  "WEST",
  ...(rod ? ["GET ROD"] : []),
  "UP",
  "WEST",
];

const ROAD =
  "YOU ARE STANDING AT THE END OF A ROAD BEFORE A SMALL BRICK BUILDING . " +
  "AROUND YOU IS A FOREST. A SMALL STREAM FLOWS OUT OF THE BUILDING AND " +
  "DOWN A GULLY.";
const INSTRUCTIONS = "SOMEWHERE NEARBY IS COLOSSAL CAVE, WHERE OTHERS HAVE FOUND";
const BUILDING =
  "YOU ARE INSIDE A BUILDING, A WELL HOUSE FOR A LARGE SPRING.";
const DEPRESSION =
  "YOU ARE IN A 20 FOOT DEPRESSION FLOORED WITH BARE DIRT. SET INTO THE " +
  "DIRT IS A STRONG STEEL GRATE MOUNTED IN CONCRETE.";
const DEBRIS =
  "YOU ARE IN A DEBRIS ROOM, FILLED WITH STUFF WASHED IN FROM THE SURFACE.";
const BIRD_ROOM =
  "YOU ARE IN A SPLENDID CHAMBER THIRTY FEET HIGH.";
const PITCH_BLACK =
  "IT IS NOW PITCH BLACK. IF YOU PROCEED YOU WILL LIKELY FALL INTO A PIT.";
const PIT_FALL = "YOU FELL INTO A PIT AND BROKE EVERY BONE IN YOUR BODY!";
const UNKNOWN = /(I DON'T KNOW THAT WORD\.|WHAT\?|I DON'T UNDERSTAND THAT!)/g;

const tests = [
  // --- instructions prompt -----------------------------------------------
  {
    name: "instructions-yes",
    input: ["Y"],
    expect: [
      "WELCOME TO ADVENTURE!! WOULD YOU LIKE INSTRUCTIONS?",
      INSTRUCTIONS,
      "ME WITH COMMANDS OF 1 OR 2 WORDS",
      "(IF STUCK TYPE HELP FOR SOME HINTS)",
      ROAD,
    ],
  },
  {
    name: "instructions-full-word-yes",
    input: ["YES"],
    expect: [INSTRUCTIONS, ROAD],
  },
  {
    name: "instructions-any-word-is-yes",
    input: ["SURE"],
    expect: [INSTRUCTIONS],
  },
  {
    name: "instructions-no",
    input: ["N"],
    expect: [ROAD],
    forbid: [INSTRUCTIONS],
  },
  {
    name: "instructions-lowercase-no",
    input: ["no"],
    forbid: [INSTRUCTIONS],
    expect: [ROAD],
  },

  // --- help ---------------------------------------------------------------
  {
    name: "help",
    input: ["N", "HELP"],
    expect: [
      "I KNOW OF PLACES, ACTIONS, AND THINGS.",
      "WORDS LIKE FOREST, BUILDING, DOWNSTREAM, ENTER, EAST, WEST",
      "LIKE A BLACK ROD HIDDEN IN THE CAVE",
      "INSTANCE, THE ROD SCARES THE BIRD",
      "GOOD LUCK!",
    ],
  },
  {
    name: "help-synonyms-what-and-questionmark",
    input: ["N", "WHAT", "?"],
    counts: [[/GOOD LUCK!/g, 2]],
  },

  // --- unknown input -------------------------------------------------------
  {
    name: "unknown-single-words",
    input: ["N", "FOO", "BAR", "BAZ", "QUUX"],
    counts: [[UNKNOWN, 4]],
    expect: ["I DON'T KNOW THAT WORD."],
  },
  {
    name: "unknown-two-words",
    input: ["N", "FOO BAR"],
    counts: [[UNKNOWN, 1]],
  },
  {
    name: "unknown-digits-and-punctuation",
    input: ["N", "1234", "@#!%"],
    counts: [[UNKNOWN, 2]],
  },
  {
    name: "unknown-blank-lines",
    input: ["N", "", "     "],
    counts: [[UNKNOWN, 2]],
  },
  {
    // All three unknown-word messages (rng messages 60/60/13 at the grate)
    // plus the locked-grate hint offered after three failures in a row,
    // answered with Y: the grate-is-solid speech.
    name: "unknown-three-variants-and-grate-hint-yes",
    input: ["N", "DOWNSTREAM", "DOWN", "DOWN", "FOO", "BAR", "BAZ", "Y"],
    counts: [[UNKNOWN, 3]],
    expect: [
      "I DON'T KNOW THAT WORD.",
      "I DON'T UNDERSTAND THAT!",
      "ARE YOU TRYING TO GET INTO THE CAVE?",
      "THE GRATE IS VERY SOLID AND HAS A HARDENED STEEL LOCK.",
      "I WOULD RECOMMEND LOOKING ELSEWHERE FOR THE KEYS.",
    ],
  },
  {
    // The 1976 vocabulary has none of the session-management words that the
    // later Woods revision added; they are all treated as unknown.
    name: "session-words-absent-in-1976",
    input: ["N", "QUIT", "SCORE", "SAVE", "RESUME", "INVENTORY"],
    counts: [[UNKNOWN, 5]],
  },

  // --- descriptions and LOOK ----------------------------------------------
  {
    name: "look-repeats-long-description",
    input: ["N", "LOOK", "LOOK", "LOOK", "LOOK"],
    counts: [
      [/SORRY, BUT I AM NOT ALLOWED TO GIVE MORE DETAIL/g, 3],
      [/YOU ARE STANDING AT THE END OF A ROAD/g, 5],
    ],
  },
  {
    name: "revisit-prints-short-text",
    input: ["N", "WEST", "EAST"],
    expect: [
      "YOU HAVE WALKED UP A HILL, STILL IN THE FOREST",
      "YOU'RE AT END OF ROAD AGAIN.",
    ],
  },

  // --- movement ------------------------------------------------------------
  {
    name: "movement-into-building",
    input: ["N", "IN"],
    expect: [
      BUILDING,
      "THERE ARE SOME KEYS ON THE GROUND HERE",
      "THERE IS A SHINY BRASS LAMP NEARBY",
      "THERE IS FOOD HERE",
      "THERE IS A BOTTLE OF WATER HERE",
    ],
  },
  {
    name: "movement-back-returns",
    input: ["N", "WEST", "BACK"],
    expect: [
      "YOU HAVE WALKED UP A HILL, STILL IN THE FOREST",
      "YOU'RE AT END OF ROAD AGAIN.",
    ],
  },
  {
    // FORWARD works from the hill (the travel table carries it), but not
    // from end of road, where the game cannot infer a facing.
    name: "movement-forward-needs-reference",
    input: ["N", "WEST", "BACK", "FORWARD"],
    expect: [
      "YOU HAVE WALKED UP A HILL, STILL IN THE FOREST",
      "YOU'RE AT END OF ROAD AGAIN.",
      "I AM UNSURE HOW YOU ARE FACING. USE COMPASS POINTS OR NEARBY OBJECTS.",
    ],
  },
  {
    name: "movement-back-forward-swap",
    input: ["N", "WEST", "BACK", "FORWARD", "BACK"],
    counts: [[/I AM UNSURE HOW YOU ARE FACING/g, 1]],
  },
  {
    name: "movement-south-to-valley",
    input: ["N", "SOUTH"],
    expect: ["YOU ARE IN A VALLEY IN THE FOREST BESIDE A STREAM TUMBLING ALONG A ROCKY BED."],
  },
  {
    name: "movement-downstream-to-slit",
    input: ["N", "DOWNSTREAM", "DOWN"],
    expect: [
      "YOU ARE IN A VALLEY IN THE FOREST BESIDE A STREAM",
      "AT YOUR FEET ALL THE WATER OF THE STREAM SPLASHES INTO A 2 INCH SLIT IN THE ROCK.",
    ],
  },
  {
    name: "movement-into-forest",
    input: ["N", "FOREST"],
    expect: ["YOU ARE IN OPEN FOREST"],
  },
  {
    name: "movement-blocked-direction",
    input: ["N", "WEST", "WEST"],
    expect: ["THERE IS NO WAY TO GO THAT DIRECTION."],
  },
  {
    name: "movement-enter-water",
    input: ["N", "ENTER WATER"],
    expect: ["YOUR FEET ARE NOW WET."],
  },
  {
    name: "movement-west-nag-after-ten",
    input: ["N", ...Array(10).fill("WEST")],
    expect: ["IF YOU PREFER, SIMPLY TYPE W RATHER THAN WEST."],
  },
  {
    name: "movement-go-verb-prefix",
    input: ["N", "GO WEST", "GO EAST"],
    expect: [
      "YOU HAVE WALKED UP A HILL, STILL IN THE FOREST",
      "YOU'RE AT END OF ROAD AGAIN.",
    ],
  },

  // --- input parsing --------------------------------------------------------
  {
    // Words longer than five characters are truncated (PDP-10 A5 semantics):
    // LOOKING is not LOOK, but DOWNSTREAM truncates to DOWNS, which travels.
    name: "input-five-character-truncation",
    input: ["N", "LOOKING", "DOWNSTREAM"],
    counts: [[UNKNOWN, 1]],
    expect: ["YOU ARE IN A VALLEY IN THE FOREST BESIDE A STREAM"],
  },
  {
    name: "input-long-line-uses-first-two-words",
    input: ["N", "GET LAMP AND THEN LEAVE"],
    expect: ["I SEE NO LAMP HERE."],
  },
  {
    // The second word THE is not in the vocabulary, so the line is rejected.
    name: "input-article-rejected",
    input: ["N", "GET THE LAMP"],
    counts: [[UNKNOWN, 1]],
  },

  // --- bare verbs -----------------------------------------------------------
  {
    name: "bare-verbs-ask-what",
    input: ["N", "GET", "TAKE", "DROP", "STRIKE", "EAT", "DRINK", "POUR", "ATTACK"],
    expect: [
      "GET WHAT?",
      "TAKE WHAT?",
      "DROP WHAT?",
      "STRIKE WHAT?",
      "EAT WHAT?",
      "DRINK WHAT?",
      "POUR WHAT?",
      "ATTACK WHAT?",
    ],
  },
  {
    name: "bare-unlock-nothing-lockable",
    input: ["N", "UNLOCK"],
    expect: ["THERE IS NOTHING HERE WITH A LOCK!"],
  },

  // --- objects in the building ----------------------------------------------
  {
    name: "objects-get-drop-get",
    input: ["N", "IN", "GET LAMP", "DROP LAMP", "GET LAMP"],
    counts: [[/\bOK\b/g, 3]],
  },
  {
    name: "objects-already-carrying",
    input: ["N", "IN", "GET LAMP", "GET LAMP"],
    expect: ["YOU ARE ALREADY CARRYING IT!"],
    counts: [[/\bOK\b/g, 1]],
  },
  {
    name: "objects-verb-synonyms",
    input: ["N", "IN", "TAKE KEYS", "CARRY FOOD", "KEEP WATER"],
    counts: [[/\bOK\b/g, 3]],
  },
  {
    name: "objects-water-comes-with-bottle",
    input: ["N", "IN", "GET WATER", "GET BOTTLE"],
    expect: ["YOU ARE ALREADY CARRYING IT!"],
    counts: [[/\bOK\b/g, 1]],
  },
  {
    name: "objects-drop-while-not-carrying",
    input: ["N", "IN", "DROP KEYS"],
    expect: ["YOU AREN'T CARRYING IT!"],
  },
  {
    name: "lamp-toggle-cycle",
    input: ["N", "IN", "GET LAMP", "LAMP ON", "LAMP OFF", "LAMP ON"],
    counts: [
      [/YOUR LAMP IS NOW ON\./g, 2],
      [/YOUR LAMP IS NOW OFF\./g, 1],
    ],
  },
  {
    name: "lamp-on-without-lamp",
    input: ["N", "LAMP ON"],
    expect: ["YOU HAVE NO SOURCE OF LIGHT."],
  },
  {
    name: "lamp-on-after-drop",
    input: ["N", "IN", "GET LAMP", "DROP LAMP", "LAMP ON"],
    expect: ["YOUR LAMP IS NOW ON."],
  },
  {
    name: "consume-food-and-water",
    input: [
      "N", "IN", "GET FOOD", "GET WATER",
      "EAT FOOD", "DRINK WATER", "POUR WATER", "DRINK WATER",
    ],
    expect: [
      "EATEN!",
      "THE BOTTLE OF WATER IS NOW EMPTY.",
      "YOUR BOTTLE IS EMPTY AND THE GROUND IS WET.",
      "THERE IS NO DRINKABLE WATER HERE.",
    ],
  },
  {
    name: "eat-consumed-food",
    input: ["N", "IN", "GET FOOD", "EAT FOOD", "EAT FOOD"],
    expect: ["EATEN!", "THERE IS NOTHING HERE TO EAT."],
  },
  {
    name: "unlock-keys-and-lamp",
    input: ["N", "IN", "GET KEYS", "GET LAMP", "UNLOCK KEYS", "UNLOCK LAMP"],
    expect: [
      "YOU CAN'T UNLOCK THE KEYS.",
      "I DON'T KNOW HOW TO LOCK OR UNLOCK SUCH A THING.",
    ],
  },
  {
    name: "unlock-unlockable-thing",
    input: ["N", "IN", "UNLOCK LAMP"],
    expect: ["I DON'T KNOW HOW TO LOCK OR UNLOCK SUCH A THING."],
  },
  {
    name: "unlock-without-keys",
    input: ["N", "IN", "GET LAMP", "OUT", "UNLOCK LAMP"],
    expect: ["YOU HAVE NO KEYS!"],
  },

  // --- the grate and cave entrance ------------------------------------------
  {
    name: "grate-locked-blocks-entry",
    input: ["N", "DOWNSTREAM", "DOWN", "DOWN", "UNLOCK GRATE", "IN"],
    expect: [
      DEPRESSION,
      "THE GRATE IS LOCKED",
      "YOU HAVE NO KEYS!",
      "YOU CAN'T GO IN THROUGH A LOCKED STEEL GRATE!",
    ],
  },
  {
    name: "grate-lock-state-machine",
    input: [
      ...caveRoute(),
      "LOCK GRATE",
      "UNLOCK GRATE",
      "UNLOCK GRATE",
      "LOCK GRATE",
      "LOCK GRATE",
    ],
    expect: [
      "THE GRATE IS NOW UNLOCKED.",
      "THE GRATE IS NOW LOCKED.",
      "THE GRATE IS NOW UNLOCKED.",
      "THE GRATE WAS ALREADY UNLOCKED.",
      "THE GRATE IS NOW LOCKED.",
      "THE GRATE WAS ALREADY LOCKED.",
    ],
  },
  {
    name: "grate-hint-answer-no",
    input: ["N", "SOUTH", "SOUTH", "DOWN", "FOO", "BAR", "BAZ", "N", "IN"],
    expect: [
      "ARE YOU TRYING TO GET INTO THE CAVE?",
      "YOU CAN'T GO IN THROUGH A LOCKED STEEL GRATE!",
    ],
    counts: [[/\bOK\b/g, 1]],
  },
  {
    name: "grate-enter-cave",
    input: [...caveRoute(), "IN", "LAMP ON"],
    expect: [
      "YOU ARE IN A SMALL CHAMBER BENEATH A 3X3 STEEL GRATE TO THE SURFACE.",
      "THE GRATE IS OPEN.",
      "YOUR LAMP IS NOW ON.",
    ],
  },

  // --- magic words -----------------------------------------------------------
  {
    name: "xyzzy-no-effect-on-surface",
    input: ["N", "XYZZY"],
    expect: ["NOTHING HAPPENS."],
  },
  {
    name: "plugh-no-effect-on-surface",
    input: ["N", "PLUGH"],
    expect: ["I DON'T KNOW HOW TO APPLY THAT WORD HERE."],
  },
  {
    name: "xyzzy-to-debris-room",
    input: ["N", "IN", "GET LAMP", "LAMP ON", "XYZZY"],
    expect: [DEBRIS, "A NOTE ON THE WALL SAYS 'MAGIC WORD XYZZY'"],
  },
  {
    name: "xyzzy-roundtrip-with-rod",
    input: ["N", "IN", "GET LAMP", "LAMP ON", "XYZZY", "GET ROD", "PLUGH", "XYZZY"],
    expect: [
      DEBRIS,
      "A THREE FOOT BLACK ROD WITH A RUSTY STAR ON AN END LIES NEARBY",
      "I DON'T KNOW HOW TO APPLY THAT WORD HERE.",
      "YOU'RE INSIDE BUILDING.",
    ],
    counts: [[/\bOK\b/g, 2]],
  },

  // --- darkness ---------------------------------------------------------------
  {
    name: "darkness-without-lit-lamp",
    input: [...caveRoute(), "IN", "WEST", "WEST"],
    expect: [
      PITCH_BLACK,
      "A THREE FOOT BLACK ROD WITH A RUSTY STAR ON AN END LIES NEARBY",
    ],
  },
  {
    name: "darkness-suppressed-with-lit-lamp",
    input: [
      "N", "IN", "GET LAMP", "LAMP ON", "GET KEYS",
      "OUT", "SOUTH", "SOUTH", "DOWN", "UNLOCK GRATE",
      "IN", "WEST", "WEST",
    ],
    expect: [DEBRIS],
    forbid: ["PITCH BLACK"],
  },
  {
    // Falling into a pit in the dark is a 25% rng event that this exact
    // input sequence triggers twice (on the UP and the following WEST);
    // the 1976 game prints GAME IS OVER and then carries on.
    name: "darkness-pit-falls-not-fatal",
    input: [
      ...caveRoute(), "IN", "WEST", "WEST",
      "LOOK", "WEST", "UP", "WEST", "LOOK",
    ],
    counts: [
      [new RegExp(PIT_FALL.replace(/[!.]/g, (m) => `\\${m}`), "g"), 2],
      [/GAME IS OVER/g, 2],
      [/SORRY, BUT I AM NOT ALLOWED TO GIVE MORE DETAIL/g, 2],
    ],
    expect: ["YOU ARE IN AN AWKWARD SLOPING EAST/WEST CANYON."],
  },

  // --- the bird -----------------------------------------------------------------
  {
    name: "bird-cannot-carry-barehanded",
    input: [...birdChamberRoute({ lampOn: true }), "GET BIRD"],
    expect: [
      "A CHEERFUL LITTLE BIRD IS SITTING HERE SINGING.",
      "YOU CAN CATCH THE BIRD, BUT YOU CANNOT CARRY IT.",
    ],
  },
  {
    name: "bird-scared-by-carried-rod",
    input: [...birdChamberRoute({ lampOn: true, rod: true }), "GET BIRD"],
    expect: [
      "THE BIRD WAS UNAFRAID WHEN YOU ENTERED, BUT AS YOU APPROACH IT BECOMES " +
        "DISTURBED AND YOU CANNOT CATCH IT.",
    ],
  },
  {
    name: "bird-captured-with-cage",
    input: [
      "N", "IN", "GET LAMP", "LAMP ON", "GET KEYS",
      "OUT", "SOUTH", "SOUTH", "DOWN", "UNLOCK GRATE",
      "IN", "WEST", "GET CAGE", "WEST",
      "GET ROD", "DROP ROD", "UP", "WEST", "GET BIRD",
    ],
    expect: [
      "THERE IS A SMALL WICKER CAGE DISCARDED NEARBY.",
      "A CHEERFUL LITTLE BIRD IS SITTING HERE SINGING.",
    ],
    forbid: ["YOU CANNOT CATCH IT", "UNAFRAID"],
    counts: [[/\bOK\b/g, 6]],
  },
  {
    // The 1976 code removed a killed captive bird via the pickup path's
    // unlink from the room chain; the bird is not in that chain, so the
    // scan hangs the game forever. The port skips the unlink for carried
    // birds and this test proves the sequence completes.
    name: "kill-captive-bird-does-not-hang",
    input: [
      "N", "IN", "GET LAMP", "LAMP ON", "GET KEYS",
      "OUT", "SOUTH", "SOUTH", "DOWN", "UNLOCK GRATE",
      "IN", "WEST", "GET CAGE", "WEST",
      "GET ROD", "DROP ROD", "UP", "WEST", "GET BIRD",
      "ATTACK BIRD",
    ],
    expect: [
      "A CHEERFUL LITTLE BIRD IS SITTING HERE SINGING.",
      "THE LITTLE BIRD IS NOW DEAD. ITS BODY DISAPPEARS.",
    ],
    forbid: ["PITCH BLACK"],
    counts: [[/\bOK\b/g, 7]],
  },
  {
    name: "bird-hint-while-carrying-rod",
    input: [
      ...birdChamberRoute({ lampOn: true, rod: true }),
      "FOO", "BAR", "BAZ", "Y",
    ],
    expect: [
      "ARE YOU TRYING TO CATCH THE BIRD?",
      "THE BIRD IS FRIGHTENED RIGHT NOW AND YOU CANNOT CATCH IT NO MATTER " +
        "WHAT YOU TRY.",
    ],
  },
  {
    name: "kill-bird",
    input: [...birdChamberRoute({}), "ATTACK BIRD", "GET BIRD", "KILL BIRD"],
    expect: [
      "THE LITTLE BIRD IS NOW DEAD. ITS BODY DISAPPEARS.",
      "I SEE NO BIRD HERE.",
      "I SEE NO BIRD HERE.",
    ],
  },

  // --- special vocabulary ---------------------------------------------------------
  {
    name: "special-words",
    input: ["N", "NOTHING", "DUMMY", "THROW", "FUCK", "TREE", "DIG", "BLAST", "LOST", "MIST"],
    expect: [
      "DUMMY WHAT?",
      "I HAVE TROUBLE WITH THE WORD 'THROW' BECAUSE YOU CAN THROW A THING " +
        "OR THROW AT A THING. PLEASE USE DROP OR ATTACK INSTEAD.",
      "WATCH IT!",
      "THE TREES OF THE FOREST ARE LARGE HARDWOOD OAK AND MAPLE",
      "DIGGING WITHOUT A SHOVEL IS QUITE IMPRACTICAL: EVEN WITH A SHOVEL PROGRESS IS UNLIKELY.",
      "BLASTING REQUIRES DYNAMITE.",
      "I'M AS CONFUSED AS YOU ARE.",
      "MIST IS A WHITE VAPOR, USUALLY WATER",
    ],
    counts: [[/\bOK\b/g, 1]],
  },

  // --- quirks ------------------------------------------------------------------------
  {
    // Crowther quirk: GET GRATE from the surface resolves the grate as a
    // distant landmark and travels you to the depression.
    name: "get-grate-travels-to-depression",
    input: ["N", "GET GRATE"],
    expect: [DEPRESSION, "THE GRATE IS LOCKED"],
  },

  // --- deep walk (parity-heavy) ------------------------------------------------------
  {
    // Deterministic long walk into the deep cave: down the small pit into
    // the Hall of Mists, where the fixed rng seed triggers the dwarf's
    // first axe throw, then on to the Hall of the Mountain King where the
    // snake bars the way and the dwarf kills the player twice ("GAMES
    // OVER" prints, yet the 1976 game carries on). Native parity proves
    // the wasm port reproduces the whole rng-driven sequence exactly.
    name: "deep-walk-dwarf-encounters",
    input: [
      "N", "IN", "GET LAMP", "LAMP ON", "GET KEYS",
      "OUT", "SOUTH", "SOUTH", "DOWN", "UNLOCK GRATE",
      "IN", "WEST", "WEST", "GET ROD", "UP", "WEST",
      "WEST", "DOWN", "WEST", "EAST",
      "NORTH", "WEST", "SOUTH", "EAST", "UP", "NORTH", "LOOK",
    ],
    expect: [
      "YOU ARE AT ONE END OF A VAST HALL STRETCHING FORWARD OUT OF SIGHT TO THE WEST.",
      "A LITTLE DWARF JUST WALKED AROUND A CORNER,SAW YOU, THREW A LITTLE " +
        "AXE AT YOU WHICH MISSED, CURSED, AND RAN AWAY.",
      "A HUGE GREEN FIERCE SNAKE BARS THE WAY!",
      "YOU CAN'T GET BY THE SNAKE",
      "IT GETS YOU!",
      "GAMES OVER",
      "A LITTLE DWARF WITH A BIG KNIFE BLOCKS YOUR WAY.",
    ],
  },
];

// --- runner ------------------------------------------------------------------------

const args = process.argv.slice(2);
const showOutput = args.includes("--show");
const noParity = args.includes("--no-parity");
const nativeOnly = args.includes("--native-only");
const filter = args.find((arg) => !arg.startsWith("--"));

const envBinary = process.env.ADVENTURE_NATIVE;
if (envBinary) {
  try {
    statSync(envBinary);
  } catch {
    console.error(`ADVENTURE_NATIVE binary not found: ${envBinary}`);
    process.exit(2);
  }
}

const collapse = (text) => text.replace(/\s+/g, " ").trim();

// Returns the native binary path to use, or null when no native backend is
// available (gfortran missing and no ADVENTURE_NATIVE override).
function resolveNativeBinary() {
  if (envBinary) return envBinary;

  const gfortran = spawnSync("gfortran", ["--version"], { encoding: "utf8" });
  if (gfortran.status !== 0) return null;

  let needsBuild = true;
  try {
    const binaryTime = statSync(nativeBinary).mtimeMs;
    needsBuild = sources.some((path) => statSync(path).mtimeMs > binaryTime);
  } catch {
    needsBuild = true;
  }

  if (needsBuild) {
    const concat = spawnSync("sh", ["-c",
      `cat src/adventure.f src/adventure_shims.f > build/adventure_all.f`],
      { cwd: root, encoding: "utf8" });
    if (concat.status !== 0) process.exit(1);
    const build = spawnSync("gfortran", [
      "-O0", "-fno-align-commons",
      "-o", nativeBinary, "build/adventure_all.f",
    ], { cwd: root, encoding: "utf8" });
    if (build.status !== 0) {
      console.error(`gfortran failed:\n${build.stderr}`);
      process.exit(1);
    }
  }
  return nativeBinary;
}

function assertOutput(test, out) {
  const problems = [];
  const flow = collapse(out);

  let cursor = 0;
  for (const item of test.expect ?? []) {
    const needle = collapse(item);
    const index = flow.indexOf(needle, cursor);
    if (index === -1) {
      problems.push(`missing expected text: "${needle}"`);
    } else {
      cursor = index + needle.length;
    }
  }
  for (const item of test.forbid ?? []) {
    const needle = collapse(item);
    if (flow.includes(needle)) problems.push(`forbidden text present: "${needle}"`);
  }
  for (const [pattern, expected] of test.counts ?? []) {
    const actual = (out.match(pattern) || []).length;
    if (actual !== expected) {
      problems.push(`count of ${pattern} = ${actual}, expected ${expected}`);
    }
  }
  if (!flow.includes("*** GAME OVER ***")) problems.push("session did not end with GAME OVER");
  return problems;
}

function firstDifference(a, b) {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const limit = Math.max(linesA.length, linesB.length);
  for (let index = 0; index < limit; index++) {
    if (linesA[index] !== linesB[index]) {
      const context = [];
      for (let offset = Math.max(0, index - 1); offset <= Math.min(limit - 1, index + 1); offset++) {
        context.push(`  wasm:   ${JSON.stringify(linesA[offset] ?? "<end>")}`);
        context.push(`  native: ${JSON.stringify(linesB[offset] ?? "<end>")}`);
      }
      return `first divergence at output line ${index + 1}:\n${context.join("\n")}`;
    }
  }
  return "";
}

const nativeBinaryPath = resolveNativeBinary();
const runNativeSide = nativeOnly
  ? nativeBinaryPath !== null
  : nativeBinaryPath !== null && !noParity;

if (nativeOnly && !nativeBinaryPath) {
  console.error("--native-only requires gfortran or ADVENTURE_NATIVE");
  process.exit(2);
}
if (!nativeOnly && !runNativeSide) {
  console.log("-- native parity disabled (gfortran not found or --no-parity) --");
}

let selected = tests.filter((test) => !test.skip);
if (filter) selected = selected.filter((test) => test.name.includes(filter));
if (selected.length === 0) {
  console.error(`no tests match "${filter ?? ""}"`);
  process.exit(2);
}

let passed = 0;
const failures = [];

for (const test of selected) {
  const problems = [];
  let wasmOut = null;
  let wasmTimedOut = false;

  if (!nativeOnly) {
    const wasm = await runWasm(wasmPath, test.input, { timeoutMs: 15_000 });
    wasmOut = normalize(wasm.output);
    wasmTimedOut = wasm.timedOut;
    if (wasm.timedOut) problems.push("wasm run timed out");
    problems.push(...assertOutput(test, wasmOut));
  }

  let nativeOut = null;
  if (runNativeSide) {
    const native = await runNative(nativeBinaryPath, test.input, {
      cwd: root,
      timeoutMs: 15_000,
    });
    if (native.timedOut) problems.push("native run timed out");
    nativeOut = normalize(native.output);
    problems.push(...assertOutput(test, nativeOut).map((p) => (nativeOnly ? p : `native: ${p}`)));
    if (!nativeOnly && !native.timedOut && !wasmTimedOut && wasmOut !== nativeOut) {
      problems.push(`wasm and native output diverge\n${firstDifference(wasmOut, nativeOut)}`);
    }
  }

  if (problems.length === 0) {
    passed++;
    console.log(`PASS ${test.name}`);
  } else {
    failures.push(test.name);
    console.log(`FAIL ${test.name}`);
    for (const problem of problems) console.log(`     ${problem.split("\n").join("\n     ")}`);
    if (showOutput) {
      const toShow = wasmOut ?? nativeOut ?? "";
      console.log("     --- captured output ---");
      console.log(toShow.split("\n").map((l) => `     ${l}`).join("\n"));
    }
  }
}

console.log(`\n${passed}/${selected.length} tests passed` +
  (failures.length ? `; failures: ${failures.join(", ")}` : ""));
process.exit(failures.length ? 1 : 0);
