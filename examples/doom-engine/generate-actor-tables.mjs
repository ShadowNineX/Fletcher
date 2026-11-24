// Generates actor tables from a local copy of the pinned Linux Doom release.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const input = path.resolve(process.argv[2] ?? path.join(here, "../../artifacts/doom-upstream"));
const output = path.resolve(process.argv[3] ?? path.join(here, "actorinfo/tables.flt"));
const read = name => readFileSync(path.join(input, name), "utf8").replaceAll("\r\n", "\n");
const info = read("info.c");
const header = read("info.h");
const mobj = read("p_mobj.h");
const sounds = read("sounds.h");
const items = read("d_items.c");

function fail(message) {
    throw new Error(`Doom actor table generation: ${message}`);
}

function withoutComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function enumValues(source, marker, prefix) {
    const markerIndex = source.indexOf(marker);
    const start = source.lastIndexOf("typedef enum", markerIndex);
    const end = source.indexOf("}", markerIndex);
    if (markerIndex < 0 || start < 0 || end < 0) fail(`missing enum for ${marker}`);
    const names = withoutComments(source.slice(start, markerIndex)).split(/[,\s]+/)
        .filter(token => token.startsWith(prefix));
    return new Map(names.map((name, index) => [name, index]));
}

function initializer(source, declaration) {
    const text = withoutComments(source);
    const match = text.match(declaration);
    if (!match) fail(`missing initializer for ${declaration}`);
    const start = text.indexOf("{", match.index + match[0].length);
    const end = text.indexOf("};", start);
    if (start < 0 || end < 0) fail(`malformed initializer for ${declaration}`);
    return text.slice(start + 1, end);
}

function records(source, declaration, fieldCount, rowCount) {
    const rows = [];
    let depth = 0;
    let start = 0;
    const text = initializer(source, declaration);
    for (let index = 0; index < text.length; index++) {
        if (text[index] === "{") {
            if (depth === 0) start = index + 1;
            depth++;
        } else if (text[index] === "}") {
            depth--;
            if (depth !== 0) continue;
            const row = text.slice(start, index).split(",").map(field => field.trim()).filter(Boolean);
            if (row.length !== fieldCount) fail(`row ${rows.length} of ${declaration} has ${row.length} fields`);
            rows.push(row);
        }
    }
    if (depth !== 0 || rows.length !== rowCount) fail(`expected ${rowCount} rows for ${declaration}, got ${rows.length}`);
    return rows;
}

