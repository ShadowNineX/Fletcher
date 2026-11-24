// Compare the player-think command phase and the body thinker's result on every tic.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-player-run-"));
const unit = 65536;
const airTic = 4;
const schedule = [
    [1, [23], [25, 0, 0]], // W and E during reaction time, with a small existing drift.
    [1, [5], [0, 24, 0]],
    [1, [], [0, 0, 0]],
    [1, [4], [0, 0, -320]], // D turns without walking.
    [12, [23], [25, 0, 0]], // W begins in the air and stays down after landing.
    [48, [], [0, 0, 0]],
    [8, [5], [0, 24, 0]], // E starts the walk afresh through sidemove alone.
    [48, [], [0, 0, 0]],
];
const commands = schedule.flatMap(([tics, keys, cmd]) => Array.from({length: tics}, () => ({keys, cmd})));

function room() {
    function words(numbers) {
        const bytes = Buffer.alloc(numbers.length * 2);
        numbers.forEach((number, i) => bytes.writeUInt16LE(number & 65535, i * 2));
        return bytes;
    }
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]], angles = [0x4000, 0, 0xc000, 0x8000];
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128, 2);
    sector.writeInt16LE(160, 20);
    const lumps = [
        ["E1M1", Buffer.alloc(0)], ["THINGS", words([0, 0, 0, 1, 7])],
        ["LINEDEFS", words(edges.flatMap(([a,b]) => [a,b,1,0,0,0,-1]))], ["SIDEDEFS", Buffer.alloc(30)],
        ["VERTEXES", words([-128,-128, -128,128, 128,128, 128,-128])],
        ["SEGS", words(edges.flatMap(([a,b], i) => [a,b,angles[i],i,0,0]))], ["SSECTORS", words([4,0])],
        ["NODES", Buffer.alloc(0)], ["SECTORS", sector], ["REJECT", Buffer.alloc(1)],
        ["BLOCKMAP", words([-128,-128,2,2,8,8,8,8,0,1,2,3,-1])],
    ];
    const directory = 12 + lumps.reduce((sum, [, data]) => sum + data.length, 0);
    const result = Buffer.alloc(directory + 16 * lumps.length);
    result.write("PWAD");
    result.writeUInt32LE(lumps.length, 4);
    result.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [i, [name, data]] of lumps.entries()) {
        const entry = directory + i * 16;
        result.writeUInt32LE(offset, entry);
        result.writeUInt32LE(data.length, entry + 4);
        result.write(name, entry + 8);
        data.copy(result, offset);
        offset += data.length;
    }
    return result;
}

function run(program, args) {
    const proc = spawnSync(program, args, {cwd: root, encoding: "utf8", timeout: 60000});
    if (proc.error) throw proc.error;
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    return proc.stdout;
}

