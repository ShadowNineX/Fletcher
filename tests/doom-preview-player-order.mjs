// Move the player across the edge of an exploding barrel's radius on the
// first gameplay tic of a generated E1M1. Only THINGS order differs.
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
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-player-order-"));
const unit = 65536;

function words(values) {
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => buffer.writeUInt16LE(value & 0xffff, i * 2));
    return buffer;
}

function room(playerFirst) {
    const player = [144, 0, 0, 1, 7], barrel = [0, 0, 0, 2035, 7];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const angles = [0x4000, 0, 0xc000, 0x8000];
    const sector = Buffer.alloc(26);
    sector.writeUInt16LE(128, 2);
    sector.writeUInt16LE(160, 20);
    const lumps = [
        ["E1M1", Buffer.alloc(0)], ["THINGS", words((playerFirst ? [player, barrel] : [barrel, player]).flat())],
        ["LINEDEFS", words(edges.flatMap(([a, b]) => [a, b, 1, 0, 0, 0, -1]))], ["SIDEDEFS", Buffer.alloc(30)],
        ["VERTEXES", words([-256, -128, -256, 128, 256, 128, 256, -128])],
        ["SEGS", words(edges.flatMap(([a, b], i) => [a, b, angles[i], i, 0, 0]))],
        ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)], ["SECTORS", sector], ["REJECT", Buffer.alloc(1)],
        ["BLOCKMAP", words([-256, -128, 4, 2, ...Array(8).fill(12), 0, 1, 2, 3, -1])],
    ];
    const directory = 12 + lumps.reduce((sum, [, data]) => sum + data.length, 0);
    const wad = Buffer.alloc(directory + lumps.length * 16);
    wad.write("PWAD");
    wad.writeUInt32LE(lumps.length, 4);
    wad.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [i, [name, data]] of lumps.entries()) {
        const entry = directory + i * 16;
        wad.writeUInt32LE(offset, entry);
        wad.writeUInt32LE(data.length, entry + 4);
        wad.write(name, entry + 8);
        data.copy(wad, offset);
        offset += data.length;
    }
    return wad;
}

function preparePreview() {
    const preview = path.join(scratch, "preview");
    cpSync(path.join(port, "wad-bsp"), preview, { recursive: true });
    const entry = path.join(preview, "main.flt");
    let source = readFileSync(entry, "utf8");
    function replace(anchor, replacement) {
        assert.equal(source.split(anchor).length, 2, "one fixture anchor: " + anchor);
        source = source.replace(anchor, replacement);
    }
    if (!source.includes('import "actorinfo"')) replace('import "play"', 'import "play"\nimport "actorinfo"');
    // Set only the initial momentum, barrel state and its active handle. Leave
    // player commands, body movement, damage dispatch and tic commits intact.
    const start = "start := spawned.ActorAt(spawned.PlayerActors[0] - 1)";
    replace(start, `playerHandle := spawned.PlayerActors[0]
                            barrelHandle := 3 - playerHandle
                            barrel := spawned.ActorAt(barrelHandle - 1)
                            barrel = play.SetMobjState(barrel, actorinfo.KindAt(barrel.Kind).DeathState + 2).Actor
                            barrel.Tics, barrel.Health, barrel.Damaged = 1, 0, true
                            barrel.Physics.Body.Flags = barrel.Physics.Body.Flags & ~bits<32>(play.ActorShootable)
                            spawned = spawned.WithActor(barrelHandle, barrel)
                            ${start}
                            start.Physics.MomentumX = -(8 << 16)
                            spawned = spawned.WithActor(playerHandle, start)`);
    replace("next firstActive = initialPreviewThinker(spawned)", "next firstActive = barrelHandle");
    const commit = "next player = moved";
    replace(commit, `playerHandle := actorFrame.Actors.PlayerActors[0]
                    body := actorFrame.Actors.ActorAt(playerHandle - 1)
                    barrel := actorFrame.Actors.ActorAt(3 - playerHandle - 1)
                    log("player-order", levelTime, playerHandle, barrel.State - actorinfo.KindAt(barrel.Kind).DeathState,
                        barrel.Tics, moved.Body.X, moved.Body.Y, body.Physics.Body.X, moved.MomentumX, moved.MomentumY,
                        frame.Contacts.Inventory.Health, body.Health, frame.Contacts.Inventory.DamageCount,
                        (lighting.Random.GameplayIndex - lightState.Random.GameplayIndex) & 255,
                        body.State == actorinfo.KindAt(body.Kind).PainState, body.Tics)
                    ${commit}`);
    writeFileSync(entry, source);
    return entry;
}

