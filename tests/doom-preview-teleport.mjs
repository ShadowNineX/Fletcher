// Drive the production preview through an original two-sector test map.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-teleport-"));
const unit = 65536;
const { values } = parseArgs({ options: { upstream: { type: "string" } } });

function words(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => bytes.writeUInt16LE(value & 65535, i * 2));
    return bytes;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((length, [, bytes]) => length + bytes.length, 0);
    const out = Buffer.alloc(directory + lumps.length * 16);
    out.write("PWAD");
    out.writeInt32LE(lumps.length, 4);
    out.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [i, [name, bytes]] of lumps.entries()) {
        const entry = directory + i * 16;
        out.writeInt32LE(offset, entry);
        out.writeInt32LE(bytes.length, entry + 4);
        out.write(name, entry + 8);
        bytes.copy(out, offset);
        offset += bytes.length;
    }
    return out;
}

function teleportMap() {
    const vertices = words([-128, -64, -128, 64, 0, 64, 0, -64, 256, 64, 256, -64]);
    const lines = words([
        2, 3, 4, 39, 7, 0, 1,
        0, 1, 0, 0, 0, 0, 65535, 1, 2, 0, 0, 0, 0, 65535, 3, 0, 0, 0, 0, 0, 65535,
        2, 4, 0, 0, 0, 1, 65535, 4, 5, 0, 0, 0, 1, 65535, 5, 3, 0, 0, 0, 1, 65535,
    ]);
    const sides = Buffer.alloc(60);
    sides.writeUInt16LE(1, 58);
    const segs = words([
        0, 1, 0x4000, 1, 0, 0, 1, 2, 0, 2, 0, 0, 2, 3, 0xc000, 0, 0, 0, 3, 0, 0x8000, 3, 0, 0,
        3, 2, 0x4000, 0, 1, 0, 2, 4, 0, 4, 0, 0, 4, 5, 0xc000, 5, 0, 0, 5, 3, 0x8000, 6, 0, 0,
    ]);
    const nodes = words([0, -64, 0, 128, 64, -64, 0, 256, 64, -64, -128, 0, 0x8001, 0x8000]);
    const sectors = Buffer.alloc(52);
    sectors.writeInt16LE(24, 26);
    sectors.writeInt16LE(7, 50);
    for (const offset of [0, 26]) {
        sectors.writeInt16LE(128, offset + 2);
        sectors.write("FLOOR0_1", offset + 4);
        sectors.write("CEIL1_1", offset + 12);
        sectors.writeInt16LE(160, offset + 20);
    }
    const block = words([-128, -128, 4, 2, ...Array(8).fill(12), 0, 1, 2, 3, 4, 5, 6, -1]);
    const things = words([-20, 0, 0, 1, 7, 150, 0, 180, 14, 7]);
    return [["MAP01", Buffer.alloc(0)], ["THINGS", things], ["LINEDEFS", lines], ["SIDEDEFS", sides], ["VERTEXES", vertices],
        ["SEGS", segs], ["SSECTORS", words([4, 0, 4, 4])], ["NODES", nodes], ["SECTORS", sectors],
        ["REJECT", Buffer.alloc(1)], ["BLOCKMAP", block]];
}

function buildPreview() {
    const preview = path.join(scratch, "preview");
    mkdirSync(preview);
    const original = path.join(port, "wad-bsp");
    for (const name of readdirSync(original).filter(name => name.endsWith(".flt"))) {
        let source = readFileSync(path.join(original, name), "utf8");
        if (name === "main.flt") {
            const insertion = "                    next player = moved";
            const actor = "playerActor := actors.ActorAt(contacts.Handle - 1)";
            assert.equal(source.split(insertion).length, 2);
            assert.equal(source.split(actor).length, 2);
            source = source.replace(actor, `${actor}
                if run && actor.Body.X == -20 * 65536 {
                    actor.Body.Z, actor.MomentumX = 32 << 16, 24 << 16
                    actor.ViewHeight, actor.ViewHeightDelta = 35 << 16, 1 << 16
                }`);
            source = source.replace('import "enemy"', 'import "enemy"\nimport "actorinfo"').replace(insertion, `
                    fog := 0
                    for index := range actorFrame.Actors.Count {
                        effect := actorFrame.Actors.ActorAt(index)
                        if effect.Valid && effect.Kind == actorinfo.ActorTeleportFog { fog = fog + 1 }
                    }
                    current := actorFrame.Actors.ActorAt(actorFrame.Actors.PlayerActors[0] - 1)
                    log("teleport-tic", levelTime, moved.Body.X, moved.Body.Y, moved.Body.Z, moved.Angle,
                        moved.ViewHeight, cameraZ, current.ReactionTime, used.Doors.UsedCount, fog, moved.ViewHeightDelta)
${insertion}`);
        }
        writeFileSync(path.join(preview, name), source);
    }
    const output = path.join(scratch, "preview.json");
    writeFileSync(path.join(scratch, "LEVEL.WAD"), wad(teleportMap()));
    const built = spawnSync("dotnet", [cli, "build", path.join(preview, "main.flt"), "--package-root", port,
        "--asset-root", scratch, "-o", output], { cwd: root, encoding: "utf8", timeout: 30000 });
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(encoded, "base64")[2], 1);
    return decode(encoded);
}

