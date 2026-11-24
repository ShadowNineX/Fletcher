// Shoot a barrel on either side of a real E1M1 exit. All geometry is generated.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { runNativeWeaponsOracle } from "./doom-native-weapons-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { cli: { type: "string" }, upstream: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-campaign-fight-"));
const unit = 65536, exitX = 5 * unit + 251, exitDelta = -2 * unit;

function run(program, args) {
    const out = spawnSync(program, args, { cwd: root, encoding: "utf8", timeout: 60000 });
    if (out.error) throw out.error;
    assert.equal(out.status, 0, out.stderr || out.stdout);
    return out.stdout;
}

function map(marker, barrelX, action) {
    function words(values) {
        const data = Buffer.alloc(2 * values.length);
        values.forEach((n, i) => data.writeUInt16LE(n & 65535, i * 2));
        return data;
    }
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128, 2);
    sector.writeInt16LE(160, 20);
    return [[marker, Buffer.alloc(0)], ["THINGS", words([0, 0, 0, 1, 7, barrelX, 0, 0, 2035, 7])],
        ["LINEDEFS", words([4, 5, 4, action, 0, 0, 0, ...edges.flatMap(([a, b]) => [a, b, 1, 0, 0, 0, -1])])],
        ["SIDEDEFS", Buffer.alloc(30)], ["VERTEXES", words([-224, -96, -224, 96, 224, 96, 224, -96, 48, 96, 48, -96])],
        ["SEGS", words(edges.flatMap(([a, b], i) => [a, b, [0x4000, 0, 0xc000, 0x8000][i], i + 1, 0, 0]))],
        ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)], ["SECTORS", sector], ["REJECT", Buffer.alloc(1)],
        ["BLOCKMAP", words([-256, -128, 4, 2, ...Array(8).fill(12), 0, 0, 1, 2, 3, 4, -1])]];
}

function fixtureWad() {
    const lumps = [...map("E1M1", 96, 11), ...map("E1M2", 112, 0)];
    const directory = 12 + lumps.reduce((sum, [, data]) => sum + data.length, 0);
    const wad = Buffer.alloc(directory + 16 * lumps.length);
    wad.write("PWAD");
    wad.writeUInt32LE(lumps.length, 4);
    wad.writeUInt32LE(directory, 8);
    let offset = 12;
    for (const [i, [name, data]] of lumps.entries()) {
        const entry = directory + 16 * i;
        wad.writeUInt32LE(offset, entry);
        wad.writeUInt32LE(data.length, entry + 4);
        wad.write(name, entry + 8);
        data.copy(wad, offset);
        offset += data.length;
    }
    return wad;
}

