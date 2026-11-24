// Exact Linux Doom 1.10 A_Look/P_LookForPlayers oracle with a bounded harness.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

const MAX_PLAYERS = 4;

function fixtureSource(fixture) {
    const players = fixture.players ?? [];
    assert.ok(players.length <= MAX_PLAYERS, "monster oracle player limit");
    const monster = fixture.monster ?? {};
    const source = ["reset();"];
    source.push(`seedMonster(${monster.x ?? 0}, ${monster.y ?? 0}, ${monster.angle ?? 0}, ${monster.flags ?? 0}, ${monster.threshold ?? 0}, ${monster.lastlook ?? 0}, ${monster.state ?? 0}, ${monster.seesound ?? 0}, ${monster.seestate ?? 1}, ${monster.type ?? monster.kind ?? 0}, ${monster.spawnstate ?? monster.state ?? 0});`);
    players.forEach((player, index) => {
        if (!player?.present) return;
        source.push(`seedPlayer(${index}, ${player.health ?? 100}, ${player.inGame === false ? 0 : 1}, ${player.sight === false ? 0 : 1}, ${player.x ?? 0}, ${player.y ?? 0}, ${player.radius ?? 0});`);
    });
    if (fixture.soundTarget != null) {
        assert.ok(Number.isInteger(fixture.soundTarget) && fixture.soundTarget >= 1 && fixture.soundTarget <= MAX_PLAYERS, "monster oracle sound target");
        source.push(`sector.soundtarget = &playerMobjs[${fixture.soundTarget - 1}];`);
    }
    source.push(`prndindex = ${fixture.rng ?? 0} & 255;`);
    if (fixture.chase) {
        const target = monster.target ?? 0;
        assert.ok(Number.isInteger(target) && target >= 0 && target <= MAX_PLAYERS, "chase target handle");
        if (target) source.push(`monster.target = &playerMobjs[${target - 1}];`);
        source.push(`seedChase(${monster.speed ?? 0}, ${monster.reaction ?? 0}, ${monster.moveDirection ?? 8}, ${monster.moveCount ?? 0}, ${monster.meleeState ?? 0}, ${monster.missileState ?? 0}, ${monster.attackSound ?? 0}, ${monster.activeSound ?? 0}, ${fixture.skill ?? 2}, ${fixture.fast ? 1 : 0}, ${fixture.moveAllowed === false ? 0 : 1});`);
        source.push("A_Chase(&monster);");
        source.push("emitChase();");
    } else {
        source.push("A_Look(&monster);");
        source.push("emit();");
    }
    source.push('puts("fixture");');
    return `{
    ${source.join("\n    ")}
}`;
}

