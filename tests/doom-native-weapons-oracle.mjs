// Compile the pinned psprite controller with attack execution replaced by trace hooks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function fixtureSource(fixture) {
    const { weapon, mode, ammo, owned, seed, attackDown, bob, ticks } = fixture;
    return `
    begin(${[weapon, mode, seed, Number(attackDown), bob, ...ammo, owned.reduce((mask, kind) => mask | 1 << kind, 0)]});
    ${ticks.map(({ attack, select, health, dead, drop }) =>
        `tick(${[Number(attack), select, health, Number(dead), Number(drop)]});`).join("\n    ")}
    puts("fixture");`;
}

function compileSource(upstreamDir, fixtures) {
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const pspr = read("p_pspr.c"), enemy = read("p_enemy.c"), info = read("info.c");
    const definitions = read("doomdef.h");
    const enumType = name => {
        const match = definitions.match(new RegExp(`typedef enum\\s*\\{[^{}]+\\}\\s*${name};`));
        assert.ok(match, name);
        return match[0];
    };
    const items = read("d_items.c").match(/weaponinfo_t\s+weaponinfo\[NUMWEAPONS\]\s*=\s*\{[\s\S]*?^\};/m);
    assert.ok(items);
    const header = read("info.h").replace(/^#include "d_think.h"$/m, "");
    const metadata = info.slice(info.indexOf("char *sprnames["), info.indexOf("mobjinfo_t mobjinfo["));
    assert.ok(metadata.startsWith("char *sprnames[") && !metadata.includes("mobjinfo_t"));
    const actions = [...new Set(Array.from(metadata.matchAll(/void\s+(A_[A-Za-z0-9_]+)\s*\(/g), match => match[1]))];
    const actionId = name => {
        const index = actions.indexOf(name);
        assert.ok(index >= 0, name);
        return index + 1;
    };
    const extract = (source, names) => names.map(name => extractFunction(source, "void", name)).join("\n");
    const normal = ["A_WeaponReady", "A_ReFire", "A_CheckReload", "A_Lower", "A_Raise", "A_GunFlash", "A_BFGsound",
        "A_Light0", "A_Light1", "A_Light2", "A_FireMissile", "A_FireBFG", "A_FirePlasma"];
    const reload = ["A_OpenShotgun2", "A_LoadShotgun2", "A_CloseShotgun2"];
    const bullets = ["A_FirePistol", "A_FireShotgun", "A_FireShotgun2", "A_FireCGun"];
    const handToHand = ["A_Punch", "A_Saw"];
    const called = new Set([...normal, ...reload, ...bullets, ...handToHand]);
    const unexpected = actions.filter(name => !called.has(name))
        .map(name => `void ${name}(void) { abort(); }`).join("\n");
    const bulletSources = bullets.map(name => {
        const source = extractFunction(pspr, "void", name);
        const aim = source.search(/^[\t ]*P_BulletSlope\s*\(/m);
        assert.ok(aim > 0, name);
        return source.slice(0, aim) + `    event(4, ${actionId(name)});\n}`;
    }).join("\n");
    const handSources = handToHand.map(name =>
        `void ${name}(player_t *player, pspdef_t *psp) { event(4, ${actionId(name)}); }`).join("\n");
    const tables = read("tables.c").replace(/^#include.*$/gm, "").replace(/\brcsid\b/g, "tablesRcsid");
    return [
        PREAMBLE, header, read("sounds.h"), enumType("weapontype_t"), enumType("ammotype_t"),
        STRUCTS, items[0], unexpected, metadata, read("light-m_random.c"), tables,
        "static fixed_t *finecosine = finesine + FINEANGLES / 4;",
        extractFunction(read("m_fixed.c"), "fixed_t", "FixedMul"),
        `
static void P_SpawnPlayerMissile(mobj_t *actor, mobjtype_t kind) {
    if (kind == MT_ROCKET) event(4, ${actionId("A_FireMissile")});
    else if (kind == MT_PLASMA) event(4, ${actionId("A_FirePlasma")});
    else if (kind == MT_BFG) event(4, ${actionId("A_FireBFG")});
    else abort();
}
`,
        extract(pspr, ["P_SetPsprite", "P_BringUpWeapon"]),
        extractFunction(pspr, "boolean", "P_CheckAmmo"),
        extract(pspr, ["P_FireWeapon", "P_DropWeapon", "P_SetupPsprites", "P_MovePsprites"]),
        extract(pspr, normal), extract(enemy, reload), bulletSources, handSources,
        FIXTURE_RUNNER, "int main(void) {", ...fixtures.map(fixtureSource), "return 0;\n}",
    ].join("\n");
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

export function runNativeWeaponsOracle(upstreamDir, scratch, fixtures) {
    const source = path.join(scratch, "weapons-oracle.c"), exe = path.join(scratch, "weapons-oracle.exe");
    writeFileSync(source, compileSource(upstreamDir, fixtures));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", "-fno-strict-aliasing", source, "-o", exe]);
    const groups = run(exe, []).trim().split(/\r?\nfixture(?:\r?\n|$)/).filter(Boolean);
    assert.equal(groups.length, fixtures.length);
    return groups.map(group => group.trim().split(/\r?\n/).map(row => row.split(",").map(Number)));
}

const PREAMBLE = `
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef int32_t fixed_t;
typedef uint32_t angle_t;
typedef enum { false, true } boolean;
typedef union { void (*acv)(void); void (*acp2)(void *, void *); } actionf_t;
#define FRACBITS 16
#define FRACUNIT (1 << FRACBITS)
#define FINEANGLES 8192
#define FINEMASK (FINEANGLES - 1)
#define SLOPERANGE 2048
#define BT_ATTACK 1
#define LOWERSPEED (6 * FRACUNIT)
#define RAISESPEED (6 * FRACUNIT)
#define WEAPONBOTTOM (128 * FRACUNIT)
#define WEAPONTOP (32 * FRACUNIT)
#define BFGCELLS 40
`;

const STRUCTS = `
typedef struct { state_t *state; int tics; fixed_t sx, sy; } pspdef_t;
typedef struct { state_t *state; } mobj_t;
typedef struct { ammotype_t ammo; statenum_t upstate, downstate, readystate, atkstate, flashstate; } weaponinfo_t;
enum { ps_weapon, ps_flash, NUMPSPRITES };
enum { shareware, registered, commercial };
enum { PST_LIVE, PST_DEAD };
typedef struct {
    mobj_t *mo;
    weapontype_t readyweapon, pendingweapon;
    int health, playerstate, refire, extralight;
    fixed_t bob;
    boolean attackdown, weaponowned[NUMWEAPONS];
    int ammo[NUMAMMO];
    struct { int buttons; } cmd;
    pspdef_t psprites[NUMPSPRITES];
} player_t;
static int gamemode, leveltime;
static mobj_t actor;
static player_t player;

static void event(int tag, int value) { printf("%d,%d\\n", tag, value); }
static void S_StartSound(void *origin, int sound) { event(1, sound); }
static void P_SetMobjState(mobj_t *actor, statenum_t state) { actor->state = states + state; event(2, state); }
static void P_NoiseAlert(mobj_t *target, mobj_t *emitter) { event(3, 0); }
`;

const FIXTURE_RUNNER = `
static void emit(void) {
    for (int slot = 0; slot < NUMPSPRITES; slot++) {
        pspdef_t psp = player.psprites[slot];
        printf("%d,%d,%d,%d,%d\\n", 10 + slot, psp.state ? (int)(psp.state - states) : 0, psp.tics, psp.sx, psp.sy);
    }
    printf("12,%d,%d,%d,%d,%d,%d\\n", player.readyweapon, player.pendingweapon, player.attackdown,
        player.refire, player.extralight, (int)(actor.state - states));
    printf("13,%d,%d,%d,%d,%d\\n", prndindex, player.ammo[0], player.ammo[1], player.ammo[2], player.ammo[3]);
}
static void begin(int weapon, int mode, int seed, int attackdown, int bob, int clip, int shell, int cell, int rocket, int owned) {
    gamemode = mode;
    leveltime = 0;
    prndindex = seed;
    actor = (mobj_t){states + S_PLAY};
    player = (player_t){ .mo = &actor, .readyweapon = weapon, .health = 100, .attackdown = attackdown,
        .bob = bob, .ammo = {clip, shell, cell, rocket} };
    for (int i = 0; i < NUMWEAPONS; i++) player.weaponowned[i] = (owned >> i) & 1;
    P_SetupPsprites(&player);
    emit();
}
static void tick(int attack, int select, int health, int dead, int drop) {
    player.cmd.buttons = attack ? BT_ATTACK : 0;
    if (select >= 0) player.pendingweapon = select;
    if (health >= 0) player.health = health;
    if (dead) player.playerstate = PST_DEAD;
    if (drop) P_DropWeapon(&player);
    else P_MovePsprites(&player);
    emit();
    leveltime++;
}
`;
