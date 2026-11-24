import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

function compileSource(upstreamDir, cases) {
    const read = file => readFileSync(path.join(upstreamDir, file), "utf8").replaceAll("\r\n", "\n");
    const inter = read("p_inter.c"), info = read("info.h"), sounds = read("sounds.h");
    const spriteEnd = info.indexOf("spritenum_t;") + "spritenum_t;".length;
    const spriteEnum = info.slice(info.lastIndexOf("typedef enum", spriteEnd), spriteEnd);
    const flags = read("p_mobj.h").match(/typedef enum\s*\{[\s\S]*?\}\s*mobjflag_t;/)?.[0];
    assert.ok(spriteEnum.includes("NUMSPRITES") && flags?.includes("MF_COUNTITEM"));
    const messages = [...new Set([...inter.matchAll(/\bGOT[A-Z0-9]+\b/g)].map(match => match[0]))]
        .map((name, index) => `#define ${name} ((const char*)${index + 1})`).join("\n");
    const funcs = ["P_GiveAmmo", "P_GiveWeapon", "P_GiveBody", "P_GiveArmor", "P_GiveCard", "P_GivePower", "P_TouchSpecialThing"]
        .map(name => extractFunction(inter, name === "P_GiveCard" || name === "P_TouchSpecialThing" ? "void" : "boolean", name)).join("\n");
    const rows = cases.map(entry => {
        const touches = entry.touches.map(touch => `    touch(${touch.sprite}, ${touch.flags}, ${touch.z}, ${touch.height});`).join("\n");
        return `    reset(${entry.health}, ${entry.armor}, ${entry.armorType}, (int[]){${entry.ammo.join(",")}}, ${entry.ready}, ${entry.owned}, ${entry.skill}, ${Number(entry.commercial)});\n${touches}`;
    }).join("\n");
    return `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef int32_t fixed_t; typedef enum { false, true } boolean;
typedef enum { registered, commercial } gamemode_t; typedef enum { sk_baby, sk_easy, sk_medium, sk_hard, sk_nightmare } skill_t;
typedef enum { wp_fist,wp_pistol,wp_shotgun,wp_chaingun,wp_missile,wp_plasma,wp_bfg,wp_chainsaw,wp_supershotgun,wp_nochange } weapontype_t;
typedef enum { am_clip,am_shell,am_cell,am_misl,am_noammo } ammotype_t; typedef enum { pw_invulnerability,pw_strength,pw_invisibility,pw_ironfeet,pw_allmap,pw_infrared } powertype_t;
typedef enum { it_bluecard,it_yellowcard,it_redcard,it_blueskull,it_yellowskull,it_redskull } card_t;
typedef struct mobj_s mobj_t; typedef struct { int ammo; } weaponinfo_t; typedef struct player_s player_t;
typedef struct { int dummy; } state_t; struct mobj_s { int flags,sprite,health; fixed_t z,height; player_t *player; };
struct player_s { int health,armorpoints,armortype,readyweapon,pendingweapon,itemcount,bonuscount; int ammo[4],maxammo[4],powers[6]; boolean weaponowned[9],cards[6],backpack; mobj_t *mo; const char *message; };
${flags}
#define MAXHEALTH 100
#define BONUSADD 6
#define FRACUNIT 65536
#define NUMAMMO 4
static int clipammo[4] = {10,4,20,1};
#define INVULNTICS (30*35)
#define INVISTICS (60*35)
#define INFRATICS (120*35)
#define IRONTICS (60*35)
${messages}
${sounds}
${spriteEnum}
enum { netgame = 0, deathmatch = 0 };
static int gameskill, gamemode, consoleplayer; static player_t players[1]; static weaponinfo_t weaponinfo[9];
static mobj_t toucher;
static int removed, soundLast;
static void S_StartSound(mobj_t *origin,int sound){(void)origin;soundLast=sound;}
static void P_RemoveMobj(mobj_t *thing){(void)thing;removed=1;}
static void I_Error(const char *message,...){(void)message;abort();}
${funcs}
static void reset(int health, int armor, int armorType, const int *ammo, int ready, int owned, int skill,
        int commercialMode) {
    player_t *player = &players[0];
    toucher = (mobj_t){ .player = player, .health = health };
    *player = (player_t){ .mo = &toucher, .health = health, .armorpoints = armor, .armortype = armorType,
        .readyweapon = ready, .pendingweapon = ready, .maxammo = {200, 50, 300, 50} };
    memcpy(player->ammo, ammo, sizeof(player->ammo));
    for (int i = 0; i < 9; ++i) player->weaponowned[i] = (owned >> i) & 1;
    gameskill = skill;
    gamemode = commercialMode ? commercial : registered;
}
static int mask(const boolean *values, int length) {
    int result = 0;
    for (int index = 0; index < length; ++index) if (values[index]) result |= 1 << index;
    return result;
}
static void touch(int sprite, int flags, int z, int height) {
    mobj_t item = { .sprite = sprite, .flags = flags, .z = z };
    player_t *player = &players[0];
    toucher.height = height;
    removed = soundLast = 0;
    P_TouchSpecialThing(&item, &toucher);
    const int fields[] = {removed, soundLast, player->health, toucher.health, player->armorpoints, player->armortype,
        player->itemcount, player->bonuscount, player->readyweapon, player->pendingweapon, mask(player->weaponowned, 9),
        mask(player->cards, 6), player->backpack, toucher.flags, player->ammo[0], player->ammo[1], player->ammo[2], player->ammo[3],
        player->maxammo[0], player->maxammo[1], player->maxammo[2], player->maxammo[3],
        player->powers[0], player->powers[1], player->powers[2], player->powers[3], player->powers[4], player->powers[5]};
    putchar('[');
    for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); ++i) printf("%s%d", i ? "," : "", fields[i]);
    puts("]");
}

int main(void) {
    weaponinfo[wp_fist].ammo = am_noammo;
    weaponinfo[wp_pistol].ammo = am_clip;
    weaponinfo[wp_shotgun].ammo = am_shell;
    weaponinfo[wp_chaingun].ammo = am_clip;
    weaponinfo[wp_missile].ammo = am_misl;
    weaponinfo[wp_plasma].ammo = am_cell;
    weaponinfo[wp_bfg].ammo = am_cell;
    weaponinfo[wp_chainsaw].ammo = am_noammo;
    weaponinfo[wp_supershotgun].ammo = am_shell;
${rows}
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

export function runNativeInventoryOracle(upstreamDir, scratch, cases) {
    const source = path.join(scratch, "inventory-oracle.c");
    const exe = path.join(scratch, "inventory-oracle.exe");
    writeFileSync(source, compileSource(upstreamDir, cases));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    const rows = run(exe, []).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(rows.length, cases.reduce((total, entry) => total + entry.touches.length, 0));
    let offset = 0;
    return cases.map(entry => entry.touches.map(() => rows[offset++]));
}
