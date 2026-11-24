// Exact pinned use/crossing, lock, switch, door construction, and exit routines.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function fixtureSource({ special, keys = 0, player = true, back = false, secretLine = false, busy = 9,
    texture = true, tag = 7, commercial = false, map31 = false, crossing = false, priorSecret = false }) {
    const args = [special, keys, +player, +secretLine, busy, +texture, tag, +commercial, +map31, +priorSecret];
    const action = crossing ? `P_CrossSpecialLine(0, ${+back}, &actor);` : `used = P_UseSpecialLine(&actor, &lines[0], ${+back});`;
    return `setup(${args}); ${action} emit();`;
}

function compileSource(upstream, cases) {
    const read = name => readFileSync(path.join(upstream, name), "utf8").replaceAll("\r\n", "\n");
    const doors = read("door-p_doors.c"), switches = read("switch-p_switch.c"), game = read("g_game.c");
    const use = extractFunction(switches, "boolean", "P_UseSpecialLine");
    const cross = extractFunction(read("animated-p_spec.c"), "void", "P_CrossSpecialLine");
    const unrelated = [...new Set((use + cross).match(/\bEV_[A-Za-z]+\b/g))]
        .filter(name => !["EV_DoDoor", "EV_DoLockedDoor", "EV_VerticalDoor"].includes(name));
    return [
        HEADER, read("sounds.h"), WORLD,
        extractFunction(doors, "int", "EV_DoDoor"), extractFunction(doors, "int", "EV_DoLockedDoor"),
        extractFunction(doors, "void", "EV_VerticalDoor"), extractFunction(switches, "void", "P_StartButton"),
        extractFunction(switches, "void", "P_ChangeSwitchTexture"),
        extractFunction(game, "void", "G_ExitLevel"), extractFunction(game, "void", "G_SecretExitLevel"),
        ...unrelated.map(name => `#define ${name}(...) (abort(), 0)`), use, cross, FIXTURES,
        "int main(void) {", ...cases.map(fixtureSource), "return 0;\n}",
    ].join("\n");
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

export function runNativeKeyedDoorOracle(upstream, scratch, cases) {
    const source = path.join(scratch, "keyed-door-native.c"), executable = path.join(scratch, "keyed-door-native.exe");
    writeFileSync(source, compileSource(upstream, cases));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", executable]);
    const frames = run(executable, []).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(frames.length, cases.length);
    return frames;
}

const HEADER = String.raw`
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef bool boolean;
typedef int fixed_t;
typedef void (*actionf_p1)(void *);
typedef struct { union { actionf_p1 acp1; } function; } thinker_t;
typedef enum { normal, close30ThenOpen, close, open, raiseIn5Mins, blazeRaise, blazeOpen, blazeClose } vldoor_e;
typedef enum { top, middle, bottom } bwhere_e;
enum { FRACUNIT = 65536, VDOORSPEED = 2 * FRACUNIT, VDOORWAIT = 150, PU_LEVSPEC = 51 };
enum { ML_SECRET = 32, MAXBUTTONS = 16, BUTTONTIME = 35 };
enum { it_bluecard, it_yellowcard, it_redcard, it_blueskull, it_yellowskull, it_redskull };
enum { PD_BLUEK = 1, PD_YELLOWK, PD_REDK, PD_BLUEO, PD_YELLOWO, PD_REDO };
enum { shareware, commercial };
enum { ga_nothing, ga_completed };
enum { MT_ROCKET = 33, MT_PLASMA, MT_BFG, MT_TROOPSHOT = 31, MT_HEADSHOT, MT_BRUISERSHOT = 16 };
`;

const WORLD = String.raw`
typedef struct { int cards[6], message; } player_t;
typedef struct { player_t *player; int type; } mobj_t;
typedef struct { int floorheight, ceilingheight, tag, soundorg; void *specialdata; } sector_t;
typedef struct { int toptexture, midtexture, bottomtexture; sector_t *sector; } side_t;
typedef struct { int special, tag, flags, sidenum[2]; sector_t *frontsector; } line_t;
typedef struct { thinker_t thinker; sector_t *sector; vldoor_e type; int direction, speed, topwait, topheight, topcountdown; } vldoor_t;
typedef struct { line_t *line; bwhere_e where; int btexture, btimer; mobj_t *soundorg; } button_t;
static sector_t sectors[2];
static side_t sides[2];
static line_t lines[1];
static button_t buttonlist[MAXBUTTONS];
static vldoor_t doors[4];
static mobj_t actor;
static player_t inventory;
static int switchlist[] = {11, 12};
static int numswitches = 1, doorCount, used, grunt, gameaction, gamemode, hasMap31;
static boolean secretexit;

static void *Z_Malloc(size_t size, int tag, void *owner) {
    if (size != sizeof(vldoor_t) || tag != PU_LEVSPEC || owner || doorCount >= 4) abort();
    return &doors[doorCount++];
}
static void P_AddThinker(thinker_t *thinker) {}
static void T_VerticalDoor(vldoor_t *door) { abort(); }
static int P_FindLowestCeilingSurrounding(sector_t *sector) { return sectors[sector == &sectors[0] ? 1 : 0].ceilingheight; }
static int P_FindSectorFromLineTag(line_t *line, int previous) {
    for (int sector = previous + 1; sector < 2; sector++) if (sectors[sector].tag == line->tag) return sector;
    return -1;
}
static void I_Error(const char *message) { abort(); }
static void S_StartSound(mobj_t *origin, int sound) {
    if (sound == sfx_oof) {
        if (origin) abort();
        grunt = sound;
    }
}
static int W_CheckNumForName(const char *name) {
    if (strcmp(name, "map31") != 0) abort();
    return hasMap31 ? 1 : -1;
}
`;

const FIXTURES = String.raw`
static void setup(int special, int keys, int player, int secret, int busy, int texture, int tag,
    int commercialMap, int map31, int earlierSecret) {
    memset(buttonlist, 0, sizeof(buttonlist));
    memset(doors, 0, sizeof(doors));
    inventory = (player_t){0};
    for (int slot = 0; slot < 6; slot++) inventory.cards[slot] = (keys >> slot) & 1;
    actor = (mobj_t){.player = player ? &inventory : NULL, .type = player ? 0 : 11};
    sectors[0] = (sector_t){.ceilingheight = 128 * FRACUNIT};
    sectors[1] = (sector_t){.ceilingheight = 16 * FRACUNIT, .tag = 7};
    sides[0] = (side_t){.midtexture = texture ? 11 : 0, .sector = &sectors[0]};
    sides[1] = (side_t){.sector = &sectors[1]};
    lines[0] = (line_t){.special = special, .tag = tag, .flags = secret ? ML_SECRET : 0,
        .sidenum = {0, 1}, .frontsector = &sectors[0]};
    used = grunt = doorCount = 0;
    if (busy != 9) {
        doors[doorCount++] = (vldoor_t){.sector = &sectors[1], .type = normal, .direction = busy,
            .speed = VDOORSPEED, .topwait = VDOORWAIT, .topheight = 124 * FRACUNIT, .topcountdown = 27};
        sectors[1].specialdata = &doors[0];
    }
    gameaction = ga_nothing;
    gamemode = commercialMap ? commercial : shareware;
    hasMap31 = map31;
    secretexit = earlierSecret;
}

static void emit(void) {
    printf("{\"used\":%d,\"denied\":%d,\"grunt\":%d,\"special\":%d,\"switchOn\":%d,\"button\":%d,\"exit\":[%d,%d],\"doors\":[",
        used, inventory.message, grunt, lines[0].special, sides[0].midtexture == 12, buttonlist[0].btimer,
        gameaction == ga_completed, secretexit);
    for (int i = 0; i < doorCount; i++) {
        const vldoor_t *door = &doors[i];
        if (i) putchar(',');
        printf("[%td,%d,%d,%d,%d,%d,%d]", door->sector - sectors, door->type, door->direction,
            door->speed, door->topheight, door->topwait, door->topcountdown);
    }
    puts("]}");
}
`;
