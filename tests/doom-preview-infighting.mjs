// The first blast target's synchronous A_Chase takes a gameplay random
// number before PIT_RadiusAttack visits the next monster in the same cell.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-infighting-"));
const unit = 65536;

function run(command, args) {
    const result = spawnSync(command, args, { cwd: scratch, encoding: "utf8", timeout: 60_000,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => bytes.writeUInt16LE(v & 65535, 2 * i));
    return bytes;
}

function room() {
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const angles = [0x4000, 0, 0xc000, 0x8000];
    const sector = Buffer.alloc(26);
    sector.writeUInt16LE(128, 2);
    sector.writeUInt16LE(160, 20);
    const things = words([-224, -96, 0, 1, 7, -192, 64, 0, 3004, 7, 105, 90, 0, 3001, 7,
        100, 20, 0, 3003, 7, 0, 0, 0, 2035, 7]);
    const lumps = [
        ["E1M1", Buffer.alloc(0)], ["THINGS", things],
        ["LINEDEFS", words(edges.flatMap(([a, b]) => [a, b, 1, 0, 0, 0, -1]))], ["SIDEDEFS", Buffer.alloc(30)],
        ["VERTEXES", words([-256, -128, -256, 128, 256, 128, 256, -128])],
        ["SEGS", words(edges.flatMap(([a, b], i) => [a, b, angles[i], i, 0, 0]))],
        ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)], ["SECTORS", sector], ["REJECT", Buffer.alloc(1)],
        ["BLOCKMAP", words([-256, -128, 4, 2, ...Array(8).fill(12), 0, 1, 2, 3, -1])],
    ];
    const directory = 12 + lumps.reduce((sum, [, bytes]) => sum + bytes.length, 0);
    const wad = Buffer.alloc(directory + 16 * lumps.length);
    wad.write("PWAD");
    wad.writeUInt32LE(lumps.length, 4);
    wad.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [i, [name, bytes]] of lumps.entries()) {
        const entry = directory + 16 * i;
        wad.writeUInt32LE(offset, entry);
        wad.writeUInt32LE(bytes.length, entry + 4);
        wad.write(name, entry + 8);
        bytes.copy(wad, offset);
        offset += bytes.length;
    }
    return wad;
}

function previewBattle() {
    const preview = path.join(scratch, "preview"), entry = path.join(preview, "main.flt");
    cpSync(path.join(port, "wad-bsp"), preview, { recursive: true });
    let source = readFileSync(entry, "utf8");
    function insertBefore(anchor, addition) {
        assert.equal(source.split(anchor).length, 2, "unique preview fixture anchor " + anchor);
        source = source.replace(anchor, addition + "\n" + anchor);
    }
    if (!source.includes('import "actorinfo"')) insertBefore('import "play"', 'import "actorinfo"');
    // All three living monsters get their ordinary thinker turns before
    // the barrel explodes. Only its damage callback can wake the first target.
    insertBefore("start := spawned.ActorAt(spawned.PlayerActors[0] - 1)", `
                            for i := range 3 {
                                monster := spawned.ActorAt(i + 1)
                                monster.Tics, monster.MoveDirection, monster.MoveCount = 10, enemy.ChaseWest, 3
                                spawned = spawned.WithActor(i + 2, monster)
                            }
                            barrel := spawned.ActorAt(4)
                            barrel = play.SetMobjState(barrel, actorinfo.KindAt(barrel.Kind).DeathState + 2).Actor
                            barrel.Target, barrel.Tics, barrel.Health, barrel.Damaged = 2, 1, 0, true
                            barrel.Physics.Body.Flags = barrel.Physics.Body.Flags & ~bits<32>(play.ActorShootable)
                            spawned = spawned.WithActor(5, barrel)`);
    insertBefore("next lightState = spawnedLights", "spawnedLights.Random.GameplayIndex = 3");
    insertBefore("next player = moved", `
                    baron := actorFrame.Actors.ActorAt(3)
                    imp := actorFrame.Actors.ActorAt(2)
                    barrel := actorFrame.Actors.ActorAt(4)
                    log("infighting", levelTime, barrel.State - actorinfo.KindAt(barrel.Kind).DeathState, barrel.Tics,
                        baron.Health, baron.Target, baron.Threshold, baron.MoveCount, baron.Physics.Body.X, baron.Physics.Body.Y,
                        baron.State == actorinfo.KindAt(baron.Kind).SeeState, baron.Tics,
                        imp.Health, imp.Target, imp.Threshold, imp.MoveCount, imp.Physics.Body.X, imp.Physics.Body.Y,
                        imp.State == actorinfo.KindAt(imp.Kind).PainState, imp.Tics, lighting.Random.GameplayIndex)`);
    writeFileSync(entry, source);
    writeFileSync(path.join(scratch, "LEVEL.WAD"), room());
    const output = path.join(scratch, "preview.json");
    run("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let host = 0; host < 400; host++) {
        sim.step();
        const row = sim.logs.find(row => row[0] === "infighting");
        if (row) return Array.from(row).slice(1).map(Number);
    }
    assert.fail("Preview did not commit a gameplay tic: " + JSON.stringify(sim.logs.slice(-8)));
}

