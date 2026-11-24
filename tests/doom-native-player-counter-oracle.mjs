// Compile the live-counter tail of pinned P_PlayerThink without movement or weapons.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function source(upstream, cases) {
    const user = readFileSync(path.join(upstream, "p_user.c"), "utf8").replaceAll("\r\n", "\n");
    const begin = user.indexOf("    // Counters, time dependend power ups.");
    const end = user.lastIndexOf("\n}");
    assert.ok(begin >= 0 && end > begin, "Missing P_PlayerThink counter tail");
    const tail = user.slice(begin, end);
    const fixtures = cases.map(entry => `run(${entry.strength}, ${entry.invulnerability}, ${entry.invisibility}, ${entry.infrared}, ${entry.iron}, ${entry.damage}, ${entry.bonus}, ${entry.shadow});`).join("\n");
    return `#include <stdio.h>
#include <stdlib.h>
typedef int boolean;
enum { false, true };
enum { pw_invulnerability, pw_strength, pw_invisibility, pw_ironfeet, pw_allmap, pw_infrared };
enum { MF_SHADOW = 0x40000, INVERSECOLORMAP = 32 };
typedef struct { int flags; } mobj_t;
typedef struct { mobj_t *mo; int powers[6], damagecount, bonuscount, fixedcolormap; } player_t;
static void tick(player_t *player) {
${tail}
}
static void run(int strength, int invulnerability, int invisibility, int infrared, int iron, int damage, int bonus, int shadow) {
    mobj_t mo = {shadow ? MF_SHADOW : 0};
    player_t player = {&mo, {0}, damage, bonus, 0};
    player.powers[pw_strength] = strength;
    player.powers[pw_invulnerability] = invulnerability;
    player.powers[pw_invisibility] = invisibility;
    player.powers[pw_infrared] = infrared;
    player.powers[pw_ironfeet] = iron;
    tick(&player);
    printf("{\\\"powers\\\":[%d,%d,%d,%d,%d,%d],\\\"damage\\\":%d,\\\"bonus\\\":%d,\\\"colormap\\\":%d,\\\"shadow\\\":%d}\\n",
        player.powers[0], player.powers[1], player.powers[2], player.powers[3], player.powers[4], player.powers[5],
        player.damagecount, player.bonuscount, player.fixedcolormap, (player.mo->flags & MF_SHADOW) != 0);
}
int main(void) { ${fixtures} return 0; }
`;
}

export function runNativePlayerCounterOracle(upstream, scratch, cases) {
    const input = path.join(scratch, "player-counter-native.c");
    const executable = path.join(scratch, "player-counter-native.exe");
    writeFileSync(input, source(upstream, cases));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", executable]);
    const frames = run(executable, []).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(frames.length, cases.length);
    return frames;
}
