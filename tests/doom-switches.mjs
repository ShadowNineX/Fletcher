import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "doom-switches-"));

// Exact pinned alphSwitchList ordering and episode thresholds.
const pairs = [
    ["SW1BRCOM", 1], ["SW1BRN1", 1], ["SW1BRN2", 1], ["SW1BRNGN", 1], ["SW1BROWN", 1], ["SW1COMM", 1], ["SW1COMP", 1], ["SW1DIRT", 1], ["SW1EXIT", 1], ["SW1GRAY", 1], ["SW1GRAY1", 1], ["SW1METAL", 1], ["SW1PIPE", 1], ["SW1SLAD", 1], ["SW1STARG", 1], ["SW1STON1", 1], ["SW1STON2", 1], ["SW1STONE", 1], ["SW1STRTN", 1],
    ["SW1BLUE", 2], ["SW1CMT", 2], ["SW1GARG", 2], ["SW1GSTON", 2], ["SW1HOT", 2], ["SW1LION", 2], ["SW1SATYR", 2], ["SW1SKIN", 2], ["SW1VINE", 2], ["SW1WOOD", 2],
    ["SW1PANEL", 3], ["SW1ROCK", 3], ["SW1MET2", 3], ["SW1WDMET", 3], ["SW1BRIK", 3], ["SW1MOD1", 3], ["SW1ZIM", 3], ["SW1STON6", 3], ["SW1TEK", 3], ["SW1MARB", 3], ["SW1SKULL", 3],
];

function other(name) { return name.replace("SW1", "SW2"); }

function nameWords(value) {
    const bytes = Buffer.alloc(8);
    bytes.write(value);
    return [bytes.readUInt32LE(0), bytes.readUInt32LE(4)];
}

function textureDirectory(names) {
    const header = 4 + names.length * 4;
    const out = Buffer.alloc(header + names.length * 22);
    out.writeInt32LE(names.length);
    for (const [index, value] of names.entries()) {
        const offset = header + index * 22;
        out.writeInt32LE(offset, 4 + index * 4);
        out.write(value, offset, 8);
        out.writeInt16LE(1, offset + 12);
        out.writeInt16LE(1, offset + 14);
    }
    return out;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, data]) => size + data.length, 0);
    const out = Buffer.alloc(directory + lumps.length * 16);
    out.write("PWAD");
    out.writeInt32LE(lumps.length, 4);
    out.writeInt32LE(directory, 8);
    let offset = 12;
    for (const [index, [label, data]] of lumps.entries()) {
        const entry = directory + index * 16;
        out.writeInt32LE(offset, entry);
        out.writeInt32LE(data.length, entry + 4);
        out.write(label, entry + 8, 8);
        data.copy(out, offset);
        offset += data.length;
    }
    return out;
}

function literal(value) {
    const [low, high] = nameWords(value);
    return `wad.LumpName{Low: ${low}, High: ${high}}`;
}

function build(source) {
    const entry = path.join(scratch, "main.flt");
    const output = path.join(scratch, "output.json");
    writeFileSync(entry, source);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output], { encoding: "utf8", cwd: root, timeout: 15_000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return simulator(decode(JSON.parse(readFileSync(output, "utf8")).data));
}

function mountTextures(names) {
    writeFileSync(path.join(scratch, "SWITCHES.WAD"), wad([
        ["PNAMES", Buffer.alloc(4)], ["TEXTURE1", textureDirectory(["DUMMY", ...names])],
    ]));
}