function nativeAirborneView(upstream) {
    const read = file => readFileSync(path.resolve(root, upstream, file), "utf8").replaceAll("\r\n", "\n");
    const user = read("p_user.c");
    const sine = read("tables.c").match(/int finesine\[\d+\]\s*=\s*\{[^}]+\};/)?.[0];
    assert.ok(sine, "pinned fine-angle table");
    const source = path.join(scratch, "teleport-view.c"), exe = path.join(scratch, "teleport-view.exe");
    writeFileSync(source, `#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
typedef int fixed_t;
typedef uint32_t angle_t;
typedef int weapontype_t;
enum { false, true, FRACBITS=16, FRACUNIT=65536, VIEWHEIGHT=41*FRACUNIT, FINEANGLES=8192, FINEMASK=8191,
    MAXBOB=0x100000, ANGLETOFINESHIFT=19, ANG90=0x40000000, PST_LIVE=0, PST_DEAD, S_PLAY=0, S_PLAY_RUN1,
    CF_NOCLIP=1, CF_NOMOMENTUM=4, MF_NOCLIP=0x1000, MF_JUSTATTACKED=0x80, MF_SHADOW=0x40000,
    BT_USE=2, BT_CHANGE=4, BT_WEAPONMASK=56, BT_WEAPONSHIFT=3, BT_SPECIAL=128, INVERSECOLORMAP=32 };
enum { wp_fist, wp_pistol, wp_shotgun, wp_chaingun, wp_missile, wp_plasma, wp_bfg, wp_chainsaw, wp_supershotgun };
enum { pw_invulnerability, pw_strength, pw_invisibility, pw_ironfeet, pw_allmap, pw_infrared };
enum { shareware, commercial };
typedef struct { int forwardmove, sidemove, angleturn, buttons; } ticcmd_t;
typedef struct { int special; } sector_t;
typedef struct { sector_t *sector; } subsector_t;
typedef struct { int momx,momy,z,floorz,ceilingz,flags,reactiontime,*state; angle_t angle; subsector_t *subsector; } mobj_t;
typedef struct { mobj_t *mo; ticcmd_t cmd; int cheats,playerstate,bob,viewheight,deltaviewheight,viewz;
    int weaponowned[9],powers[6],readyweapon,pendingweapon,usedown,damagecount,bonuscount,fixedcolormap; } player_t;
static int states[2], onground, leveltime, gamemode=commercial;
${sine}
static int *finecosine = finesine + FINEANGLES/4;
// The player is live with no buttons or sector special. Weapon overlays
// have no bearing on camera state. Guard every other out-of-scenario call.
static void P_MovePsprites(player_t *p) { (void)p; }
static void P_UseLines(player_t *p) { abort(); }
static void P_PlayerInSpecialSector(player_t *p) { abort(); }
static void P_DeathThink(player_t *p) { abort(); }
static void P_SetMobjState(mobj_t *m, int s) { abort(); }
${extractFunction(read("m_fixed.c"), "fixed_t", "FixedMul")}
${["P_Thrust", "P_MovePlayer", "P_CalcHeight", "P_PlayerThink"].map(name => extractFunction(user, "void", name)).join("\n")}
int main(void) {
    sector_t room = {0};
    subsector_t sub = {&room};
    mobj_t m = {.floorz=0, .z=32*FRACUNIT, .ceilingz=128*FRACUNIT, .momx=24*FRACUNIT, .subsector=&sub};
    player_t p = {.mo=&m, .viewheight=35*FRACUNIT, .deltaviewheight=FRACUNIT};
    for (leveltime=0; leveltime < 20; leveltime++) {
        P_PlayerThink(&p);
        if (leveltime==0) {
            // The production fixture crosses W1 here. Seed its documented
            // EV_Teleport result on this camera-only C side of the comparison.
            if (onground) abort();
            m.floorz=m.z=24*FRACUNIT; m.momx=0; m.reactiontime=18;
            p.viewz=m.z+p.viewheight;
        }
        printf("[%d,%d,%d,%d]\\n", m.reactiontime,p.viewheight,p.deltaviewheight,p.viewz);
    }
    return 0;
}`);
    const run = (program, args) => {
        const result = spawnSync(program, args, { encoding: "utf8", timeout: 30000 });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    };
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(JSON.parse);
}