function nativeBattle(upstream) {
    const read = name => readFileSync(path.resolve(root, upstream, name), "utf8").replaceAll("\r\n", "\n");
    const info = read("info.c"), enemy = read("p_enemy.c"), map = read("movement-p_map.c");
    const mapUtil = read("movement-p_maputl.c"), renderer = read("r_main.c");
    const infoHeader = read("info.h").replace(/^#include "d_think.h"$/m, "");
    const sounds = read("sounds.h").match(/typedef enum\s*\{\s*sfx_None,[\s\S]*?\}\s*sfxenum_t\s*;/)?.[0];
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    assert.ok(sounds && flags);
    const stateRows = ["S_BEXP4", "S_BOSS_RUN1", "S_TROO_RUN1", "S_TROO_PAIN"].map(name => {
        const row = info.split("\n").find(line => line.trimEnd().endsWith("// " + name));
        assert.ok(row, "missing native state " + name);
        return `[${name}] = ${row.split("//")[0].trim()}`;
    });
    const kindRows = ["MT_BARREL", "MT_BRUISER", "MT_TROOP", "MT_POSSESSED"].map(name => {
        const rows = info.match(new RegExp("\\{\\s*// " + name + "\\s*\\n[\\s\\S]*?^\\s*\\},", "m"));
        assert.ok(rows, "missing native type " + name);
        return `[${name}] = ${rows[0]}`;
    });
    const directions = enemy.match(/^fixed_t\s+[xy]speed\[8\].*$/gm);
    assert.equal(directions?.length, 2, "pinned P_Move direction tables");
    const table = read("tables.c").replace(/^#include.*$/gm, "").replace(/\brcsid\b/g, "tablesRcsid");
    const source = path.join(scratch, "infighting.c"), exe = path.join(scratch, "infighting.exe");
    writeFileSync(source, `#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef enum { false, true } boolean;
typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef struct mobj_s mobj_t;
typedef struct { void (*acp1)(mobj_t *); } actionf_t;
${infoHeader}
${sounds}
${flags}
#define ANG45 UINT32_C(0x20000000)
#define ANG90 UINT32_C(0x40000000)
#define ANG180 UINT32_C(0x80000000)
#define ANG270 UINT32_C(0xc0000000)
enum { FRACBITS=16, FRACUNIT=1<<16, FINEANGLES=8192, ANGLETOFINESHIFT=19, SLOPERANGE=2048,
    MAPBLOCKSHIFT=23, MAXRADIUS=32*FRACUNIT, MELEERANGE=64*FRACUNIT, FLOATSPEED=4*FRACUNIT, DI_NODIR=8,
    BASETHRESHOLD=100, wp_chainsaw=7, CF_GODMODE=2, pw_invulnerability=0, sk_baby=0, sk_nightmare=4 };
static void A_Chase(mobj_t *m);
static void A_Explode(mobj_t *m);
state_t states[NUMSTATES] = {
${stateRows.join("\n")}
};
mobjinfo_t mobjinfo[NUMMOBJTYPES] = {
${kindRows.join("\n")}
};
typedef struct { int special; } sector_t, line_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct { int readyweapon, cheats, powers[6], armorpoints, armortype, health, damagecount; mobj_t *attacker; } player_t;
struct mobj_s {
    mobjtype_t type;
    mobjinfo_t *info;
    fixed_t x,y,z,radius,floorz,momx,momy,momz;
    angle_t angle;
    int health, flags, sprite, frame, tics, reactiontime, threshold, movedir, movecount;
    state_t *state;
    mobj_t *target, *bnext;
    player_t *player;
    subsector_t *subsector;
};
static mobj_t shooter, baron, imp, barrel, *bombspot, *bombsource, *blocklinks[8];
static int bmapwidth=4, bmapheight=2, bmaporgx=-256*FRACUNIT, bmaporgy=-128*FRACUNIT;
static int bombdamage, gameskill=2, fastparm, netgame, consoleplayer, numspechit, floatok, tmfloorz;
static line_t *spechit[1];
static player_t players[4];
${table}
${read("light-m_random.c")}
static fixed_t viewx, viewy, *finecosine = &finesine[FINEANGLES/4];
${extractFunction(renderer, "angle_t", "R_PointToAngle")}
${extractFunction(renderer, "angle_t", "R_PointToAngle2")}
${extractFunction(read("m_fixed.c"), "fixed_t", "FixedMul")}
${extractFunction(mapUtil, "fixed_t", "P_AproxDistance")}
${extractFunction(mapUtil, "boolean", "P_BlockThingsIterator")}

// The room has no sight blockers. Relink successful steps at the head of the
// same spatial bucket, just as the live engine does during a radius callback.
static int cell(int x, int y) { return ((x-bmaporgx)>>23) + bmapwidth*((y-bmaporgy)>>23); }
static void linkActor(mobj_t *m) {
    int index=cell(m->x,m->y);
    m->bnext=blocklinks[index]; blocklinks[index]=m;
}
static boolean P_TryMove(mobj_t *m, fixed_t x, fixed_t y) {
    assert(m==&baron && x==92*FRACUNIT && y==20*FRACUNIT);
    mobj_t **item=&blocklinks[cell(m->x,m->y)];
    while (*item != m) { assert(*item); item=&(*item)->bnext; }
    *item=m->bnext; m->x=x; m->y=y; linkActor(m);
    return true;
}
static boolean P_CheckSight(mobj_t *a, mobj_t *b) { return true; }
static boolean P_CheckMissileRange(mobj_t *m) { abort(); }
static boolean P_LookForPlayers(mobj_t *m, boolean allaround) { abort(); }
static void P_NewChaseDir(mobj_t *m) { abort(); }
static boolean P_UseSpecialLine(mobj_t *m, line_t *l, int side) { abort(); }
static void S_StartSound(mobj_t *m, int sound) { abort(); }
static void P_RemoveMobj(mobj_t *m) { abort(); }
static void P_KillMobj(mobj_t *source, mobj_t *target) { abort(); }
static void I_Tactile(int a, int b, int c) { abort(); }
static void I_Error(const char *msg) { abort(); }
${extractFunction(read("p_mobj.c"), "boolean", "P_SetMobjState")}
${directions.join("\n")}
${extractFunction(enemy, "boolean", "P_Move")}
${extractFunction(enemy, "boolean", "P_CheckMeleeRange")}
${extractFunction(enemy, "void", "A_Chase")}
${extractFunction(read("p_inter.c"), "void", "P_DamageMobj")}
${extractFunction(map, "boolean", "PIT_RadiusAttack")}
${extractFunction(map, "void", "P_RadiusAttack")}
${extractFunction(enemy, "void", "A_Explode")}

static void place(mobj_t *m, int type, int x, int y) {
    mobjinfo_t *info=&mobjinfo[type];
    *m=(mobj_t){.type=type,.info=info,.flags=info->flags,.health=info->spawnhealth,.radius=info->radius,
        .x=x*FRACUNIT,.y=y*FRACUNIT,.movedir=4,.movecount=3,.reactiontime=8,.state=&states[info->spawnstate],.tics=9};
    linkActor(m);
}
int main(void) {
    place(&shooter,MT_POSSESSED,-192,64);
    place(&imp,MT_TROOP,105,90);
    place(&baron,MT_BRUISER,100,20);
    place(&barrel,MT_BARREL,0,0);
    barrel.flags &= ~MF_SHOOTABLE;
    barrel.health=0; barrel.target=&shooter; prndindex=3;
    P_SetMobjState(&barrel,S_BEXP4);
    printf("[0,%d,%d,", (int)(barrel.state-states)-S_BEXP,barrel.tics);
    printf("%d,%d,%d,%d,%d,%d,%d,%d,", baron.health,baron.target==&shooter?2:0,baron.threshold,baron.movecount,
        baron.x,baron.y,baron.state==&states[S_BOSS_RUN1],baron.tics);
    printf("%d,%d,%d,%d,%d,%d,%d,%d,%d]\\n", imp.health,imp.target==&shooter?2:0,imp.threshold,imp.movecount,
        imp.x,imp.y,imp.state==&states[S_TROO_PAIN],imp.tics,prndindex);
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    return JSON.parse(run(exe, []));
}

try {
    const native = values.upstream ? nativeBattle(values.upstream) : null;
    const preview = previewBattle();
    assert.deepEqual(preview, [0, 3, 10, 948, 2, 99, 2, 92 * unit, 20 * unit, 1, 3,
        17, 2, 100, 3, 105 * unit, 90 * unit, 1, 2, 6], "A_Chase runs before the radius iterator rolls for the Imp");
    if (native) assert.deepEqual(preview, native, "pinned radius damage and nested A_Chase");
    console.log("Preview infighting passed synchronous Baron chase, resumed Imp pain roll and gameplay RNG.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-infighting-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