function activationSoundTrace() {
    const lineSectors = [0, 1, 1, 2];
    const lines = Buffer.alloc(14 * lineSectors.length);
    const sides = Buffer.alloc(30 * lineSectors.length);
    for (const [index, sector] of lineSectors.entries()) {
        const offset = 14 * index;
        lines.writeUInt16LE(1, offset + 2);
        lines.writeUInt16LE(index === 2 ? 11 : 138, offset + 6);
        lines.writeUInt16LE(index, offset + 10);
        lines.writeUInt16LE(65535, offset + 12);
        sides.write("SW1BRCOM", 30 * index + 4);
        sides.writeUInt16LE(sector, 30 * index + 28);
    }
    writeFileSync(path.join(scratch, "ORIGINS.WAD"), wad([
        ["PNAMES", Buffer.alloc(4)], ["TEXTURE1", textureDirectory(["DUMMY", "SW1BRCOM", "SW2BRCOM"])],
        ["E1M1", Buffer.alloc(0)], ["THINGS", Buffer.alloc(0)], ["LINEDEFS", lines], ["SIDEDEFS", sides],
        ["VERTEXES", Buffer.from([0, 0, 0, 0, 64, 0, 0, 0])], ["SEGS", Buffer.alloc(0)],
        ["SSECTORS", Buffer.alloc(0)], ["NODES", Buffer.alloc(0)], ["SECTORS", Buffer.alloc(26 * 3)],
        ["REJECT", Buffer.alloc(0)], ["BLOCKMAP", Buffer.alloc(0)],
    ]));
    const sim = build(`package main
import "play"
import "wad"
const Data = readFile("ORIGINS.WAD")
map "Switch sound origins" {
    tick {
        level := wad.LoadMountedLevel(wad.OpenArchive(Data), ${literal("E1M1")})
        var specials play.LevelSpecials
        for index := range 4 {
            if index == 1 { specials.Doors = specials.Doors.TickButtonTimers(level) }
            if index == 3 {
                for range 34 { specials.Doors = specials.Doors.TickButtonTimers(level) }
            }
            specials.Doors = specials.Doors.ClearSounds()
            specials = play.UseActorLine(level, specials, index, false, true, play.PlayerInventory{}).State
            sound := specials.Doors.Sounds.At(0)
            log(sound.Id, sound.Sector)
        }
    }
}`);
    sim.step();
    return sim.logs.map(row => Array.from(row));
}

