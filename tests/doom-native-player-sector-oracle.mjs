// Pinned P_PlayerInSpecialSector runner with a small, sector-aware damage sink.
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
    const read = file => readFileSync(path.join(upstream, file), "utf8").replaceAll("\r\n", "\n");
    const random = read("light-m_random.c");
    const sector = extractFunction(read("animated-p_spec.c"), "void", "P_PlayerInSpecialSector");
    const fixtures = cases.map(entry => `run(${entry.special}, ${entry.z}, ${entry.floor}, ${entry.time}, ${entry.iron}, ${entry.health}, ${entry.cheats}, ${entry.random}, ${entry.repeat}, ${entry.restoreSecret ? 1 : 0});`).join("\n");
    return `#include <stddef.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
typedef int boolean;
typedef int fixed_t;
enum { false, true, pw_ironfeet = 3, CF_GODMODE = 2, ga_nothing, ga_completed };
typedef struct { fixed_t floorheight; int special; } sector_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct mobj_s { fixed_t z; subsector_t *subsector; } mobj_t;
typedef struct player_s { mobj_t *mo; int powers[6], secretcount, cheats, health; } player_t;
${random}
static int leveltime, gameaction;
static player_t *active;
static void I_Error(const char *message, ...) { fputs(message, stderr); abort(); }
static void G_ExitLevel(void) { gameaction = ga_completed; }
static void P_DamageMobj(mobj_t *target, void *inflictor, void *source, int damage) {
    (void)target; (void)inflictor; (void)source;
    if (active->mo->subsector->sector->special == 11 && damage >= active->health) damage = active->health - 1;
    active->health -= damage;
    if (active->health > 0) (void)P_Random();
}
${sector}
static void run(int special, int z, int floor, int time, int iron, int health, int cheats, int randomIndex, int repeat, int restoreSecret) {
    sector_t sector = {floor, special}; subsector_t subsector = {&sector};
    mobj_t mo = {z, &subsector}; player_t player = {&mo, {0}, 0, cheats, health};
    active = &player; player.powers[pw_ironfeet] = iron; leveltime = time; prndindex = randomIndex; gameaction = ga_nothing;
    for (int i = 0; i < repeat && sector.special; i++) {
        P_PlayerInSpecialSector(&player);
        if (restoreSecret && i == 0) sector.special = 9;
    }
    printf("{\\\"health\\\":%d,\\\"secret\\\":%d,\\\"cheats\\\":%d,\\\"special\\\":%d,\\\"random\\\":%d,\\\"exit\\\":%d}\\n",
        player.health, player.secretcount, player.cheats, sector.special, prndindex, gameaction == ga_completed);
}
int main(void) { ${fixtures} return 0; }
`;
}

export function runNativePlayerSectorOracle(upstream, scratch, cases) {
    const input = path.join(scratch, "player-sector-native.c");
    const executable = path.join(scratch, "player-sector-native.exe");
    writeFileSync(input, source(upstream, cases));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", input, "-o", executable]);
    const frames = run(executable, []).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(frames.length, cases.length);
    return frames;
}