function firstTic(entry, playerFirst) {
    writeFileSync(path.join(scratch, "LEVEL.WAD"), room(playerFirst));
    const output = path.join(scratch, "player-order.json");
    const build = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    for (let host = 0; host < 400; host++) {
        sim.step();
        const tic = sim.logs.find(row => row[0] === "player-order");
        if (tic) return Array.from(tic).slice(1);
    }
    assert.fail("Preview did not commit its first gameplay tic: " + JSON.stringify(sim.logs.slice(-8)));
}

function nativeOrders(upstream) {
    const read = name => readFileSync(path.resolve(root, upstream, name), "utf8").replaceAll("\r\n", "\n");
    const tick = read("p_tick.c"), mobj = read("p_mobj.c"), map = read("movement-p_map.c");
    const info = read("info.c").split("\n");
    const states = ["S_PLAY", "S_BEXP3", "S_BEXP4"].map(name => {
        const row = info.find(line => line.trimEnd().endsWith("// " + name));
        assert.ok(row, "missing native state " + name);
        return `[${name}] = ${row.split("//")[0].trim()}`;
    });
    const source = path.join(scratch, "player-order.c"), exe = path.join(scratch, "player-order.exe");
    writeFileSync(source, `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef enum { false, true } boolean;
typedef int32_t fixed_t;
typedef void (*actionf_v)(void);
typedef struct thinker_s thinker_t;
struct thinker_s {
    thinker_t *prev, *next;
    union { actionf_v acv; void (*acp1)(thinker_t *); } function;
};
typedef struct mobj_s mobj_t;
typedef int statenum_t;
typedef struct {
    int sprite, frame, tics;
    struct { void (*acp1)(mobj_t *); } action;
    statenum_t nextstate;
    int misc1, misc2;
} state_t;
struct mobj_s {
    thinker_t thinker;
    fixed_t x, y, z, floorz, momx, momy, momz, radius;
    int flags, type, tics, sprite, frame, movecount;
    state_t *state;
    mobj_t *target, *bnext;
};
enum { FRACBITS = 16, FRACUNIT = 1 << 16, MAXRADIUS = 32 * FRACUNIT, MAPBLOCKSHIFT = 23 };
enum { MF_SHOOTABLE = 4, MF_COUNTKILL = 0x400000, MF_SKULLFLY = 0x1000000 };
enum { MT_PLAYER, MT_BARREL, MT_CYBORG, MT_SPIDER };
enum { S_NULL, S_PLAY, S_BEXP3, S_BEXP4, S_BEXP5 };
enum { SPR_PLAY, SPR_BEXP };
static void A_Explode(mobj_t *);
static state_t states[] = {
${states.join("\n")}
};
static thinker_t thinkercap;
static mobj_t player, barrel, *blocklinks[8], *bombspot, *bombsource;
static int bombdamage, delivered, respawnmonsters, leveltime;
static const int bmapwidth = 4, bmapheight = 2;
static const fixed_t bmaporgx = -256 * FRACUNIT, bmaporgy = -128 * FRACUNIT;

// The open sector has sight between these two objects. The prescribed move
// remains in block (3,1). Record delivered damage without running P_DamageMobj.
static boolean P_CheckSight(mobj_t *a, mobj_t *b) {
    if (a != &player || b != &barrel) abort();
    return true;
}
static void P_XYMovement(mobj_t *actor) { actor->x += actor->momx; }
static void P_DamageMobj(mobj_t *actor, mobj_t *origin, mobj_t *source, int amount) {
    if (actor != &player || origin != &barrel || source) abort();
    delivered += amount;
}
// These paths are unreachable for a single tic on a level floor.
static void Z_Free(void *p) { abort(); }
static void P_RemoveMobj(mobj_t *m) { abort(); }
static void P_ZMovement(mobj_t *m) { abort(); }
static int P_Random(void) { abort(); }
static void P_NightmareRespawn(mobj_t *m) { abort(); }

${extractFunction(tick, "void", "P_InitThinkers")}
${extractFunction(tick, "void", "P_AddThinker")}
${extractFunction(tick, "void", "P_RunThinkers")}
${extractFunction(read("movement-p_maputl.c"), "boolean", "P_BlockThingsIterator")}
${extractFunction(map, "boolean", "PIT_RadiusAttack")}
${extractFunction(map, "void", "P_RadiusAttack")}
${extractFunction(read("p_enemy.c"), "void", "A_Explode")}
${extractFunction(mobj, "boolean", "P_SetMobjState")}
${extractFunction(mobj, "void", "P_MobjThinker")}

static void tickActor(thinker_t *thinker) { P_MobjThinker((mobj_t *)thinker); }
int main(void) {
    for (int playerFirst = 0; playerFirst <= 1; ++playerFirst) {
        player = (mobj_t){.type = MT_PLAYER, .x = 144 * FRACUNIT, .momx = -8 * FRACUNIT,
            .radius = 16 * FRACUNIT, .flags = MF_SHOOTABLE, .state = &states[S_PLAY], .tics = -1};
        barrel = (mobj_t){.type = MT_BARREL, .radius = 10 * FRACUNIT, .state = &states[S_BEXP3], .tics = 1};
        player.thinker.function.acp1 = barrel.thinker.function.acp1 = tickActor;
        blocklinks[1 * bmapwidth + 3] = &player;
        blocklinks[1 * bmapwidth + 2] = &barrel;
        delivered = 0;
        P_InitThinkers();
        P_AddThinker(playerFirst ? &player.thinker : &barrel.thinker);
        P_AddThinker(playerFirst ? &barrel.thinker : &player.thinker);
        P_RunThinkers();
        if (barrel.state != &states[S_BEXP4]) abort();
        printf("[%d,%d,%d]\\n", player.x, delivered, barrel.tics);
    }
    return 0;
}`);
    function run(command, args) {
        const result = spawnSync(command, args, { cwd: scratch, encoding: "utf8", timeout: 30_000 });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stderr || result.stdout);
        return result.stdout;
    }
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => JSON.parse(line));
}

try {
    const entry = preparePreview();
    const barrelFirst = firstTic(entry, false);
    const playerFirst = firstTic(entry, true);
    // The player moves 144→136 in both cases. At x=144 the blast misses
    // exactly. At x=136, damage is 128 - (136 - player radius 16) = 8.
    const x = 136 * unit;
    const friction = -8 * 0xe800;
    assert.deepEqual(playerFirst, [0, 1, 3, 10, x, 0, x, friction + 65535, 25, 92, 92, 8, 1, true, 4],
        "player first moves into the blast before damage, pain RNG and thrust");
    assert.deepEqual(barrelFirst, [0, 2, 3, 10, x, 0, x, friction, 0, 100, 100, 0, 0, false, -1],
        "barrel first sees the player's stationary body outside the blast");
    console.log("Preview player-body order passed both THINGS orders, radius damage, motion, inventory and RNG.");
    if (values.upstream) {
        const preview = [barrelFirst, playerFirst].map(row => [row[4], 100 - row[10], row[3]]);
        assert.deepEqual(preview, nativeOrders(values.upstream), "native thinker order, player X, delivered damage and barrel tics");
        console.log("Pinned Doom thinkers, barrel state transition and radius attack matched both preview orders.");
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-player-order-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true });
}
