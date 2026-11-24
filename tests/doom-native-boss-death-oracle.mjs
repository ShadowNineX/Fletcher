// Exact Linux Doom 1.10 boss-death action oracle.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function caseSource(entry) {
    const players = entry.players ?? [100];
    const peers = entry.others ?? [];
    assert.ok(players.length <= 4 && peers.length <= 32, "boss oracle fixture limit");
    const action = entry.action === "boss" ? "A_BossDeath(&actor);" : entry.action === "keen" ? "A_KeenDie(&actor);" : entry.action === "brain" ? "A_BrainDie(&actor);" : null;
    assert.ok(action, "boss oracle action");
    const code = ["reset();", `gamemode=${entry.commercial ? 1 : 0};gameepisode=${entry.episode};gamemap=${entry.map};seed(&actor,${entry.actorKind},0,1);`];
    players.forEach((health, i) => { if (health != null) code.push(`playeringame[${i}]=1;players[${i}].health=${health};`); });
    peers.forEach((peer, i) => code.push(`seed(&others[${i}],${peer.kind},${peer.health},${peer.active === false ? 0 : 1});link(&others[${i}]);`));
    code.push("link(&actor);", action, "emit();puts(\"fixture\");");
    return `{${code.join("")}}`;
}

function compile(upstreamDir, cases) {
    const enemy = readFileSync(path.join(upstreamDir, "p_enemy.c"), "utf8").replaceAll("\r\n", "\n");
    const callbacks = ["A_Fall", "A_KeenDie", "A_BossDeath", "A_BrainDie"].map(name => extractFunction(enemy, "void", name));
    return [HEADER, ...callbacks, "int main(void) {", ...cases.map(caseSource), "return 0;\n}"].join("\n");
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

// Returns one [eventKind, tag, actorSolid] row per case. Event kinds: 0 none,
// 1 lowerFloorToLowest, 2 raiseToTexture, 3 doorOpen, 4 doorBlazeOpen, 5 exit.
export function runNativeBossDeathOracle(upstreamDir, scratch, cases) {
    const source = path.join(scratch, "boss-death-oracle.c"), executable = path.join(scratch, "boss-death-oracle.exe");
    writeFileSync(source, compile(upstreamDir, cases));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", executable]);
    const rows = run(executable, []).trim().split(/\r?\nfixture(?:\r?\n|$)/).filter(Boolean);
    assert.equal(rows.length, cases.length);
    return rows.map(row => row.trim().split(",").map(Number));
}

const HEADER = String.raw`
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
typedef enum { false, true } boolean;
typedef void (*actionf_p1)(void *);
typedef union { void (*acv)(void); actionf_p1 acp1; } actionf_t;
typedef struct thinker_s { struct thinker_s *next; actionf_t function; } thinker_t;
typedef struct { thinker_t thinker; int type, health, flags; } mobj_t;
typedef struct { int health; } player_t;
typedef struct { int tag; } line_t;
#define MAXPLAYERS 4
#define MF_SOLID 2
#define MT_BRUISER 15
#define MT_SPIDER 19
#define MT_BABY 20
#define MT_CYBORG 21
#define MT_FATSO 8
enum { shareware, commercial };
enum { lowerFloorToLowest, raiseToTexture };
enum { open, blazeOpen };
static int gamemode, gameepisode, gamemap, eventKind, eventTag;
static player_t players[4];
static boolean playeringame[4];
static thinker_t thinkercap;
static mobj_t actor, others[32];

void P_MobjThinker(void *mo) { abort(); }
int EV_DoFloor(line_t *line, int type) {
    eventKind = type == lowerFloorToLowest ? 1 : 2;
    eventTag = line->tag;
    return 1;
}
int EV_DoDoor(line_t *line, int type) {
    eventKind = type == open ? 3 : 4;
    eventTag = line->tag;
    return 1;
}
void G_ExitLevel(void) { eventKind = 5; }

static void reset(void) {
    memset(players, 0, sizeof(players));
    memset(playeringame, 0, sizeof(playeringame));
    thinkercap.next = &thinkercap;
    eventKind = eventTag = 0;
}
static void seed(mobj_t *mo, int type, int health, int active) {
    *mo = (mobj_t){.type = type, .health = health, .flags = MF_SOLID};
    if (active) mo->thinker.function.acp1 = (actionf_p1)P_MobjThinker;
}
static void link(mobj_t *mo) {
    thinker_t *tail = &thinkercap;
    while (tail->next != &thinkercap) tail = tail->next;
    tail->next = &mo->thinker;
    mo->thinker.next = &thinkercap;
}
static void emit(void) { printf("%d,%d,%d\n", eventKind, eventTag, (actor.flags & MF_SOLID) != 0); }
`;