function nativeTrace(switchPath, specPath) {
    const switches = readFileSync(path.resolve(root, switchPath), "utf8").replaceAll("\r\n", "\n");
    const specials = readFileSync(path.resolve(root, specPath), "utf8").replaceAll("\r\n", "\n");
    const from = switches.indexOf("switchlist_t alphSwitchList[]");
    const to = switches.indexOf("\n//\n// P_UseSpecialLine", from);
    const update = specials.indexOf("DO BUTTONS");
    const loop = specials.indexOf("for (i = 0;", update);
    const end = specials.indexOf("\n}", loop);
    assert.ok(from >= 0 && to > from && update >= 0 && loop > update && end > loop, "locate the pinned upstream functions");
    const definitions = [...switches.slice(from, to).matchAll(/\{\s*"([^"]+)",\s*"([^"]+)",\s*([123])\s*\}/g)];
    assert.deepEqual(definitions.map(([, first, second, episode]) => [first, second, Number(episode)]),
        pairs.map(([first, episode]) => [first, other(first), episode]));
    const source = path.join(scratch, "switch-native.c");
    const exe = path.join(scratch, process.platform === "win32" ? "switch-native.exe" : "switch-native");
    writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { MAXSWITCHES = 50, MAXBUTTONS = 16, BUTTONTIME = 35 };
typedef enum { top, middle, bottom } bwhere_e;
typedef struct { char name1[9], name2[9]; int episode; } switchlist_t;
typedef struct { int soundorg; } mobj_t;
typedef struct { mobj_t soundorg; } sector_t;
typedef struct { int toptexture, midtexture, bottomtexture; } side_t;
typedef struct { int special, sidenum[2]; sector_t *frontsector; } line_t;
typedef struct { line_t *line; bwhere_e where; int btexture, btimer; mobj_t *soundorg; } button_t;
enum { shareware, registered, commercial, retail } gamemode;
enum { sfx_swtchn = 23, sfx_swtchx = 24 };
static side_t sides[1280];
static int R_TextureNumForName(const char *name);
static mobj_t *soundOrigin;
static int soundId;
static void S_StartSound(mobj_t *origin, int sound) { soundOrigin = origin; soundId = sound; }
static void I_Error(const char *message) { fprintf(stderr, "%s\\n", message); exit(1); }

${switches.slice(from, to)}

static int R_TextureNumForName(const char *name) {
    for (int i = 0; alphSwitchList[i].episode; ++i) {
        if (!strcmp(name, alphSwitchList[i].name1)) return 2 * i + 1;
        if (!strcmp(name, alphSwitchList[i].name2)) return 2 * i + 2;
    }
    return 0;
}

static void updateButtons(void) {
    int i;
    ${specials.slice(loop, end)}
}

static void row(int tic) {
    printf("%d %d %d %d\\n", tic, sides[0].toptexture, sides[0].midtexture, buttonlist[0].btimer);
}

static void overflowRow(void) {
    int active = 0;
    for (int i = 0; i < MAXBUTTONS; ++i) active += buttonlist[i].btimer != 0;
    printf("%d %d %d %d\\n", active, buttonlist[0].btimer, sides[0].toptexture, sides[16].toptexture);
}

int main(int argc, char **argv) {
    if (argc > 1) {
        gamemode = shareware;
        P_InitSwitchList();
        if (!strcmp(argv[1], "origins")) {
            sector_t sectors[3] = {0};
            int lineSectors[] = {0, 1, 1, 2};
            line_t lines[4] = {0};
            for (int i = 0; i < 4; ++i) {
                if (i == 1) updateButtons();
                if (i == 3) for (int tic = 0; tic < BUTTONTIME - 1; ++tic) updateButtons();
                lines[i] = (line_t){i == 2 ? 11 : 138, {i, -1}, &sectors[lineSectors[i]]};
                sides[i].toptexture = 1;
                P_ChangeSwitchTexture(&lines[i], i != 2);
                int origin = -1;
                for (int j = 0; j < 3; ++j) if (soundOrigin == &sectors[j].soundorg) origin = j;
                printf("%d %d\\n", soundId, origin);
            }
            return 0;
        }
        sector_t sector = {0};
        line_t lines[17] = {0};
        if (!strcmp(argv[1], "overflow")) {
            for (int i = 0; i <= MAXBUTTONS; ++i) {
                lines[i] = (line_t){61, {i, -1}, &sector};
                sides[i].toptexture = 1;
                if (i < MAXBUTTONS) P_ChangeSwitchTexture(&lines[i], 1);
            }
            P_ChangeSwitchTexture(&lines[0], 1);
            overflowRow();
            atexit(overflowRow);
            P_ChangeSwitchTexture(&lines[16], 1);
            return 0;
        }
        for (int i = 0; i < 64; ++i) {
            int side = 1024 + 4 * i;
            sides[side] = (side_t){1, 1, 1};
            lines[0] = (line_t){11, {side, -1}, &sector};
            for (int tier = 0; tier < 3; ++tier) P_ChangeSwitchTexture(&lines[0], 0);
        }
        for (int i = 0; i < 64; ++i) {
            side_t side = sides[1024 + 4 * i];
            printf("%d %d %d %d\\n", i, side.toptexture, side.midtexture, side.bottomtexture);
        }
        lines[1] = lines[0];
        P_ChangeSwitchTexture(&lines[0], 1);
        P_ChangeSwitchTexture(&lines[1], 1);
        for (int tic = 1; tic <= BUTTONTIME; ++tic) {
            updateButtons();
            if (tic >= BUTTONTIME - 1) {
                printf("%d %d %d %d\\n", tic, sides[1276].toptexture, buttonlist[0].btimer, buttonlist[1].btimer);
            }
        }
        return 0;
    }
    for (int mode = shareware; mode <= retail; ++mode) {
        gamemode = mode;
        P_InitSwitchList();
        printf("%d %d\\n", mode, numswitches);
    }
    gamemode = shareware;
    P_InitSwitchList();
    sector_t sector = {0};
    line_t line = {61, {0, -1}, &sector};
    sides[0] = (side_t){2, 1, 0};
    P_ChangeSwitchTexture(&line, 1);
    row(0);
    for (int tic = 1; tic <= BUTTONTIME; ++tic) {
        if (tic == 10) P_ChangeSwitchTexture(&line, 1);
        updateButtons();
        if (tic == 1 || tic == 10 || tic == 34 || tic == 35) row(tic);
    }
}
`);
    const compile = spawnSync("gcc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", exe], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
    const run = spawnSync(exe, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.error?.message ?? run.stderr);
    const rows = run.stdout.trim().split(/\r?\n/).map(line => line.split(" ").map(Number));
    assert.deepEqual(rows.slice(0, 4), [[0, 19], [1, 29], [2, 40], [3, 19]]);
    const capacity = spawnSync(exe, ["capacity"], { encoding: "utf8" });
    assert.equal(capacity.status, 0, capacity.error?.message ?? capacity.stderr);
    const overflow = spawnSync(exe, ["overflow"], { encoding: "utf8" });
    assert.equal(overflow.status, 1, overflow.error?.message ?? overflow.stderr);
    assert.match(overflow.stderr, /P_StartButton: no button slots left!/);
    const origins = spawnSync(exe, ["origins"], { encoding: "utf8" });
    assert.equal(origins.status, 0, origins.error?.message ?? origins.stderr);
    const numericRows = run => run.stdout.trim().split(/\r?\n/).map(line => line.split(" ").map(Number));
    return { buttons: rows.slice(4), capacity: numericRows(capacity), overflow: numericRows(overflow), origins: numericRows(origins) };
}

function capacityTrace() {
    const sim = build(`package main
import "play"
import "wad"
func change(state play.LevelSwitches, line int, side int, tier int, old int, replacement int, repeat bit) play.LevelSwitches {
    return state.ChangeTexture(line, side, wad.SwitchTextureMatch{Valid: true, Tier: tier,
        Original: wad.LumpName{Low: old}, Replacement: wad.LumpName{Low: replacement}}, repeat)
}
map "Switch override capacity" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    tick {
        original := wad.SideMaterial{Upper: wad.LumpName{Low: 1}, Middle: wad.LumpName{Low: 1}, Lower: wad.LumpName{Low: 1}}
        var switches play.LevelSwitches
        for i := range 64 {
            for tier := range 3 { switches = change(switches, i, 1024 + 4 * i, tier, 1, 2, false) }
        }
        for i := range 64 {
            side := switches.Textures.MaterialAt(1024 + 4 * i, original)
            log("side", i, side.Upper.Low, side.Middle.Low, side.Lower.Low)
        }
        log("revisions", switches.Textures.Count, switches.Revision)
        switches = change(switches, 0, 1276, wad.SwitchTop, 2, 1, true)
        switches = change(switches, 1, 1276, wad.SwitchTop, 1, 2, true)
        for i := range play.ButtonTics {
            switches = switches.TickButtons()
            if i >= play.ButtonTics - 2 {
                log("restore", i + 1, switches.Textures.MaterialAt(1276, original).Upper.Low,
                    switches.Buttons[0].Tics, switches.Buttons[1].Tics)
            }
        }
        switches = change(switches, 4, 5, wad.SwitchBottom, 1, 0, false)
        switches = change(switches, 4, 5, wad.SwitchBottom, 0, 0, false)
        switches = change(switches, 4, 5, wad.SwitchMiddle, 1, 45, false)
        side := switches.Textures.MaterialAt(5, original)
        log("blank", side.Upper.Low, side.Middle.Low, side.Lower.Low, switches.Textures.Count, switches.Revision)
        var full play.LevelSwitches
        for i := range play.MaxButtons { full = change(full, i, i, wad.SwitchTop, 1, 2, true) }
        full = change(full, 0, 0, wad.SwitchTop, 2, 1, true)
        log("full", full.ButtonCount, full.Buttons[0].Tics, full.Textures.MaterialAt(0, original).Upper.Low,
            full.Textures.MaterialAt(16, original).Upper.Low, full.ButtonOverflow)
        full = change(full, 16, 16, wad.SwitchTop, 1, 2, true)
        log("overflow", full.ButtonCount, full.Buttons[0].Tics, full.Textures.MaterialAt(0, original).Upper.Low,
            full.Textures.MaterialAt(16, original).Upper.Low, full.ButtonOverflow)
    }
}`);
    for (let host = 0; host < 1024 && sim.logs.at(-1)?.[0] !== "overflow"; ++host) sim.step();
    const logs = Array.from(sim.logs, row => Array.from(row));
    const select = label => logs.filter(row => row[0] === label).map(row => row.slice(1));
    const sides = select("side"), restore = select("restore"), full = [...select("full"), ...select("overflow")];
    assert.deepEqual(sides, Array.from({ length: 64 }, (_, i) => [i, 2, 2, 2]));
    assert.deepEqual(select("revisions"), [[192, 192]]);
    assert.deepEqual(restore, [[34, 2, 1, 1], [35, 1, 0, 0]]);
    assert.deepEqual(select("blank"), [[1, 45, 0, 194, 197]]);
    assert.deepEqual(full, [[16, 35, 1, 1, false], [16, 35, 1, 2, true]]);
    return { capacity: [...sides, ...restore], overflow: full.map(row => row.slice(0, 4)) };
}

try {
    // A few complete pairs per archive keep each generated checker bounded.
    for (let start = 0; start < pairs.length; start += 5) {
        const batch = pairs.slice(start, start + 5);
        mountTextures(batch.flatMap(([first]) => [first, other(first)]));
        const cases = batch.flatMap(([first, minimum], index) => [
            { index, minimum, first, input: first, output: other(first), episode: minimum },
            { index, minimum, first, input: other(first), output: first, episode: minimum },
            { index, minimum, first, input: first, output: other(first), episode: minimum - 1 },
            { index, minimum, first, input: other(first), output: first, episode: minimum - 1 },
        ]);
        const checks = cases.map(({ input, episode, index }, tic) => `
        if currentTick() == ${tic} {
            side := wad.SideMaterial{Upper: ${literal(input)}}
            matched := wad.MatchSwitchTexture(side, textures, ${episode})
            row := wad.SwitchPairs[${start + index}]
            log(row[0], row[1], row[2], matched.Valid, matched.Tier, matched.Original.Low, matched.Original.High,
                matched.Replacement.Low, matched.Replacement.High)
        }`).join("\n");
        const sim = build(`package main
