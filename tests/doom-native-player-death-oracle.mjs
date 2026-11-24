// Pinned P_DeathThink and P_CalcHeight harness. Cardinal point angles are exact Doom turns.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function source(upstream, cases) {
    const user = readFileSync(path.join(upstream, "p_user.c"), "utf8").replaceAll("\r\n", "\n");
    const fixed = extractFunction(readFileSync(path.join(upstream, "m_fixed.c"), "utf8").replaceAll("\r\n", "\n"), "fixed_t", "FixedMul");
    const tables = readFileSync(path.join(upstream, "tables.c"), "utf8").replaceAll("\r\n", "\n")
        .replace(/^#include.*$/gm, "").replace(/\brcsid\b/g, "tablesRcsid");
    const main = readFileSync(path.join(upstream, "r_main.c"), "utf8").replaceAll("\r\n", "\n");
    const points = [extractFunction(main, "angle_t", "R_PointToAngle"), extractFunction(main, "angle_t", "R_PointToAngle2")].join("\n");
    const calc = extractFunction(user, "void", "P_CalcHeight");
    const death = extractFunction(user, "void", "P_DeathThink");
    const fixtures = cases.map(entry => `run(${entry.z}, ${entry.floor}, ${entry.ceiling}, ${entry.height}, ${entry.angle >>> 0}, ${entry.damage}, ${entry.attacker}, ${entry.use ? 1 : 0}, ${entry.momentumX}, ${entry.momentumY}, ${entry.cheats});`).join("\n");
    return `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef int boolean;
enum { false, true, FRACBITS = 16, FRACUNIT = 65536, VIEWHEIGHT = 41 * FRACUNIT, FINEANGLES = 8192, FINEMASK = 8191, MAXBOB = 0x100000, SLOPERANGE = 2048 };
enum { ANG90 = UINT32_C(0x40000000), ANG180 = UINT32_C(0x80000000), ANG270 = UINT32_C(0xc0000000), CF_NOMOMENTUM = 4, PST_LIVE, PST_DEAD, PST_REBORN, BT_USE = 1 };
typedef struct mobj_s { fixed_t x, y, z, floorz, ceilingz, momx, momy; angle_t angle; } mobj_t;
typedef struct { int buttons; } ticcmd_t;
typedef struct player_s { mobj_t *mo, *attacker; int viewheight, deltaviewheight, viewz, bob, cheats, playerstate, damagecount; ticcmd_t cmd; } player_t;
static boolean onground;
static int leveltime;
#define ANG5 (ANG90 / 18)
${tables}
${fixed}
static fixed_t viewx, viewy;
${points}
static void P_MovePsprites(player_t *player) { (void)player; }
${calc}
${death}
static void run(int z, int floor, int ceiling, int height, uint32_t angle, int damage, int attacker, int use, int momentumX, int momentumY, int cheats) {
    mobj_t body = {0, 0, z, floor, ceiling, momentumX, momentumY, angle};
    mobj_t enemy = {attacker == 3 || attacker == 4 ? 64 * FRACUNIT : 0, attacker == 5 ? -64 * FRACUNIT : attacker == 3 ? 0 : 64 * FRACUNIT, 0, 0, 0, 0, 0, 0};
    player_t player = {&body, attacker == 1 || attacker == 3 || attacker == 4 || attacker == 5 ? &enemy : attacker == 2 ? &body : 0, height, 7 * FRACUNIT, 0, 0, cheats, PST_DEAD, damage, {use ? BT_USE : 0}};
    P_DeathThink(&player);
    printf("{\\\"angle\\\":%u,\\\"height\\\":%d,\\\"delta\\\":%d,\\\"z\\\":%d,\\\"damage\\\":%d,\\\"reborn\\\":%d}\\n",
        body.angle, player.viewheight, player.deltaviewheight, player.viewz, player.damagecount, player.playerstate == PST_REBORN);
}
int main(void) { ${fixtures} return 0; }
`;
}

export function runNativePlayerDeathOracle(upstream, scratch, cases) {
    const input = path.join(scratch, "player-death-native.c");
    const executable = path.join(scratch, "player-death-native.exe");
    writeFileSync(input, source(upstream, cases));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", input, "-o", executable]);
    const frames = run(executable, []).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(frames.length, cases.length);
    return frames;
}