function checkAirborneTeleport(tiles) {
    const sim = simulator(tiles, true);
    const step = (keys = []) => sim.step([], new Map(), keys);
    const rows = () => sim.logs.filter(([tag]) => tag === "teleport-tic");
    const until = (predicate, keys, label) => {
        for (let host = 0; host < 240 && !predicate(); host++) step(keys);
        assert.ok(predicate(), label);
    };
    until(() => rows().length > 0, [], "settle before the airborne entry");
    until(() => rows().some(row => row[8] === 18), [9], "airborne entry crosses the real teleporter");
    const arrival = rows().find(row => row[8] === 18);
    assert.deepEqual([arrival[2], arrival[4], arrival[9], arrival[10]], [150*unit, 24*unit, 1, 2],
        "the W1 line is consumed and both teleport fogs exist");
    until(() => rows().at(-1)[8] <= 15, [], "advance the teleport reaction timer");
    until(() => sim.logs.some(([tag]) => tag === "Doom checkpoint saved"), [25], "save during the airborne camera hold");
    const savedTic = rows().at(-1)[1];
    until(() => rows().at(-1)[1] >= arrival[1] + 19, [], "first command tic after the stun");
    const view = row => [row[8], row[6], row[11], row[7]];
    const first = rows().filter(row => row[1] >= arrival[1] && row[1] <= arrival[1]+19);
    assert.equal(first.length, 20);
    const expected = Array.from({length: 19}, (_, tic) => [18-tic,35*unit,unit,59*unit]);
    expected.push([0,36*unit,5*unit/4,60*unit]);
    assert.deepEqual(first.map(view), expected, "the airborne view resumes smoothing only after release");
    if (values.upstream) assert.deepEqual(first.map(view), nativeAirborneView(values.upstream), "retained onground matches P_PlayerThink");
    until(() => sim.logs.some(([tag]) => tag === "Doom checkpoint loaded"), [12], "restore after the first grounded command");
    const replayFrom = rows().length;
    until(() => rows().slice(replayFrom).some(row => row[1] >= arrival[1]+19), [], "replay through the next grounded command");
    const replay = rows().slice(replayFrom);
    assert.ok(replay[0][1] >= savedTic && replay[0][8] > 0, "rewound to a stunned tic");
    for (const row of replay) assert.deepEqual(view(row), expected[row[1]-arrival[1]], "restored camera at level tic " + row[1]);
}

try {
    const tiles = buildPreview(), sim = simulator(tiles, true);
    const rows = [];
    const impact = { x: -9, y: 63 };
    assert.equal(sim.tileAt(impact)?.type, 29, "impact cue uses a native Music Arrow");
    let lastImpact = 0, impactPulses = 0;
    let read = 0;
    const step = keys => {
        sim.step([], new Map(), keys);
        const signal = sim.value(impact) ?? 0;
        if (signal > 0 && lastImpact === 0) impactPulses++;
        lastImpact = signal;
        for (; read < sim.logs.length; read++) {
            const [type, tic, x, y, z, angle, viewHeight, eye, pause, used, fog] = sim.logs[read];
            if (type === "teleport-tic") rows.push({ tic, x, y, z, angle, viewHeight, eye, pause, used, fog });
            else assert.equal(type, "Classic WAD BSP frame rendered");
        }
    };
    for (let i = 0; i < 70; i++) step([]);
    assert.equal(rows.at(-1)?.x, -20 * unit, "view starts in the original room");
    assert.equal(impactPulses, 0, "the teleport cue is silent before the crossing");
    let arrival = -1;
    for (let i = 0; i < 240 && arrival < 0; i++) {
        step([23]); // W
        arrival = rows.findIndex(row => row.pause === 18);
    }
    assert.ok(arrival >= 0, `the player steps through the portal: ${JSON.stringify(rows.slice(-6))}`);
    const landed = rows[arrival];
    assert.deepEqual([landed.x, landed.y, landed.z, landed.angle, landed.used, landed.fog],
        [150 * unit, 0, 24 * unit, 0x80000000, 1, 2]);
    // While walking uphill toward the trigger, Doom has already started
    // easing the current view height toward its nominal standing value.
    assert.equal(landed.eye, landed.z + landed.viewHeight);
    for (let i = 0; i < 240 && rows.length <= arrival + 19; i++) step([23]);
    assert.ok(rows.length > arrival + 19, "observed 19 logical tics after landing");
    for (let delay = 1; delay <= 18; delay++) {
        const during = rows[arrival + delay];
        assert.equal(during.tic, landed.tic + delay);
        assert.deepEqual([during.x, during.y, during.angle, during.pause], [landed.x, landed.y, landed.angle, 18 - delay]);
    }
    assert.ok(rows[arrival + 19].x < landed.x, "holding W resumes movement west after the lock");
    assert.equal(impactPulses, 1, "the audible fog events produce the teleport cue during the crossing");
    checkAirborneTeleport(tiles);
    console.log("Airborne teleport and checkpoint replay preserved the camera through 18 stunned tics and resumed smoothing on release.");
    console.log("WAD preview teleport passed destination floor, heading, view, both fog actors, the native audio cue, one-shot consumption, and the full 18-tic lock.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-teleport-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
