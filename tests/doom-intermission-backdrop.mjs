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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-backdrop-"));
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function fletcher() {
    const input = path.join(scratch, "backdrop.flt"), output = path.join(scratch, "backdrop.json");
    const fields = Array.from({length: 10}, (_, i) => `advanced.Frame[${i}], advanced.NextTic[${i}]`).join(", ");
    writeFileSync(input, `package main
import "play"
map "Doom intermission backdrop" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register summary play.IntermissionState = play.IntermissionState{}
    register animation play.IntermissionBackdrop = play.IntermissionBackdrop{}
    tick {
        profile := currentTick() / 60
        time := currentTick() % 60 + 1
        previous, active := summary, animation
        if time == 1 {
            episode := profile
            if profile == 4 { episode = 0 }
            route := play.CampaignRoute{Valid: true, Episode: episode, Commercial: profile == 4, NextMap: 8}
            previous = play.IntermissionState{Stage: play.IntermissionStats, Route: route}
            active = play.StartIntermissionBackdrop(previous, play.RandomState{MenuIndex: 42, GameplayIndex: 137})
        }
        current := previous
        current.BackgroundTics = time
        if time == 21 { current.Stage = play.IntermissionNext }
        if time == 51 { current.Stage = play.IntermissionDelay }
        advanced := play.TickIntermissionBackdrop(active, previous, current)
        log(profile, time, advanced.Count, advanced.Random.MenuIndex, advanced.Random.GameplayIndex, ${fields})
        next summary = current
        next animation = advanced
    }
}
`);
    run("dotnet", [cli, "build", input, "--package-root", path.join(root, "examples/doom-engine"), "-o", output]);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    const sim = simulator(decode(encoded), true);
    for (let host = 0; host < 1000 && sim.logs.length < 300; host++) sim.step();
    assert.equal(sim.logs.length, 300);
    return sim.logs.map(row => Array.from(row, Number));
}

function native(upstream) {
    const game = readFileSync(path.resolve(root, upstream, "wi_stuff.c"), "utf8").replaceAll("\r\n", "\n");
    const random = readFileSync(path.resolve(root, upstream, "light-m_random.c"), "utf8").replaceAll("\r\n", "\n");
    const types = game.slice(game.indexOf("typedef enum\n{\n    ANIM_ALWAYS"), game.indexOf("} anim_t;") + "} anim_t;".length);
    const definitions = game.slice(game.indexOf("static anim_t epsd0animinfo[]"), game.indexOf("// GENERAL DATA"));
    const table = random.match(/unsigned char rndtable\[256\]\s*=\s*\{[\s\S]+?\};/)[0];
    const routines = ["WI_initAnimatedBack", "WI_updateAnimatedBack"].map(name => extractFunction(game, "void", name)).join("\n");
    const input = path.join(scratch, "backdrop.c"), exe = path.join(scratch, "backdrop.exe");
    writeFileSync(input, `#include <stdio.h>
enum { NUMEPISODES=3, TICRATE=35, commercial=1, StatCount=1, ShowNextLoc=2, NoState=3 };
typedef struct patch_s patch_t;
${types}
${definitions}
${table}
static int rndindex, prndindex;
${extractFunction(random, "int", "M_Random")}
static int gamemode, bcnt, state;
static struct { int epsd, next; } info, *wbs=&info;
${routines}
int main(void) {
    for (int profile=0; profile<5; profile++) {
        gamemode=profile==4 ? commercial : 0;
        info.epsd=profile==4 ? 0 : profile;
        info.next=8;
        bcnt=0; state=StatCount; rndindex=42; prndindex=137;
        WI_initAnimatedBack();
        int count=gamemode==commercial || info.epsd>2 ? 0 : NUMANIMS[info.epsd];
        for (int time=1; time<=60; time++) {
            bcnt=time;
            WI_updateAnimatedBack();
            if (time==21) { state=ShowNextLoc; WI_initAnimatedBack(); }
            if (time==51) state=NoState;
            printf("%d,%d,%d,%d,%d",profile,time,count,rndindex,prndindex);
            for (int i=0;i<10;i++) {
                if(i<count) printf(",%d,%d",anims[info.epsd][i].ctr,anims[info.epsd][i].nexttic);
                else printf(",0,0");
            }
            puts("");
        }
    }
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => line.split(",").map(Number));
}

try {
    const rows = fletcher();
    const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    if (values.upstream) {
        const expected = native(values.upstream);
        assert.equal(expected.length, rows.length);
        rows.forEach((row, i) => assert.deepEqual(row, expected[i], `profile ${row[0]}, tic ${row[1]}`));
        console.log(`Matched ${rows.length} backdrop frames, deadlines, and RNG indices with pinned C. SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "9d164d0a54ca438b4955b7e8d259261a9af7ffc36ac8dc4e75c66f101051edf8");
        console.log(`Verified ${rows.length} backdrop frames against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-backdrop-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
