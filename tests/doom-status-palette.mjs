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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-status-palette-"));
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const cases = [
    ...Array.from({ length: 66 }, (_, damage) => [damage, 0, 0, 200]),
    ...Array.from({ length: 34 }, (_, bonus) => [0, bonus, 0, 200]),
    ...Array.from({ length: 132 }, (_, suit) => [0, 0, 0, suit]),
    ...[1, 8, 63, 64, 191, 192, 255, 256, 512, 704, 767, 768, 2000].flatMap(strength =>
        [[0, 0, strength, 0], [7, 10, strength, 200], [0, 10, strength, 200]]),
    [100, 100, 1, 32], [0, 100, 1900, 32], [0, 0, 1900, 0],
];

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function fletcher() {
    const input = path.join(scratch, "palette.flt"), output = path.join(scratch, "palette.json");
    const profiles = cases.map(profile => `    ${profile.join(", ")},`).join("\n");
    writeFileSync(input, `package main
import "play"

const Profiles = [${cases.length * 4}]int{
${profiles}
}

map "Doom active PLAYPAL row" {
    screen at (0, 0) size (1, 1) with { style = "solid", slice = true }
    tick {
        if currentTick() < ${cases.length} {
            offset := currentTick() * 4
            inventory := play.PlayerInventory{DamageCount: Profiles[offset], BonusCount: Profiles[offset + 1]}
            inventory.Powers[play.PowerStrength] = Profiles[offset + 2]
            inventory.Powers[play.PowerIronFeet] = Profiles[offset + 3]
            log(play.StatusPalette(inventory))
        }
    }
}
`);
    run("dotnet", [cli, "build", input, "--package-root", path.join(root, "examples/doom-engine"), "-o", output]);
    const data = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(data, "base64")[2], 1);
    const sim = simulator(decode(data), true);
    for (let host = 0; host < cases.length && sim.logs.length < cases.length; host++) sim.step();
    assert.equal(sim.logs.length, cases.length);
    return sim.logs.map(([row]) => Number(row));
}

function native(upstream) {
    const status = readFileSync(path.resolve(root, upstream, "st_stuff.c"), "utf8").replaceAll("\r\n", "\n");
    const indices = Array.from(status.matchAll(/^#define\s+(?:STARTREDPALS|STARTBONUSPALS|NUMREDPALS|NUMBONUSPALS|RADIATIONPAL)\s+\d+/gm),
        match => match[0]);
    assert.equal(indices.length, 5);
    const fixtures = cases.map(profile => `    {${profile.join(", ")}},`).join("\n");
    const input = path.join(scratch, "palette.c"), exe = path.join(scratch, "palette.exe");
    writeFileSync(input, `#include <assert.h>
#include <stdio.h>

${indices.join("\n")}
typedef unsigned char byte;
enum { pw_strength, pw_ironfeet, PU_CACHE };
static struct { int damagecount, bonuscount, powers[2]; } player, *plyr = &player;
static byte playpal[(RADIATIONPAL + 1) * 768];
static const int lu_palette = 1;
static int st_palette = -1, active = -1;
static byte *W_CacheLumpNum(int lump, int tag) { assert(lump == lu_palette && tag == PU_CACHE); return playpal; }
static void I_SetPalette(byte *entry) { active = (int)(entry - playpal) / 768; }
${extractFunction(status, "void", "ST_doPaletteStuff")}

static const int fixtures[][4] = {
${fixtures}
};
int main(void) {
    for (size_t i = 0; i < sizeof(fixtures) / sizeof(fixtures[0]); i++) {
        player.damagecount = fixtures[i][0];
        player.bonuscount = fixtures[i][1];
        player.powers[pw_strength] = fixtures[i][2];
        player.powers[pw_ironfeet] = fixtures[i][3];
        ST_doPaletteStuff();
        printf("%d\\n", active);
    }
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(Number);
}

try {
    const actual = fletcher();
    const digest = createHash("sha256").update(JSON.stringify(actual)).digest("hex");
    if (values.upstream) {
        const expected = native(values.upstream);
        assert.equal(actual.length, expected.length);
        actual.forEach((row, index) => assert.equal(row, expected[index], `damage, bonus, strength, suit = ${cases[index]}`));
        console.log(`Matched ${actual.length} PLAYPAL transitions and precedence cases with pinned C. SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "9aa66b78430b32a74f200f316b8d5822221de86030cc7b8d85a53c384e9e74d5");
        console.log(`Verified ${actual.length} PLAYPAL selection cases against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-status-palette-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