function preview() {
    const copy = path.join(scratch, "preview"), entry = path.join(copy, "main.flt");
    cpSync(path.join(port, "wad-bsp"), copy, { recursive: true });
    let source = readFileSync(entry, "utf8").replaceAll("\r\n", "\n");
    function before(anchor, insertion) {
        assert.equal(source.split(anchor).length, 2, "unique fixture anchor " + anchor);
        source = source.replace(anchor, insertion + "\n" + anchor);
    }
    if (!source.includes('import "actorinfo"')) before('import "play"', 'import "actorinfo"');
    before("                                    requestedTrack = previewLevelMusic(level.MapName)", `
                                    log("fight-spawn", (level.MapName.Low >> 24) - 48, random.GameplayIndex, armed.Random.GameplayIndex,
                                        armed.Inventory.Health, armed.Inventory.Ammo[play.AmmoClip], start.Health,
                                        initial.ViewHeight, initial.ViewHeightDelta, armed.View.Weapon.X, armed.View.Weapon.Y,
                                        armed.View.Weapon.State == actorinfo.WeaponAt(armed.Inventory.ReadyWeapon).Up,
                                        armed.View.Weapon.Tics, armed.View.Refire, armed.View.ExtraLight, armed.View.AttackDown, useDown, fire, use)`);
    before("                    next player = moved", `
                    barrel := actorFrame.Actors.ActorAt(1)
                    inv := frame.Contacts.Inventory
                    log("fight-tic", (base.MapName.Low >> 24) - 48, levelTime, gameTime, fire,
                        inv.Health, actorFrame.Actors.ActorAt(0).Health, inv.Ammo[play.AmmoClip],
                        barrel.Valid, barrel.Health, barrel.State, barrel.Tics, barrel.Physics.Body.X,
                        moved.Body.X, heldWeapon.Weapon.State, heldWeapon.Weapon.Tics, heldWeapon.Weapon.X, heldWeapon.Weapon.Y,
                        heldWeapon.Flash.State, heldWeapon.Flash.Tics, inv.ReadyWeapon, inv.PendingWeapon,
                        heldWeapon.AttackDown, heldWeapon.Refire, heldWeapon.ExtraLight, lighting.Random.GameplayIndex)
                    if used.ExitRequested { moved.ViewHeightDelta = ${exitDelta} }`);
    before("                        finished := play.FinishCampaignPlayer", `
                        heldWeapon.Weapon.X, heldWeapon.Refire, heldWeapon.ExtraLight = ${exitX}, 9, 2`);
    before("                    route := advanced.Route", `
                    log("fight-intermission", advanced.AttackDown, advanced.UseDown)`);
    writeFileSync(entry, source);
    writeFileSync(path.join(scratch, "LEVEL.WAD"), fixtureWad());
    const output = path.join(scratch, "fight.json");
    run("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output]);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
}

function tagged(sim, name) {
    return sim.logs.filter(([tag]) => tag === name).map(row => row.slice(1).map(Number));
}

function tics(sim) {
    return tagged(sim, "fight-tic").map(([map, tic, game, fire, hp, bodyHp, ammo, valid, barrelHp, barrelState, barrelTics, barrelX,
        x, weapon, weaponTics, wx, wy, flash, flashTics, ready, pending, down, refire, light, rng]) => ({
        map, tic, game, fire, hp, bodyHp, ammo, valid, barrelHp, barrelState, barrelTics, barrelX,
        x, weapon, weaponTics, wx, wy, flash, flashTics, ready, pending, down, refire, light, rng,
    }));
}

function drive(sim, keys, done, message) {
    for (let host = 0; host < 600 && !done(); host++) {
        sim.step([], new Map(), typeof keys === "function" ? keys(host) : keys);
    }
    assert.ok(done(), message + ": " + JSON.stringify(sim.logs.slice(-4)));
}

function fight(sim, map) {
    const last = () => tics(sim).at(-1);
    drive(sim, [], () => last()?.map === map && last().tic >= 17, "finish the pistol raise on map " + map);
    const before = last();
    assert.ok(before.barrelHp === 20 && before.valid);
    drive(sim, [18], () => last().barrelHp <= 0, "fire until the barrel dies on map " + map);
    drive(sim, [], () => last().hp < before.hp, "take real splash damage on map " + map);
    assert.ok(last().hp > 0 && last().ammo < before.ammo);
}

function exercise() {
    const sim = preview();
    fight(sim, 1);
    drive(sim, [23], () => tics(sim).at(-1).x > -8 * unit, "walk back into reach of the E1M1 exit");
    drive(sim, [6], () => sim.logs.some(([tag]) => tag === "Doom level exit requested"), "use E1M1's exit");
    drive(sim, host => host % 16 < 8 ? [] : [6], () => tagged(sim, "fight-intermission").length > 0,
        "advance the intermission with released F presses");
    const [[attackLatch, useLatch]] = tagged(sim, "fight-intermission");
    const oppositeKeys = [...(!attackLatch ? [18] : []), ...(!useLatch ? [6] : [])];
    drive(sim, oppositeKeys, () => tagged(sim, "fight-spawn").length === 2, "load E1M2 using opposite live buttons");
    fight(sim, 2);
    const snapshots = tics(sim);
    const [firstSpawn, secondSpawn] = tagged(sim, "fight-spawn");
    const traces = [1, 2].map(number => snapshots.filter(row => row.map === number));
    const exit = traces[0].at(-1);
    assert.deepEqual(firstSpawn.slice(0, 7), [1, 0, 3, 100, 50, 100, 41 * unit]);
    assert.deepEqual(secondSpawn, [2, exit.rng, (exit.rng + 3) & 255, exit.hp, exit.ammo, exit.hp,
        41 * unit, exitDelta, exitX, 122 * unit, 1, 1, 0, 0, attackLatch, useLatch, 1 - attackLatch, 1 - useLatch],
        "map setup carries the fight results and original view while resetting the pistol for its first raise");
    assert.ok(traces[1][0].game > exit.game && traces[1][0].tic === 0);
    for (const trace of traces) {
        trace.forEach((row, i) => {
            assert.equal(row.tic, i);
            assert.equal(row.game, trace[0].game + i);
            assert.equal(row.bodyHp, row.hp);
        });
        assert.ok(trace.some(row => row.barrelHp > 0 && row.barrelHp < 20), "the pistol wounds the barrel before the killing shot");
    }
    return { traces, spawns: [firstSpawn, secondSpawn] };
}

function compareWeapons(traces, spawns) {
    const cases = traces.map((trace, i) => ({
        weapon: 1, mode: 0, owned: [0, 1], seed: spawns[i][2], ammo: [spawns[i][4], 0, 0, 0],
        attackDown: spawns[i][14], bob: 0,
        ticks: trace.map(row => ({ attack: row.fire, select: -1, health: -1, dead: false, drop: false })),
    }));
    const native = runNativeWeaponsOracle(path.resolve(root, values.upstream), scratch, cases);
    for (const [i, trace] of traces.entries()) {
        const groups = [10, 11, 12, 13].map(tag => native[i].filter(row => row[0] === tag).slice(1));
        groups.forEach(group => assert.equal(group.length, trace.length));
        for (const [j, r] of trace.entries()) {
            const [gun, flash, inventory, ammo] = groups.map(group => group[j]);
            assert.deepEqual([r.weapon, r.weaponTics, r.flash, r.flashTics, r.ready, r.pending, r.down, r.refire, r.light, r.ammo],
                [gun[1], gun[2], flash[1], flash[2], ...inventory.slice(1, 6), ammo[2]], `native pistol frames on E1M${i + 1}, tic ${j}`);
        }
    }
}

function compareSpawnAndDamage(traces, spawn) {
    const read = name => readFileSync(path.resolve(root, values.upstream, name), "utf8").replaceAll("\r\n", "\n");
    const pspr = read("p_pspr.c"), mobj = read("p_mobj.c"), movement = read("movement-p_map.c");
    const up = read("info.c").split("\n").find(line => line.trimEnd().endsWith("// S_PISTOLUP"));
    assert.ok(up);
    const events = [];
    for (const trace of traces) {
        for (let i = 1; i < trace.length; i++) {
            const prev = trace[i - 1], now = trace[i];
            if (prev.ammo > now.ammo) {
                events.push({ call: `shot(${prev.rng},${Number(!now.refire)});`, damage: prev.barrelHp - now.barrelHp });
            }
            if (prev.hp > now.hp) {
                events.push({ call: `blast(${now.barrelX},${now.x});`, damage: prev.hp - now.hp });
            }
        }
    }
    assert.equal(events.length, 6, "four pistol hits and two barrel blasts");
    const source = path.join(scratch, "campaign.c"), exe = path.join(scratch, "campaign.exe");
    writeFileSync(source, `#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef enum { false, true } boolean;
typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef int statenum_t;
enum { FRACBITS=16, FRACUNIT=65536, VIEWHEIGHT=41*FRACUNIT, WEAPONBOTTOM=128*FRACUNIT, WEAPONTOP=32*FRACUNIT,
    RAISESPEED=6*FRACUNIT, NUMCARDS=6, NUMPSPRITES=2, ps_weapon=0, MT_PLAYER=0, MT_SPIDER=19, MT_CYBORG=21,
    MF_SHOOTABLE=4, MF_TRANSSHIFT=26, MISSILERANGE=2048*FRACUNIT, PST_LIVE=0, PST_REBORN=2,
    wp_pistol=1, wp_chainsaw=7, wp_nochange=10, S_PISTOLUP=1, SPR_PISG=0, sfx_sawup=10 };
#define ANG45 UINT32_C(0x20000000)
#define ONFLOORZ INT32_MIN
typedef struct { short x,y,angle,type; } mapthing_t;
typedef struct player_s player_t;
typedef struct psp_s pspdef_t;
typedef struct { int sprite,frame,tics; struct { void (*acp2)(player_t*,pspdef_t*); } action; int nextstate,misc1,misc2; } state_t;
struct psp_s { state_t *state; int tics; fixed_t sx,sy; };
typedef struct { player_t *player; int type,flags,health; fixed_t x,y,radius; angle_t angle; } mobj_t;
struct player_s {
    mobj_t *mo; const char *message;
    int health,playerstate,refire,damagecount,bonuscount,extralight,fixedcolormap,viewheight,deltaviewheight;
    int readyweapon,pendingweapon,attackdown,usedown,cards[NUMCARDS],ammo;
    pspdef_t psprites[NUMPSPRITES];
};
static void A_Raise(player_t *,pspdef_t *);
state_t states[] = {[S_PISTOLUP] = ${up.split("//")[0].trim()}};
static struct { int upstate,readystate; } weaponinfo[] = {[wp_pistol]={S_PISTOLUP,0}};
static boolean playeringame[4]={true};
static player_t players[4];
static mobj_t body,bomb,*bombspot=&bomb,*bombsource=&body;
static int deathmatch,consoleplayer,bombdamage=128,delivered;
static fixed_t bulletslope;
${read("light-m_random.c")}
// The player and barrels have clear sight in the open room.
// Sample original damage requests independently of Fletcher's HP updates.
static boolean P_CheckSight(mobj_t *a,mobj_t *b) { return true; }
static void P_DamageMobj(mobj_t *target,mobj_t *inflictor,mobj_t *source,int damage) { delivered=damage; }
static void P_LineAttack(mobj_t *m,angle_t a,fixed_t range,fixed_t slope,int damage) { delivered=damage; }
static mobj_t *P_SpawnMobj(fixed_t x,fixed_t y,fixed_t z,int kind) {
    assert(kind==MT_PLAYER && z==ONFLOORZ); body.x=x; body.y=y; return &body;
}
static void G_PlayerReborn(int player) { abort(); }
static void ST_Start(void) {}
static void HU_Start(void) {}
static void S_StartSound(mobj_t *m,int s) { abort(); }
${extractFunction(pspr, "void", "P_SetPsprite")}
${extractFunction(pspr, "void", "A_Raise")}
${extractFunction(pspr, "void", "P_BringUpWeapon")}
${extractFunction(pspr, "void", "P_SetupPsprites")}
${extractFunction(mobj, "void", "P_SpawnPlayer")}
${extractFunction(pspr, "void", "P_GunShot")}
${extractFunction(movement, "boolean", "PIT_RadiusAttack")}
static void shot(int seed,boolean accurate) { prndindex=seed; delivered=0; P_GunShot(&body,accurate); printf("%d\\n",delivered); }
static void blast(fixed_t barrelX,fixed_t playerX) {
    bomb.x=barrelX; body.x=playerX; body.flags=MF_SHOOTABLE; body.radius=16*FRACUNIT;
    delivered=0; PIT_RadiusAttack(&body); printf("%d\\n",delivered);
}
int main(void) {
    player_t *p=&players[0];
    p->health=${traces[0].at(-1).hp}; p->ammo=${traces[0].at(-1).ammo}; p->readyweapon=wp_pistol;
    p->refire=9; p->extralight=2; p->deltaviewheight=${exitDelta}; p->psprites[0].sx=${exitX};
    p->attackdown=${spawn[14]}; p->usedown=${spawn[15]};
    mapthing_t thing={.type=1};
    P_SpawnPlayer(&thing);
    pspdef_t w=p->psprites[ps_weapon];
    printf("[%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d]\\n",
        p->health,p->ammo,body.health,p->viewheight,p->deltaviewheight,w.sx,w.sy,w.state==&states[S_PISTOLUP],
        w.tics,p->refire,p->extralight,p->attackdown,p->usedown);
    ${events.map(event => event.call).join("\n    ")}
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    const [fresh, ...damage] = run(exe, []).trim().split(/\r?\n/);
    assert.deepEqual(spawn.slice(3, 16), JSON.parse(fresh), "E1M2 spawn and first raised pistol match native P_SpawnPlayer");
    assert.deepEqual(events.map(event => event.damage), damage.map(Number), "native pistol and barrel damage on both maps");
}

try {
    const { traces, spawns } = exercise();
    if (values.upstream) {
        compareWeapons(traces, spawns);
        compareSpawnAndDamage(traces, spawns[1]);
    }
    const digest = createHash("sha256").update(JSON.stringify(traces)).digest("hex");
    assert.equal(digest, "a85b15c1e19391c88b8dde2b5e5e384d6f158f1aa65a7b436c8d22b3e26c3048",
        "both maps retain the full per-tic actor, counter, weapon and random trace");
    console.log(`Campaign fights passed ${traces[0].length}/${traces[1].length} tics. SHA-256 ${digest}.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-campaign-fight-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