import "wad"
const Archive = readFile("SWITCHES.WAD")
map "Doom switch table" {
    tick {
        textures := wad.LoadMountedTextureSet(wad.OpenArchive(Archive))
        ${checks}
    }
}
`);
        for (const _ of cases) sim.step();
        const rows = JSON.parse(JSON.stringify(sim.logs));
        assert.equal(rows.length, cases.length);
        for (const [tic, { first, minimum, input, output, episode }] of cases.entries()) {
            const matching = episode >= minimum;
            const expectedNames = matching ? [...nameWords(input), ...nameWords(output)] : [0, 0, 0, 0];
            assert.deepEqual(rows[tic], [...nameWords(first), minimum, matching, 0, ...expectedNames]);
        }
    }
    console.log("Doom switch table matched 160 vectors across 40 pairs, both directions, and edition gates.");

    const editions = [
        [["E1M1"], "E1M1", 1],
        [["E1M1", "E2M1", "E3M1"], "E1M1", 2],
        [["E1M1", "E2M1", "E3M1", "E4M1"], "E1M1", 1],
        [["MAP01"], "MAP01", 3],
        [["E3M4"], "E3M4", 2],
    ];
    for (const [index, [markers]] of editions.entries()) {
        writeFileSync(path.join(scratch, `MODE${index}.WAD`), wad(markers.map(marker => [marker, Buffer.alloc(0)])));
    }
    const editionSim = build(`package main
