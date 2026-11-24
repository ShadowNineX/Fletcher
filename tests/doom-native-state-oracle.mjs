import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function sourceFor(upstream, stateTable, cases) {
    const read = file => readFileSync(path.join(upstream, file), "utf8").replaceAll("\r\n", "\n");
    const mobj = read("p_mobj.c");
    const random = read("light-m_random.c");
    const randomStart = random.indexOf("unsigned char rndtable[");
    assert.notEqual(randomStart, -1);
    const states = stateTable.map(([id, sprite, frame, tics, action, next]) =>
        `    [${id}] = {${sprite}, ${frame}, ${tics}, {${action ? "performAction" : "NULL"}}, ${next}},`).join("\n");
    const actions = stateTable.map(([id, , , , action]) => `    [${id}] = ${action},`).join("\n");
    const commands = cases.map(test => {
        const initial = `    beginCase(${test.initial.join(", ")}, ${test.actionMode}, ${Number(test.respawnMonsters)});`;
        const steps = test.commands.map(([op, value]) => `    step(${op === "set" ? "true" : "false"}, ${value});`);
        return [initial, ...steps].join("\n");
    }).join("\n");
    const tableSize = Math.max(...stateTable.map(([id]) => id)) + 1;

    return `#include <stdio.h>
#include <stdlib.h>

typedef enum { false, true } boolean;
typedef int statenum_t;
typedef struct mobj_s mobj_t;
typedef void (*actionf_v)(void);
typedef union { void (*acp1)(mobj_t *); actionf_v acv; } actionf_t;
typedef struct { int sprite, frame, tics; actionf_t action; int nextstate; } state_t;

struct mobj_s {
    state_t *state;
    int tics, sprite, frame, health, movecount, flags;
    int momx, momy, momz, z, floorz;
    struct { actionf_t function; } thinker;
};

enum { S_NULL = 0, MF_COUNTKILL = 0x400000, MF_SKULLFLY = 0x1000000 };
static mobj_t actor;
static int actionMode, leveltime;
static boolean alive, respawnRequested, respawnmonsters;
static void performAction(mobj_t *actor);
static state_t states[${tableSize}] = {
${states}
};
static const int actionCodes[${tableSize}] = {
${actions}
};

${random.slice(randomStart)}

static int stateId(const mobj_t *actor) {
    return actor->state ? (int) (actor->state - states) : S_NULL;
}

static void performAction(mobj_t *actor) {
    int id = actionCodes[stateId(actor)];
    printf("0,%d,%d,%d,%d,%d,%d,%d,%d\\n", id, stateId(actor), actor->tics,
        actor->sprite, actor->frame, actor->health, actor->movecount, prndindex);
    actor->health += id;
    if (id == 36 && actionMode == 1) actor->tics = 3;
    if (id == 36 && actionMode == 2) actor->state = &states[174];
}

static void P_RemoveMobj(mobj_t *actor) { (void) actor; alive = false; }
static void P_XYMovement(mobj_t *actor) { (void) actor; abort(); }
static void P_ZMovement(mobj_t *actor) { (void) actor; abort(); }
static void P_NightmareRespawn(mobj_t *actor) { (void) actor; respawnRequested = true; }

${extractFunction(mobj, "boolean", "P_SetMobjState")}

${extractFunction(mobj, "void", "P_MobjThinker")}

static void beginCase(int state, int tics, int health, int moves, int flags, int rng, int mode, boolean respawn) {
    actor = (mobj_t) {0};
    actor.state = &states[state];
    actor.tics = tics;
    actor.sprite = actor.state->sprite;
    actor.frame = actor.state->frame;
    actor.health = health;
    actor.movecount = moves;
    actor.flags = flags;
    prndindex = rng;
    actionMode = mode;
    respawnmonsters = respawn;
    alive = true;
}

static void step(boolean direct, int value) {
    respawnRequested = false;
    if (direct) {
        if (P_SetMobjState(&actor, value) != alive) abort();
    } else {
        leveltime = value;
        P_MobjThinker(&actor);
    }
    printf("1,%d,%d,%d,%d,%d,%d,%d,%d,%d\\n", stateId(&actor), actor.tics,
        actor.sprite, actor.frame, actor.health, actor.movecount, prndindex, alive, respawnRequested);
    puts("end");
}

int main(void) {
${commands}
    return 0;
}
`;
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 25000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

export function runNativeStateOracle(upstream, scratch, stateTable, cases) {
    const source = path.join(scratch, "state-oracle.c");
    const executable = path.join(scratch, "state-oracle.exe");
    writeFileSync(source, sourceFor(upstream, stateTable, cases));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", source, "-o", executable]);
    const commands = run(executable, []).trim().split(/\r?\nend(?:\r?\n|$)/).filter(Boolean);
    assert.equal(commands.length, cases.reduce((total, test) => total + test.commands.length, 0));
    let offset = 0;
    return cases.map(test => test.commands.map(() =>
        commands[offset++].split(/\r?\n/).map(row => row.split(",").map(Number))));
}
