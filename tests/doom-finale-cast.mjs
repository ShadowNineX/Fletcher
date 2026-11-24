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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-cast-"));
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const idleTics = 280, maximumTics = 7500, lastIndex = 16;

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function fletcher() {
    const input = path.join(scratch, "cast.flt"), output = path.join(scratch, "cast.json");
    writeFileSync(input, `package main
import "play"

map "Finale cast state traces" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register cast play.FinaleCast = play.FinaleCast{}
    register actorTics int = 0
    register complete bit = false
    tick {
        if !complete {
            nextCast := cast
            if currentTick() == 0 {
                nextCast = play.StartFinaleCast()
            } else if actorTics >= ${idleTics} && !cast.Dying || cast.Dying && actorTics % 5 == 0 {
                nextCast = play.RespondFinaleCast(cast)
            } else {
                nextCast = play.TickFinaleCast(cast)
            }
            log(nextCast.Index, nextCast.Kind, nextCast.State, nextCast.Tics, nextCast.Frames,
                nextCast.Dying, nextCast.Attacking, nextCast.OnMelee, nextCast.Sound)
            next cast = nextCast
            if nextCast.Index == cast.Index { next actorTics = actorTics + 1 } else { next actorTics = 0 }
            if cast.Index == ${lastIndex} && nextCast.Index == 0 { next complete = true }
        }
    }
}
`);
    run("dotnet", [cli, "build", input, "--package-root", path.join(root, "examples/doom-engine"), "-o", output]);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const sim = simulator(decode(encoded), true);
    for (let host = 0; host < maximumTics * 3; host++) {
        sim.step();
        if (Number(sim.logs.at(-1)?.[0]) === 0 && Number(sim.logs.at(-2)?.[0]) === lastIndex) break;
    }
    return sim.logs.map(row => Array.from(row, Number));
}

function native(upstream) {
    const read = file => readFileSync(path.resolve(root, upstream, file), "utf8").replaceAll("\r\n", "\n");
    const source = read("info.c"), finale = read("f_finale.c");
    const metadata = source.slice(source.indexOf("char *sprnames["));
    const header = read("info.h").replace(/^#include "d_think.h"$/m, "");
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)[0];
    const actions = [...new Set(Array.from(metadata.matchAll(/void\s+(A_[A-Za-z0-9_]+)\s*\(/g), match => match[1]))];
    const actionStubs = actions.map(name => `void ${name}(void) { abort(); }`).join("\n");
    const cast = Array.from(finale.matchAll(/\{\s*CC_[A-Z]+,\s*(MT_[A-Z]+)\s*\}/g), match => match[1]);
    assert.equal(cast.length, lastIndex + 1);
    const entries = cast.map(kind => `    { "A", ${kind} },`).join("\n");
    const input = path.join(scratch, "cast.c"), exe = path.join(scratch, "cast.exe");
    writeFileSync(input, `#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef enum { false, true } boolean;
typedef union { void (*acv)(void); void (*acp1)(void *); } actionf_t;
#define FRACUNIT 65536
${header}
${read("sounds.h")}
${flags}
${actionStubs}
${metadata}

static struct { const char *name; mobjtype_t type; } castorder[] = {
${entries}
    { NULL, 0 }
};
typedef enum { ev_keydown } evtype_t;
typedef struct { evtype_t type; } event_t;
static int finalestage, wipegamestate, castnum, casttics, castframes, castonmelee, sound;
static boolean castdeath, castattacking;
static state_t *caststate;
static void S_ChangeMusic(int id, boolean loop) { assert(id == mus_evil && loop); }
static void S_StartSound(void *origin, int id) { assert(!origin); sound=id; }

${extractFunction(finale, "void", "F_StartCast")}
${extractFunction(finale, "void", "F_CastTicker")}
${extractFunction(finale, "boolean", "F_CastResponder")}

int main(void) {
    int actorTics=0;
    event_t key={ev_keydown};
    for (int time=0; time<${maximumTics}; time++) {
        int previous=castnum;
        sound=0;
        if (time == 0) F_StartCast();
        else if ((actorTics>=${idleTics} && !castdeath) || (castdeath && actorTics%5==0)) {
            assert(F_CastResponder(&key));
        } else F_CastTicker();
        printf("%d,%d,%d,%d,%d,%d,%d,%d,%d\\n", castnum, castorder[castnum].type,
               (int)(caststate-states), casttics, castframes, castdeath, castattacking, castonmelee, sound);
        actorTics = castnum == previous ? actorTics+1 : 0;
        if (previous==${lastIndex} && castnum==0) return EXIT_SUCCESS;
    }
    return EXIT_FAILURE;
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => line.split(",").map(Number));
}

try {
    const observed = fletcher();
    assert.deepEqual(observed.slice(-2).map(row => row[0]), [lastIndex, 0], "all 17 cast members cycle back to the first");
    assert.equal(observed[0][1], 1, "the cast starts with the former human");
    assert.ok(observed.some(row => row[6] && row[8]), "the cast emits attack-state sound cues");
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const expected = native(values.upstream);
        assert.equal(observed.length, expected.length);
        observed.forEach((row, index) => assert.deepEqual(row, expected[index], `cast member ${row[0]}, tic ${index}`));
        console.log(`Matched ${observed.length} cast state rows for all 17 members against pinned C. SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "a3f6c3fa59be2c131f2f584cb7bd46136266813762eddcb3fdfe2b95d5cb008a");
        console.log(`Verified ${observed.length} cast states against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-cast-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