import "wad"
${editions.map((_, index) => `const Mode${index} = readFile("MODE${index}.WAD")`).join("\n")}
map "Switch edition detection" {
    tick {
        ${editions.map(([, marker], index) =>
            `if currentTick() == ${index} { log(wad.SwitchEpisode(wad.OpenArchive(Mode${index}), ${literal(marker)})) }`).join("\n        ")}
    }
}
`);
    for (const _ of editions) editionSim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(editionSim.logs)), editions.map(([, , edition]) => [edition]));

    mountTextures(["SW1BRCOM", "SW2BRCOM", "SW1BRN1"]);
    const first = literal("SW1BRCOM"), second = literal("SW2BRCOM");
    const sim = build(`package main
import "play"
import "wad"
const Archive = readFile("SWITCHES.WAD")
map "Doom switch timers" {
    register state play.LevelSwitches = play.LevelSwitches{}
    tick {
        mounts := wad.OpenArchive(Archive)
        textures := wad.LoadMountedTextureSet(mounts)
        // p_switch.c tests SW1 first across all three tiers before it reaches
        // SW2: this middle SW1 therefore beats the upper SW2.
        original := wad.SideMaterial{Upper: ${second}, Middle: ${first}}
        frame := state
        tic := currentTick()
        if tic == 0 || tic == 10 {
            material := frame.Textures.MaterialAt(12, original)
            matched := wad.MatchSwitchTexture(material, textures, 1)
            frame = frame.ChangeTexture(4, 12, matched, true)
        }
        if tic > 0 { frame = frame.TickButtons() }
        if tic == 0 || tic == 1 || tic == 10 || tic == 34 || tic == 35 {
            material := frame.Textures.MaterialAt(12, original)
            log(tic, material.Upper.Low, material.Middle.Low, frame.Buttons[0].Tics)
        }
        if tic == 0 {
            // A different physical side is untouched, and a pair with a
            // missing endpoint cannot start another texture change.
            otherSide := frame.Textures.MaterialAt(13, original)
            partial := wad.MatchSwitchTexture(wad.SideMaterial{Lower: ${literal("SW1BRN1")}}, textures, 1)
            log(otherSide.Upper.Low, otherSide.Middle.Low, partial.Valid)
        }
        next state = frame
    }
}
`);
    for (let tic = 0; tic <= 35; tic++) sim.step();
    const [firstLow] = nameWords("SW1BRCOM");
    const [secondLow] = nameWords("SW2BRCOM");
    const rows = JSON.parse(JSON.stringify(sim.logs));
    assert.deepEqual(rows.splice(1, 1), [[secondLow, firstLow, false]]);
    const textureIds = [0, firstLow, secondLow];
    const trace = rows.map(([tic, top, middle, timer]) => [tic, textureIds.indexOf(top), textureIds.indexOf(middle), timer]);
    assert.deepEqual(trace, [[0, 2, 2, 35], [1, 2, 2, 34], [10, 1, 2, 25], [34, 1, 2, 1], [35, 1, 1, 0]]);
    console.log("Doom switch buttons matched entry priority, repeated presses, and the 35-tic restore.");

    const large = capacityTrace();
    console.log("Verified 192 texture overrides, shared-side restore order, blank textures, and the 17th-button failure.");
    const origins = activationSoundTrace();
    assert.deepEqual(origins, [[23, -1], [23, 0], [23, 0], [23, -1]]);
    const [, , , switchSource, specSource] = process.argv;
    if (switchSource || specSource) {
        assert.ok(switchSource && specSource, "provide both pinned p_switch.c and p_spec.c");
        const native = nativeTrace(switchSource, specSource);
        assert.deepEqual(trace, native.buttons);
        assert.deepEqual(large.capacity, native.capacity);
        assert.deepEqual(large.overflow, native.overflow);
        assert.deepEqual(origins, native.origins);
        console.log("Doom switch button traces and four activation sound origins matched the pinned C functions.");
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