function preview() {
    const copy = path.join(scratch, "preview"), output = path.join(scratch, "run.json");
    cpSync(path.join(port, "wad-bsp"), copy, {recursive: true});
    const entry = path.join(copy, "main.flt");
    let source = readFileSync(entry, "utf8").replaceAll("\r\n", "\n");
    function after(anchor, insertion) {
        assert.equal(source.split(anchor).length, 2, "unique preview anchor " + anchor);
        source = source.replace(anchor, anchor + "\n" + insertion);
    }
    if (!source.includes('import "actorinfo"')) after('import "play"', 'import "actorinfo"');
    after("start := spawned.ActorAt(spawned.PlayerActors[0] - 1)", `
                            start.ReactionTime, start.Physics.MomentumX = 2, 2048
                            spawned = spawned.WithActor(spawned.PlayerActors[0], start)`);
    after("actor := player\n                playerActor := actors.ActorAt(contacts.Handle - 1)", `
                if levelTime == ${airTic} { actor.Body.Z = 8 << 16 }`);
    after("playerActor.Physics = actor", `
                log("run-command", levelTime, command.Forward, command.Side, command.Turn, playerActor.ReactionTime,
                    playerActor.State - actorinfo.StatePlayerReady, playerActor.Tics, actor.MomentumX, actor.MomentumY, actor.Angle)`);
    after("next player = moved", `
                    traced := actorFrame.Actors.ActorAt(actorFrame.Actors.PlayerActors[0] - 1)
                    log("run-body", levelTime, traced.State - actorinfo.StatePlayerReady, traced.Tics,
                        moved.Body.X, moved.Body.Y, moved.Body.Z, moved.MomentumX, moved.MomentumY, moved.MomentumZ)`);
    writeFileSync(entry, source);
    writeFileSync(path.join(scratch, "LEVEL.WAD"), room());
    run("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const rows = [];
    for (const [tic, { keys }] of commands.entries()) {
        const before = sim.logs.length;
        for (let host = 0; host < 150 && !sim.logs.slice(before).some(row => row[0] === "run-body"); host++) {
            sim.step([], new Map(), keys);
        }
        const row = tag => {
            const data = sim.logs.slice(before).filter(entry => entry[0] === tag);
            assert.equal(data.length, 1, tag + " on tic " + tic + ": " + JSON.stringify(sim.logs.slice(-4)));
            assert.equal(Number(data[0][1]), tic);
            return data[0].slice(2).map(Number);
        };
        const phase = row("run-command");
        phase[8] >>>= 0;
        rows.push([...phase, ...row("run-body")]);
    }
    return rows;
}

function native(upstream) {
    const read = name => readFileSync(path.resolve(root, upstream, name), "utf8").replaceAll("\r\n", "\n");
    const user = read("p_user.c"), mobj = read("p_mobj.c"), info = read("info.c").split("\n");
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    const sine = read("tables.c").match(/int finesine\[\d+\]\s*=\s*\{[^}]+\};/)?.[0];
    const reaction = extractFunction(user, "void", "P_PlayerThink")
        .match(/if\s*\(player->mo->reactiontime\)\s*player->mo->reactiontime--;\s*else\s*P_MovePlayer\s*\(player\);/)?.[0];
    assert.ok(flags && sine && reaction);
    const states = ["S_PLAY", "S_PLAY_RUN1", "S_PLAY_RUN2", "S_PLAY_RUN3", "S_PLAY_RUN4"].map(name => {
        const line = info.find(row => row.trimEnd().endsWith("// " + name));
        assert.ok(line);
        return `[${name}] = ${line.split("//")[0].trim()}`;
    });
    const source = path.join(scratch, "player-run.c"), exe = path.join(scratch, "player-run.exe");
    writeFileSync(source, `#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef enum { false, true } boolean;
typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef void (*actionf_v)(void);
typedef struct mobj_s mobj_t;
typedef struct { int forwardmove, sidemove, angleturn; } ticcmd_t;
typedef struct { mobj_t *mo; ticcmd_t cmd; int cheats, viewheight, deltaviewheight; } player_t;
typedef int statenum_t;
typedef struct { int sprite, frame, tics; struct { void (*acp1)(mobj_t*); } action; int nextstate, misc1, misc2; } state_t;
typedef struct { int ceilingpic, floorheight; } sector_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct { sector_t *backsector; } line_t;
typedef struct { int spawnstate; } mobjinfo_t;
struct mobj_s {
    struct { union { actionf_v acv; } function; } thinker;
    fixed_t x,y,z,momx,momy,momz,height,floorz,ceilingz;
    int flags,tics,sprite,frame,movecount,reactiontime;
    angle_t angle;
    state_t *state; player_t *player; mobj_t *target; subsector_t *subsector; mobjinfo_t *info;
};
${flags}
enum { S_NULL, S_PLAY, S_PLAY_RUN1, S_PLAY_RUN2, S_PLAY_RUN3, S_PLAY_RUN4 };
enum { SPR_PLAY, sfx_oof };
enum { FRACBITS=16, FRACUNIT=65536, ANGLETOFINESHIFT=19, CF_NOMOMENTUM=4,
    GRAVITY=FRACUNIT, VIEWHEIGHT=41*FRACUNIT, FLOATSPEED=4*FRACUNIT, MAXMOVE=30*FRACUNIT };
#define ANG90 UINT32_C(0x40000000)
${mobj.match(/^#define STOPSPEED[^\n]+/m)[0]}
${mobj.match(/^#define FRICTION[^\n]+/m)[0]}
static state_t states[] = { ${states.join("\n")} };
static int onground, skyflatnum, respawnmonsters, leveltime;
static line_t *ceilingline;
${sine}
static int *finecosine = finesine + 2048;
// The fixture stays inside this empty sector and never contacts a wall.
static boolean P_TryMove(mobj_t *m, fixed_t x, fixed_t y) {
    assert(abs(x)<112*FRACUNIT && abs(y)<112*FRACUNIT);
    m->x=x; m->y=y; return true;
}
static void P_RemoveMobj(mobj_t *m) { abort(); }
static void P_SlideMove(mobj_t *m) { abort(); }
static void P_ExplodeMissile(mobj_t *m) { abort(); }
static void P_NightmareRespawn(mobj_t *m) { abort(); }
static int P_Random(void) { abort(); }
static void S_StartSound(mobj_t *m, int s) { abort(); }
static fixed_t P_AproxDistance(fixed_t x, fixed_t y) { abort(); }
${extractFunction(read("m_fixed.c"), "fixed_t", "FixedMul")}
${extractFunction(mobj, "boolean", "P_SetMobjState")}
${extractFunction(user, "void", "P_Thrust")}
${extractFunction(user, "void", "P_MovePlayer")}
${["P_XYMovement","P_ZMovement","P_MobjThinker"].map(name => extractFunction(mobj, "void", name)).join("\n")}
int main(void) {
    ticcmd_t commands[] = {${commands.map(({cmd}) => "{" + cmd.join(",") + "}").join(",\n")}};
    mobj_t m = {.height=56*FRACUNIT, .ceilingz=128*FRACUNIT, .reactiontime=2, .momx=2048};
    player_t p = {.mo=&m}, *player=&p;
    m.player = player;
    P_SetMobjState(&m,S_PLAY);
    for (leveltime=0; leveltime<sizeof(commands)/sizeof(*commands); ++leveltime) {
        player->cmd=commands[leveltime];
        if (leveltime==${airTic}) m.z=8*FRACUNIT;
        ${reaction}
        printf("[%d,%d,%d,%d,%td,%d,%d,%d,%u,", p.cmd.forwardmove,p.cmd.sidemove,p.cmd.angleturn,
            m.reactiontime,m.state-states-S_PLAY,m.tics,m.momx,m.momy,m.angle);
        P_MobjThinker(&m);
        printf("%td,%d,%d,%d,%d,%d,%d,%d]\\n",m.state-states-S_PLAY,m.tics,m.x,m.y,m.z,m.momx,m.momy,m.momz);
    }
    return 0;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(line => JSON.parse(line));
}

try {
    const rows = preview();
    const tics = rows.map(([forward, side, turn, reaction, state, stateTics, mx, my, angle,
        bodyState, bodyTics, , , z, bodyMx, bodyMy]) => ({
        command: [forward, side, turn], reaction, state: [state, stateTics], mx, my, angle,
        bodyState: [bodyState, bodyTics], z, bodyMx, bodyMy,
    }));
    const ready = [0, -1];
    assert.deepEqual(tics.map(tic => tic.command), commands.map(({cmd}) => cmd));
    assert.deepEqual(tics.slice(0, 2).map(tic => [tic.reaction, tic.state, tic.mx, tic.my, tic.bodyMx]),
        [[1, ready, 2048, 0, 1856], [0, ready, 1856, 0, 1682]], "stunned W and E retain drift without starting a walk");
    assert.deepEqual([tics[3].state, tics[3].angle, tics[3].bodyState], [ready, (-320 << 16) >>> 0, ready], "turn alone stays ready");
    assert.deepEqual([tics[4].state, tics[4].mx, tics[4].my, tics[4].bodyState, tics[4].z],
        [[1, 4], 0, 0, [1, 3], 8 * unit], "airborne W starts running before the body counts down, without thrust");
    assert.deepEqual(tics[7].bodyState, [2, 4], "the body advances to the second walking frame");
    assert.ok(tics[15].bodyMx > 0, "holding W on the ground applies forward thrust");
    assert.deepEqual(tics[63].bodyState, ready, "friction settles the walk to ready");
    assert.deepEqual(tics[64].state, [1, 4], "sidemove starts RUN1 from ready");
    assert.ok(tics[64].bodyMy < 0, "sidemove applies sideways thrust");
    assert.deepEqual(tics.at(-1).bodyState, ready, "releasing sidemove settles again");
    if (values.upstream) {
        const expected = native(values.upstream);
        assert.equal(expected.length, rows.length);
        rows.forEach((row, i) => assert.deepEqual(row, expected[i], "native command and body phases at tic " + i));
    }
    const hash = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    assert.equal(hash, "7fbc6db8f32460e25bb9fbfd49c6dfa1b66387b29e18f16adc9f0af30430c69e",
        "the complete command and body trace matches the pinned native run");
    console.log(`Preview player run passed ${rows.length} command and body tics. SHA-256 ${hash}.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-player-run-[^/\\]+$/);
    rmSync(scratch, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