const sprites = enumValues(header, "NUMSPRITES", "SPR_");
const states = enumValues(header, "NUMSTATES", "S_");
const kinds = enumValues(header, "NUMMOBJTYPES", "MT_");
const sampleSounds = enumValues(sounds, "NUMSFX", "sfx_");
const actionNames = [...new Set(Array.from(info.matchAll(/void\s+(A_[A-Za-z0-9_]+)\s*\(/g), match => match[1]))];
const actions = actionNames.map((name, index) => [name, index + 1]);
// Fletcher uses AmmoCount as its no-ammo sentinel.
const ammoTypes = ["am_clip", "am_shell", "am_cell", "am_misl", "am_noammo"];
const constants = new Map([["NULL", 0], ["FRACUNIT", 65536], ...sprites, ...states, ...kinds, ...sampleSounds, ...actions,
    ...ammoTypes.map((name, index) => [name, index])]);

function integer(token) {
    if (!/^(?:-?\d+|0x[0-9a-f]+)$/i.test(token)) fail(`unrecognized token ${token}`);
    return Number(token);
}

for (const [, name, value] of withoutComments(mobj).matchAll(/\b(MF_[A-Z]+)\s*=\s*([^,\n]+)/g)) {
    constants.set(name, integer(value.trim()));
}

function constantValue(raw) {
    const expression = raw.replace(/[{}]/g, "").replaceAll("(fixed_t)", "");
    let flags = 0;
    for (const term of expression.split("|")) {
        let product = 1;
        for (const token of term.split("*").map(part => part.trim())) {
            product *= constants.get(token) ?? integer(token);
        }
        flags |= product;
    }
    return flags;
}

const spriteNames = Array.from(initializer(info, /char\s*\*\s*sprnames\s*\[NUMSPRITES\]\s*=/)
    .matchAll(/"([A-Za-z0-9_]+)"/g), match => match[1]);
if (spriteNames.length !== sprites.size || spriteNames.some((name, index) => sprites.get("SPR_" + name) !== index)) {
    fail("sprite names do not match the sprite enum");
}
function packSpriteName(name) {
    return Array.from(name).reduce((packed, char, index) => packed | (char.charCodeAt(0) << 8 * index), 0);
}

const actorFields = [
    "DoomedNum", "SpawnState", "SpawnHealth", "SeeState", "SeeSound", "ReactionTime",
    "AttackSound", "PainState", "PainChance", "PainSound", "MeleeState", "MissileState",
    "DeathState", "XDeathState", "DeathSound", "Speed", "Radius", "Height", "Mass",
    "Damage", "ActiveSound", "RaiseState", "Flags",
];
const stateFields = ["Sprite", "Frame", "Tics", "Action", "Next", "Misc1", "Misc2"];
const weaponFields = ["Ammo", "Up", "Down", "Ready", "Attack", "Flash"];
const actorRows = records(info, /mobjinfo_t\s+mobjinfo\s*\[NUMMOBJTYPES\]\s*=/, actorFields.length, kinds.size);
const stateRows = records(info, /state_t\s+states\s*\[NUMSTATES\]\s*=/, stateFields.length, states.size);
const weaponRows = records(items, /weaponinfo_t\s+weaponinfo\s*\[NUMWEAPONS\]\s*=/, weaponFields.length, 9);
// The C struct places flags before raisestate.
const actorValues = actorRows.flatMap(row => [...row.slice(0, 21), row[22], row[21]].map(constantValue));
const stateValues = stateRows.flatMap(row => row.map(constantValue));
const weaponValues = weaponRows.flatMap(row => row.map(constantValue));
const stateBankRows = 512;
const stateBankSplit = stateBankRows * stateFields.length;

function renderArray(name, values) {
    const lines = [];
    for (let offset = 0; offset < values.length; offset += 16) {
        lines.push("    " + values.slice(offset, offset + 16).join(", ") + ",");
    }
    return `const ${name} = [${values.length}]int{\n${lines.join("\n")}\n}`;
}

function renderFields(fields) {
    return fields.map(field => `    ${field} ${field === "Flags" ? "bits<32>" : "int"}`).join("\n");
}

function renderRecord(type, fields, bank, indent) {
    return [
        `${indent}return ${type}{`,
        `${indent}    Valid: true,`,
        ...fields.map((field, index) => {
            const offset = index === 0 ? "offset" : `offset + ${index}`;
            const entry = `${bank}[${offset}]`;
            return `${indent}    ${field}: ${field === "Flags" ? `bits<32>(${entry})` : entry},`;
        }),
        `${indent}}`,
    ].join("\n");
}

const result = `// SPDX-License-Identifier: GPL-2.0-only
// Copyright (C) 1993-1996 id Software, Inc.
// Generated from id Software Linux Doom 1.10, commit a77dfb96cb91780ca334d0d4cfd86957558007e0.
// Source: info.c, info.h, p_mobj.h, sounds.h, d_items.c. Run generate-actor-tables.mjs to reproduce.

package actorinfo

const ActorPlayer = ${kinds.get("MT_PLAYER")}
const ActorSkull = ${kinds.get("MT_SKULL")}
const ActorSpider = ${kinds.get("MT_SPIDER")}
const ActorCyborg = ${kinds.get("MT_CYBORG")}
const ActorBarrel = ${kinds.get("MT_BARREL")}
const ActorBruiser = ${kinds.get("MT_BRUISER")}
const ActorKnight = ${kinds.get("MT_KNIGHT")}
const ActorVile = ${kinds.get("MT_VILE")}
const ActorVileFire = ${kinds.get("MT_FIRE")}
const ActorArachnotron = ${kinds.get("MT_BABY")}
const ActorMancubus = ${kinds.get("MT_FATSO")}
const ActorImp = ${kinds.get("MT_TROOP")}
const ActorDemon = ${kinds.get("MT_SERGEANT")}
const ActorSpectre = ${kinds.get("MT_SHADOWS")}
const ActorPainElemental = ${kinds.get("MT_PAIN")}
const ActorCacodemon = ${kinds.get("MT_HEAD")}
const ActorRevenant = ${kinds.get("MT_UNDEAD")}
const ActorBossEye = ${kinds.get("MT_BOSSSPIT")}
const ActorBossTarget = ${kinds.get("MT_BOSSTARGET")}
const ActorSpawnCube = ${kinds.get("MT_SPAWNSHOT")}
const ActorSpawnFire = ${kinds.get("MT_SPAWNFIRE")}
const ActorTeleportFog = ${kinds.get("MT_TFOG")}
const ActorTeleportTarget = ${kinds.get("MT_TELEPORTMAN")}
const ActorPossessed = ${kinds.get("MT_POSSESSED")}
const ActorShotGuy = ${kinds.get("MT_SHOTGUY")}
const ActorChainGuy = ${kinds.get("MT_CHAINGUY")}
const ActorWolfSS = ${kinds.get("MT_WOLFSS")}
const ActorClip = ${kinds.get("MT_CLIP")}
const ActorShotgun = ${kinds.get("MT_SHOTGUN")}
const ActorChaingun = ${kinds.get("MT_CHAINGUN")}
const ActorRocket = ${kinds.get("MT_ROCKET")}
const ActorPlasma = ${kinds.get("MT_PLASMA")}
const ActorBfg = ${kinds.get("MT_BFG")}
const ActorTroopShot = ${kinds.get("MT_TROOPSHOT")}
const ActorHeadShot = ${kinds.get("MT_HEADSHOT")}
const ActorBruiserShot = ${kinds.get("MT_BRUISERSHOT")}
const ActorArachPlasma = ${kinds.get("MT_ARACHPLAZ")}
const ActorExtraBfg = ${kinds.get("MT_EXTRABFG")}
const ActorTracer = ${kinds.get("MT_TRACER")}
const ActorSmoke = ${kinds.get("MT_SMOKE")}
const ActorFatShot = ${kinds.get("MT_FATSHOT")}
const ActorPuff = ${kinds.get("MT_PUFF")}
const ActorBlood = ${kinds.get("MT_BLOOD")}
const StatePuff3 = ${states.get("S_PUFF3")}
const StateBlood2 = ${states.get("S_BLOOD2")}
const StateBlood3 = ${states.get("S_BLOOD3")}
const StateVileHeal1 = ${states.get("S_VILE_HEAL1")}
const StateGibs = ${states.get("S_GIBS")}
const StateBrainExplode1 = ${states.get("S_BRAINEXPLODE1")}
const StatePlayerReady = ${states.get("S_PLAY")}
const StatePlayerRunFirst = ${states.get("S_PLAY_RUN1")}
const StatePlayerRunLast = ${states.get("S_PLAY_RUN4")}
const StatePlayerAttack1 = ${states.get("S_PLAY_ATK1")}
const StatePlayerAttack2 = ${states.get("S_PLAY_ATK2")}
const StateChainsaw = ${states.get("S_SAW")}
const StateChaingun1 = ${states.get("S_CHAIN1")}
const SoundPistol = ${sampleSounds.get("sfx_pistol")}
const SoundShotgun = ${sampleSounds.get("sfx_shotgn")}
const SoundSuperShotgun = ${sampleSounds.get("sfx_dshtgn")}
const SoundShotgunOpen = ${sampleSounds.get("sfx_dbopn")}
const SoundShotgunLoad = ${sampleSounds.get("sfx_dbload")}
const SoundShotgunClose = ${sampleSounds.get("sfx_dbcls")}
const SoundBfg = ${sampleSounds.get("sfx_bfg")}
const SoundSawUp = ${sampleSounds.get("sfx_sawup")}
const SoundSawIdle = ${sampleSounds.get("sfx_sawidl")}
const SoundSawMiss = ${sampleSounds.get("sfx_sawful")}
const SoundSawHit = ${sampleSounds.get("sfx_sawhit")}
const SoundPunch = ${sampleSounds.get("sfx_punch")}
const SoundSeeHuman = ${sampleSounds.get("sfx_posit1")}
const SoundSeeDemon = ${sampleSounds.get("sfx_bgsit1")}
const SoundPlayerDeath = ${sampleSounds.get("sfx_pldeth")}
const SoundPlayerHighDeath = ${sampleSounds.get("sfx_pdiehi")}
const SoundDeathHuman = ${sampleSounds.get("sfx_podth1")}
const SoundDeathDemon = ${sampleSounds.get("sfx_bgdth1")}
const SoundClaw = ${sampleSounds.get("sfx_claw")}
const SoundSkeletonSwing = ${sampleSounds.get("sfx_skeswg")}
const SoundSkeletonPunch = ${sampleSounds.get("sfx_skepch")}
const SoundMancubusAttack = ${sampleSounds.get("sfx_manatk")}
const SoundVileAttack = ${sampleSounds.get("sfx_vilatk")}
const SoundFireStart = ${sampleSounds.get("sfx_flamst")}
const SoundFireCrackle = ${sampleSounds.get("sfx_flame")}
const SoundBarrelExplosion = ${sampleSounds.get("sfx_barexp")}
const SoundSlop = ${sampleSounds.get("sfx_slop")}
const SoundBossAwake = ${sampleSounds.get("sfx_bossit")}
const SoundBossPain = ${sampleSounds.get("sfx_bospn")}
const SoundBossSpit = ${sampleSounds.get("sfx_bospit")}
const SoundBossCube = ${sampleSounds.get("sfx_boscub")}
const SoundBossDeath = ${sampleSounds.get("sfx_bosdth")}
const SoundTeleport = ${sampleSounds.get("sfx_telept")}
const SoundPlatformStart = ${sampleSounds.get("sfx_pstart")}
const SoundPlatformStop = ${sampleSounds.get("sfx_pstop")}
const SoundDoorOpen = ${sampleSounds.get("sfx_doropn")}
const SoundDoorClose = ${sampleSounds.get("sfx_dorcls")}
const SoundStoneMove = ${sampleSounds.get("sfx_stnmov")}
const SoundSwitch = ${sampleSounds.get("sfx_swtchn")}
const SoundSwitchExit = ${sampleSounds.get("sfx_swtchx")}
const SoundBlazeOpen = ${sampleSounds.get("sfx_bdopn")}
const SoundBlazeClose = ${sampleSounds.get("sfx_bdcls")}
const SoundOof = ${sampleSounds.get("sfx_oof")}
const SoundNoWay = ${sampleSounds.get("sfx_noway")}
const SoundArachnotronStep = ${sampleSounds.get("sfx_bspwlk")}
const SoundCyberdemonStep = ${sampleSounds.get("sfx_hoof")}
const SoundSpiderStep = ${sampleSounds.get("sfx_metal")}
const ActorKindCount = ${actorRows.length}
const ActorStateCount = ${stateRows.length}
const ActorFieldCount = ${actorFields.length}
const StateFieldCount = ${stateFields.length}
const StateFirstBankCount = ${stateBankRows}

type ActorDef struct {
    Valid bit
${renderFields(actorFields)}
}

type StateDef struct {
    Valid bit
${renderFields(stateFields)}
}

type WeaponDef struct {
    Valid bit
${renderFields(weaponFields)}
}

// Action 0 is NULL. Other IDs follow declaration order in info.c.
${actions.map(([name, id]) => `const Action${name.slice(2)} = ${id}`).join("\n")}

// Flat scalar constants are required by Fletcher's constant evaluator.
${renderArray("ActorValues", actorValues)}

${renderArray("StateValuesA", stateValues.slice(0, stateBankSplit))}

${renderArray("StateValuesB", stateValues.slice(stateBankSplit))}

${renderArray("WeaponValues", weaponValues)}

${renderArray("SpriteNames", spriteNames.map(packSpriteName))}

func KindForThing(number int) int {
    if number < 0 { return -1 }
    for i := range ActorKindCount {
        if ActorValues[i * ActorFieldCount] == number { return i }
    }
    return -1
}

func KindAt(kind int) ActorDef {
    if kind < 0 || kind >= ActorKindCount { return ActorDef{} }
    offset := kind * ActorFieldCount
${renderRecord("ActorDef", actorFields, "ActorValues", "    ")}
}

func StateAt(state int) StateDef {
    if state < 0 || state >= ActorStateCount { return StateDef{} }
    if state >= StateFirstBankCount {
        offset := (state - StateFirstBankCount) * StateFieldCount
${renderRecord("StateDef", stateFields, "StateValuesB", "        ")}
    }
    offset := state * StateFieldCount
${renderRecord("StateDef", stateFields, "StateValuesA", "    ")}
}

func WeaponAt(weapon int) WeaponDef {
    if weapon < 0 || weapon >= ${weaponRows.length} { return WeaponDef{} }
    offset := weapon * ${weaponFields.length}
${renderRecord("WeaponDef", weaponFields, "WeaponValues", "    ")}
}

func SpriteNameLow(sprite int) int {
    if sprite < 0 || sprite >= ${spriteNames.length} { return 0 }
    return SpriteNames[sprite]
}
`;

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, result);
console.log(`Generated ${actorRows.length} actors and ${stateRows.length} states in ${output}`);
