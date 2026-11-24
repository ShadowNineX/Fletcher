import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-finale-"));
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const profiles = [
    { episode: 1, map: 8, length: 440, supplied: 0, start: 1568, steps: 6 },
    { episode: 2, map: 8, length: 466, supplied: 0, start: 1646, steps: 6 },
    { episode: 3, map: 8, length: 492, supplied: 0, start: 1724, steps: 6 },
    { episode: 4, map: 8, length: 503, supplied: 0, start: 1757, steps: 6 },
    { episode: 3, map: 8, length: 1, supplied: 1, start: 0, steps: 1480 },
    { episode: 0, map: 6, length: 1, supplied: 1, start: 47, steps: 5 },
    { episode: 0, map: 30, length: 1, supplied: 1, start: 47, steps: 13 },
];
const totalSteps = profiles.reduce((sum, profile) => sum + profile.steps, 0);

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function fletcher() {
    const profileCases = profiles.map((profile, index) => `    case ${index}:
        return Profile{Episode: ${profile.episode}, Map: ${profile.map},
            Length: ${profile.supplied}, Start: ${profile.start}, Steps: ${profile.steps}}`).join("\n");
    const input = path.join(scratch, "finale.flt"), output = path.join(scratch, "finale.json");
    writeFileSync(input, `package main
import "play"

type Profile struct { Episode int; Map int; Length int; Start int; Steps int }
func testProfile(index int) Profile {
    switch index {
${profileCases}
    }
    return Profile{}
}

map "Finale ticker and bunny stages" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register sample int = 0
    register elapsed int = 0
    register finale play.FinaleState = play.FinaleState{}
    tick {
        fixture := testProfile(sample)
        state := finale
        commercial := fixture.Episode == 0
        if elapsed == 0 {
            kind := play.CampaignVictory
            if commercial { kind = play.CampaignStory }
            if fixture.Map == 30 { kind = play.CampaignCast }
            state = play.StartFinale(play.CampaignRoute{Valid: true, Commercial: commercial,
                Episode: fixture.Episode - 1, LastMap: fixture.Map - 1, Finale: kind}, fixture.Length)
            state.Tics = fixture.Start
        }
        state = play.TickFinale(state, commercial && elapsed < 7, false)
        log(sample, elapsed, state.Stage, state.Tics, state.Scroll, state.EndFrame, state.Sound, state.Music, state.Wipe)
        next finale = state
        if elapsed + 1 == fixture.Steps {
            next elapsed = 0
            next sample = sample + 1
        } else { next elapsed = elapsed + 1 }
    }
}
`);
    run("dotnet", [cli, "build", input, "--package-root", path.join(root, "examples/doom-engine"), "-o", output]);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const sim = simulator(decode(encoded), true);
    for (let host = 0; host < totalSteps * 3 && sim.logs.length < totalSteps; host++) sim.step();
    assert.equal(sim.logs.length, totalSteps);
    return sim.logs.map(row => Array.from(row, Number));
}

function native(upstream) {
    const read = file => readFileSync(path.resolve(root, upstream, file), "utf8").replaceAll("\r\n", "\n");
    const finale = read("f_finale.c");
    const calls = profiles.map(({ episode, map, length, start, steps }, index) =>
        `    run(${index}, ${episode}, ${map}, ${length}, ${start}, ${steps});`).join("\n");
    const input = path.join(scratch, "finale.c"), exe = path.join(scratch, "finale.exe");
    writeFileSync(input, `#include <assert.h>
#include <stdio.h>
#include <string.h>

#define SCREENWIDTH 320
#define SCREENHEIGHT 200
#define MAXPLAYERS 4
#define TEXTSPEED 3
#define TEXTWAIT 250
enum { commercial=1, ga_worlddone=1, PU_LEVEL=50, PU_CACHE=100 };
${read("sounds.h")}

typedef struct { int id; } patch_t;
static patch_t left = {2}, right = {1}, end;
static int finalecount, finalestage, gamemode, gamemap, gameepisode, gameaction, wipegamestate;
static char finaletext[600];
static int scroll, frame, sound, music;
static struct { struct { unsigned char buttons; } cmd; } players[MAXPLAYERS];

static patch_t *W_CacheLumpName(const char *name, int tag) {
    (void)tag;
    if (strcmp(name, "PFUB2") == 0) return &left;
    if (strcmp(name, "PFUB1") == 0) return &right;
    assert(strlen(name) == 4 && strncmp(name, "END", 3) == 0);
    end.id = name[3] - '0';
    return &end;
}
static void V_MarkRect(int x, int y, int w, int h) {
    assert(x == 0 && y == 0 && w == SCREENWIDTH && h == SCREENHEIGHT);
}
static void F_DrawPatchCol(int x, patch_t *patch, int col) {
    if (x == 0) scroll = patch->id == 1 ? SCREENWIDTH : col;
    assert(col == (x + scroll) % SCREENWIDTH);
    assert(patch->id == (x + scroll < SCREENWIDTH ? 2 : 1));
}
static void V_DrawPatch(int x, int y, int screen, patch_t *patch) {
    assert(x == 108 && y == 68 && screen == 0 && patch == &end);
    frame = patch->id;
}
static void S_StartSound(void *origin, int id) { assert(origin == NULL); sound = id; }
static void S_StartMusic(int id) { music = id; }
static void F_StartCast(void) { finalestage=2; music=mus_evil; wipegamestate=-1; }
static void F_CastTicker(void) {}

${extractFunction(finale, "void", "F_Ticker")}
${extractFunction(finale, "void", "F_BunnyScroll")}

static void run(int profile, int episode, int map, int length, int start, int steps) {
    gameepisode=episode; gamemap=map; gamemode=episode==0 ? commercial : 0;
    finalecount=start; finalestage=gameaction=0;
    memset(finaletext, 'A', length); finaletext[length]='\\0';
    for (int elapsed=0; elapsed<steps; elapsed++) {
        // G_BuildTiccmd's pause special also counts as a nonzero button.
        players[0].cmd.buttons=gamemode==commercial && elapsed<7 ? (gamemap==6 ? 0x81 : 1) : 0;
        scroll=SCREENWIDTH; frame=-1; sound=music=wipegamestate=0;
        F_Ticker();
        if (finalestage==1 && episode==3) F_BunnyScroll();
        printf("%d,%d,%d,%d,%d,%d,%d,%d,%d\\n",profile,elapsed,gameaction ? 0 : finalestage+1,
            finalecount,scroll,frame,sound,music,wipegamestate == -1);
    }
}
int main(void) {
${calls}
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => line.split(",").map(Number));
}

try {
    const observed = fletcher();
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const expected = native(values.upstream);
        assert.equal(expected.length, observed.length);
        observed.forEach((row, index) => assert.deepEqual(row, expected[index], `profile ${row[0]}, tic ${row[1]}`));
        console.log(`Matched ${observed.length} finale stage, timer, scroll, audio and wipe rows with pinned C. SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "e551fc110aa42fadae98a7654ea3bc4f9785c7a53e8e3791ff5aad64f1962484");
        console.log(`Verified ${observed.length} finale transitions and art timing rows against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-finale-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