function compileSource(upstreamDir, fixtures) {
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const enemy = read("p_enemy.c");
    const random = read("light-m_random.c");
    const angles = read("angle-oracle.c");
    const lookForPlayers = extractFunction(enemy, "boolean", "P_LookForPlayers");
    const look = extractFunction(enemy, "void", "A_Look");
    const meleeRange = extractFunction(enemy, "boolean", "P_CheckMeleeRange");
    const missileRange = extractFunction(enemy, "boolean", "P_CheckMissileRange");
    const chase = extractFunction(enemy, "void", "A_Chase");
    const randomTable = random.match(/unsigned char rndtable\[256\] = \{[\s\S]*?\n\};/);
    const angleTable = angles.match(/angle_t tantoangle\[2049\]\s*=\s*\{[\s\S]*?\n\};/);
    const randomFunction = extractFunction(random, "int", "P_Random");
    const slopeDiv = extractFunction(angles, "int", "SlopeDiv");
    const pointToAngle = extractFunction(angles, "angle_t", "R_PointToAngle");
    const pointToAngle2 = extractFunction(angles, "angle_t", "R_PointToAngle2");
    const sounds = read("sounds.h");
    const soundNames = sounds.match(/typedef enum\s*\{([\s\S]*?)NUMSFX/)[1].match(/sfx_[a-z0-9]+/gi);
    const soundValue = name => soundNames.indexOf(name);
    assert.ok(randomTable && angleTable && lookForPlayers.includes("lastlook") && look.includes("P_SetMobjState") && soundValue("sfx_posit1") >= 0, "pinned monster routines");
    const preamble = PREAMBLE.replaceAll("__SFX_POSIT1__", String(soundValue("sfx_posit1"))).replaceAll("__SFX_POSIT2__", String(soundValue("sfx_posit2"))).replaceAll("__SFX_POSIT3__", String(soundValue("sfx_posit3"))).replaceAll("__SFX_BGSIT1__", String(soundValue("sfx_bgsit1"))).replaceAll("__SFX_BGSIT2__", String(soundValue("sfx_bgsit2")));
    return [preamble, randomTable[0], "int prndindex;", randomFunction, angleTable[0], slopeDiv, pointToAngle, pointToAngle2, meleeRange, missileRange, lookForPlayers, look, chase, "int main(void) {", ...fixtures.map(fixtureSource), "return 0;\n}"].join("\n");
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

// Fixture: { monster:{x,y,angle,flags,threshold,lastlook,state,seesound,seestate,type},
// players:[{present,health,inGame,sight,x,y}], soundTarget, rng }. Coordinates are raw 16.16.
// Each result is [targetHandle,lastlook,threshold,state,rngIndex,sound]. A sight
// flag is deliberately an external P_CheckSight answer; the pinned routines still
// control player scan order, rear/close range rules, state, sound, and RNG use.
export function runNativeMonsterOracle(upstreamDir, scratch, fixtures) {
    const source = path.join(scratch, "monster-oracle.c");
    const executable = path.join(scratch, "monster-oracle.exe");
    writeFileSync(source, compileSource(upstreamDir, fixtures));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", executable]);
    const groups = run(executable, []).trim().split(/\r?\nfixture(?:\r?\n|$)/).filter(Boolean);
    assert.equal(groups.length, fixtures.length, "one native result per monster fixture");
    return groups.map(group => group.trim().split(",").map(Number));
}

// Chase fixtures set `chase:true` and use monster.target as a one-based player
// handle (zero means no target). Rows are [target,lastlook,threshold,state,rng,
// sound,reaction,angle,flags,moveCount,course], where course is 0 none, 1 a
// successful P_Move call, or 2 P_NewChaseDir.
export function runNativeChaseOracle(upstreamDir, scratch, fixtures) {
    const results = runNativeMonsterOracle(upstreamDir, scratch, fixtures.map(fixture => ({ ...fixture, chase: true })));
    return results;
}

const PREAMBLE = `
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef enum { false, true } boolean;
typedef struct mobj_s mobj_t;
typedef struct sector_s sector_t;
typedef struct subsector_s subsector_t;
typedef struct player_s player_t;
typedef struct mobjinfo_s mobjinfo_t;

struct subsector_s { sector_t *sector; };
struct sector_s { mobj_t *soundtarget; };
struct mobjinfo_s {
    int seesound, seestate, spawnstate;
    int meleestate, missilestate, attacksound, activesound;
    int radius, speed;
};
struct mobj_s {
    fixed_t x, y;
    angle_t angle;
    int flags, threshold, lastlook, type;
    mobj_t *target;
    subsector_t *subsector;
    mobjinfo_t *info;
    int health, reactiontime, movedir, movecount;
};
struct player_s { int health; mobj_t *mo; };

#define MF_SHOOTABLE 4
#define MF_AMBUSH 32
#define MF_JUSTHIT 64
#define MF_JUSTATTACKED 128
#define SLOPERANGE 2048
#define ANG90 UINT32_C(0x40000000)
#define ANG180 UINT32_C(0x80000000)
#define ANG270 UINT32_C(0xc0000000)
#define FRACUNIT 65536
#define MELEERANGE (64 * FRACUNIT)
#define MT_VILE 3
#define MT_UNDEAD 5
#define MT_SKULL 18
#define MT_SPIDER 19
#define MT_CYBORG 21
#define sk_nightmare 4
#define sfx_posit1 __SFX_POSIT1__
#define sfx_posit2 __SFX_POSIT2__
#define sfx_posit3 __SFX_POSIT3__
#define sfx_bgsit1 __SFX_BGSIT1__
#define sfx_bgsit2 __SFX_BGSIT2__

static player_t players[4];
static boolean playeringame[4];
static mobj_t playerMobjs[4];
static mobjinfo_t playerInfos[4];
static boolean playerSight[4];
static sector_t sector;
static subsector_t leaf;
static mobjinfo_t monsterInfo;
static mobj_t monster;
static int lastState;
static int lastSound;
static int lastSoundOrigin;
static fixed_t viewx, viewy;
static int gameskill;
enum { netgame = 0 };
static boolean fastparm;
static boolean moveAllowed;
static int chaseCourse;
extern int prndindex;

static int playerIndex(mobj_t *mo) {
    return mo >= playerMobjs && mo < playerMobjs + 4 ? (int)(mo - playerMobjs) : -1;
}
boolean P_CheckSight(mobj_t *actor, mobj_t *target) {
    (void)actor;
    int index = playerIndex(target);
    return index >= 0 ? playerSight[index] : true;
}
fixed_t P_AproxDistance(fixed_t dx, fixed_t dy) {
    dx = dx < 0 ? -dx : dx;
    dy = dy < 0 ? -dy : dy;
    return dx < dy ? dx + dy - (dx >> 1) : dx + dy - (dy >> 1);
}
void P_SetMobjState(mobj_t *actor, int state) { (void)actor; lastState = state; }
void S_StartSound(mobj_t *origin, int sound) { lastSound = sound; lastSoundOrigin = origin == &monster ? 1 : 0; }
boolean P_Move(mobj_t *actor) {
    (void)actor;
    if (moveAllowed) { chaseCourse = 1; return true; }
    return false;
}
void P_NewChaseDir(mobj_t *actor) { (void)actor; chaseCourse = 2; }

static void reset(void) {
    memset(players, 0, sizeof(players));
    memset(playeringame, 0, sizeof(playeringame));
    memset(playerMobjs, 0, sizeof(playerMobjs));
    memset(playerInfos, 0, sizeof(playerInfos));
    memset(playerSight, 0, sizeof(playerSight));
    memset(&sector, 0, sizeof(sector));
    memset(&monsterInfo, 0, sizeof(monsterInfo));
    memset(&monster, 0, sizeof(monster));
    leaf.sector = &sector;
    monster.subsector = &leaf;
    monster.info = &monsterInfo;
    lastState = 0;
    lastSound = 0;
    lastSoundOrigin = 0;
    gameskill = 2;
    fastparm = false;
    moveAllowed = false;
    chaseCourse = 0;
}
static void seedMonster(fixed_t x, fixed_t y, angle_t angle, int flags, int threshold, int lastlook, int state,
    int seesound, int seestate, int type, int spawnstate) {
    monster.x = x; monster.y = y; monster.angle = angle; monster.flags = flags;
    monster.threshold = threshold; monster.lastlook = lastlook; monster.type = type;
    monsterInfo.seesound = seesound; monsterInfo.seestate = seestate;
    monsterInfo.spawnstate = spawnstate; lastState = state;
}
static void seedPlayer(int index, int health, int ingame, int sight, fixed_t x, fixed_t y, int radius) {
    playeringame[index] = ingame;
    playerSight[index] = sight;
    players[index].health = health;
    players[index].mo = &playerMobjs[index];
    playerMobjs[index].x = x; playerMobjs[index].y = y;
    playerMobjs[index].health = health; playerMobjs[index].flags = MF_SHOOTABLE;
    playerMobjs[index].info = &playerInfos[index]; playerInfos[index].radius = radius;
}
static void emit(void) {
    int target = playerIndex(monster.target);
    printf("%d,%d,%d,%d,%d,%d,%d\\n", target < 0 ? 0 : target + 1, monster.lastlook, monster.threshold, lastState, prndindex, lastSound, lastSoundOrigin);
}
static void seedChase(int speed, int reaction, int direction, int moveCount, int meleeState, int missileState, int attackSound, int activeSound, int skill, int fast, int canMove) {
    monsterInfo.speed = speed;
    monsterInfo.meleestate = meleeState;
    monsterInfo.missilestate = missileState;
    monsterInfo.attacksound = attackSound;
    monsterInfo.activesound = activeSound;
    monster.reactiontime = reaction;
    monster.movedir = direction;
    monster.movecount = moveCount;
    gameskill = skill;
    fastparm = fast;
    moveAllowed = canMove;
}
static void emitChase(void) {
    int target = playerIndex(monster.target);
    printf("%d,%d,%d,%d,%d,%d,%d,%u,%d,%d,%d\\n", target < 0 ? 0 : target + 1, monster.lastlook, monster.threshold, lastState, prndindex, lastSound, monster.reactiontime, monster.angle, monster.flags, monster.movecount, chaseCourse);
}
`;
