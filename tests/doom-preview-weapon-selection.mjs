// Drive the compiled preview's direct weapon controls in shareware and commercial rooms.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const scratch = mkdtempSync(path.join(temp, "fletcher-preview-direct-weapon-"));
const fist = 0, pistol = 1, shotgun = 2, rocket = 4, plasma = 5, bfg = 6, saw = 7, ssg = 8, noChange = 10;
const owned = [true, true, true, false, true, true, true, true, true];
const sliceTic = 24;

function room(marker) {
    function words(values) {
        const data = Buffer.alloc(values.length * 2);
        values.forEach((v, i) => data.writeUInt16LE(v & 65535, 2 * i));
        return data;
    }
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const sector = Buffer.alloc(26);
    sector.writeInt16LE(128, 2);
    sector.writeInt16LE(160, 20);
    const lumps = [
        [marker, Buffer.alloc(0)], ["THINGS", words([0, 0, 0, 1, 7])],
        ["LINEDEFS", words(edges.flatMap(([a, b]) => [a, b, 1, 0, 0, 0, -1]))], ["SIDEDEFS", Buffer.alloc(30)],
        ["VERTEXES", words([-64, -64, -64, 64, 64, 64, 64, -64])],
        ["SEGS", words(edges.flatMap(([a, b], i) => [a, b, [0x4000, 0, 0xc000, 0x8000][i], i, 0, 0]))],
        ["SSECTORS", words([4, 0])], ["NODES", Buffer.alloc(0)], ["SECTORS", sector], ["REJECT", Buffer.alloc(1)],
        ["BLOCKMAP", words([-64, -64, 1, 1, 5, 0, 0, 1, 2, 3, -1])],
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
    const proc = spawnSync(program, args, { cwd: root, encoding: "utf8", timeout: 60_000 });
    if (proc.error) throw proc.error;
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    return proc.stdout;
}

function prepare() {
    const copy = path.join(scratch, "preview"), entry = path.join(copy, "main.flt");
    cpSync(path.join(port, "wad-bsp"), copy, { recursive: true });
    let source = readFileSync(entry, "utf8").replaceAll("\r\n", "\n");
    function after(anchor, insertion) {
        assert.equal(source.split(anchor).length, 2, "unique preview anchor " + anchor);
        source = source.replace(anchor, anchor + "\n" + insertion);
    }
    if (!source.includes('import "actorinfo"')) after('import "play"', 'import "actorinfo"');
    after("start := spawned.ActorAt(spawned.PlayerActors[0] - 1)", `
                            carry.Weapons = [play.WeaponCount]bit{${owned.join(", ")}}
                            if commercial { carry.Powers[play.PowerStrength] = 1 }`);
    after("next player = moved", `
                    selected := frame.Contacts.Inventory
                    def := actorinfo.WeaponAt(selected.ReadyWeapon)
                    log("weapon-select", levelTime, selected.ReadyWeapon, selected.PendingWeapon, heldWeapon.Weapon.Y,
                        heldWeapon.Weapon.State == def.Down, heldWeapon.Weapon.State == def.Up,
                        contacts.Rules.Commercial, shareware, selected.Powers[play.PowerStrength] != 0, requestedWeapon)
                    if levelTime == ${sliceTic} {
                        work := 0
                        for i := range 100000 { work = work + (i & 1) }
                        log("selection-slice", work)
                    }`);
    writeFileSync(entry, source);
    return entry;
}

function last(sim) {
    const row = sim.logs.findLast(([tag]) => tag === "weapon-select");
    if (!row) return { tic: -1 };
    const [, tic, ready, pending, y, down, up, commercial, shareware, strength, requested] = row.map(Number);
    return { tic, ready, pending, y, down, up, commercial, shareware, strength, requested };
}

function advance(sim, predicate, message) {
    for (let host = 0; host < 200 && !predicate(last(sim)); host++) sim.step();
    assert.ok(predicate(last(sim)), message + ": " + JSON.stringify(last(sim)));
    return last(sim);
}

function exercise(entry, marker, cases) {
    const output = path.join(scratch, marker + ".json");
    writeFileSync(path.join(scratch, "LEVEL.WAD"), room(marker));
    run("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", scratch, "-o", output]);
    const tiles = decode(JSON.parse(readFileSync(output, "utf8")).data);
    const sim = simulator(tiles, true), commercial = marker === "MAP01";
    const keyCode = digit => 27 + digit;
    const walkKey = tiles.find(tile => tile.type === 21 && tile.extra === 23);
    assert.ok(walkKey);
    for (let digit = 1; digit <= 8; digit++) {
        const tile = sim.tileAt({ x: -56 + 16 * (digit - 1), y: walkKey.y + 9 });
        assert.deepEqual([tile?.type, tile?.extra], [21, keyCode(digit)], "physical key " + digit);
    }
    const first = advance(sim, row => row.tic === sliceTic - 1, "finish the initial pistol raise");
    assert.deepEqual([first.ready, first.pending, first.y, first.commercial, first.shareware, first.strength],
        [pistol, noChange, 32 << 16, +commercial, +!commercial, +commercial]);

    // Pulse and release while this logical tic is already running. Its
    // inputs were sampled before the pulse, and its log is committed afterward.
    sim.step();
    assert.equal(last(sim).tic, sliceTic - 1);
    sim.step([], new Map(), [7, 3, 1].map(keyCode));
    assert.equal(last(sim).tic, sliceTic - 1, "release the digit chord before the in-flight tic commits");
    const old = advance(sim, row => row.tic === sliceTic, "complete the interrupted tic");
    assert.deepEqual([old.ready, old.pending, old.requested], [pistol, noChange, noChange]);
    assert.deepEqual(sim.logs.find(([tag]) => tag === "selection-slice"), ["selection-slice", 50000]);

    function command(digits, expected, message, { buffered = false, cycle = false } = {}) {
        const before = last(sim);
        if (!buffered) sim.step([], new Map(), [...digits.map(keyCode), ...(cycle ? [24] : [])]);
        const after = advance(sim, row => row.tic === before.tic + 1, message);
        assert.deepEqual([after.requested, after.ready, after.pending], [Math.min(...digits) - 1, before.ready, expected], message);
        cases.push({ digits, commercial, strength: before.strength, ready: before.ready, pending: before.pending,
            request: after.requested, result: after.pending, message });
        return after;
    }
    function settle(weapon) {
        // A multi-tic idle frame (notably the saw) can finish after the
        // command was queued. Lowering begins on the next WeaponReady action.
        advance(sim, row => row.pending === weapon && row.down, "lower the old weapon for the queued request");
        const raised = advance(sim, row => row.ready === weapon && row.pending === noChange, "adopt the pending weapon");
        assert.deepEqual([raised.up, raised.requested], [1, noChange], "weapon starts raising after the digit was released");
        advance(sim, row => row.ready === weapon && row.y === 32 << 16 && !row.up, "finish raising the selected weapon");
    }

    command([7, 3, 1], saw, "the lowest pressed digit wins and fists select the owned saw", { buffered: true });
    settle(saw);
    if (commercial) {
        command([1], fist, "berserk makes slot one alternate from saw to fist");
        settle(fist);
        command([8], saw, "slot eight selects the saw directly");
        settle(saw);
        command([3], ssg, "commercial slot three prefers the owned super shotgun");
        settle(ssg);
        command([3], shotgun, "slot three on the super shotgun switches to the regular shotgun");
        settle(shotgun);
        command([4, 5], noChange, "the unowned lower slot suppresses both the rocket and X cycle", { cycle: true });
        command([6], plasma, "commercial play accepts plasma even with no cells");
        command([4], plasma, "an unowned request leaves the queued plasma intact");
        command([7], bfg, "a second request during lowering replaces the queued plasma with the BFG");
        settle(bfg);
        command([5], rocket, "slot five selects the owned launcher");
        settle(rocket);
        command([2], pistol, "slot two restores the pistol");
        settle(pistol);
    } else {
        command([1], noChange, "without berserk a ready saw keeps slot one");
        command([6], noChange, "shareware refuses owned plasma");
        command([7], noChange, "shareware refuses an owned BFG");
        command([3], shotgun, "episode slot three ignores an owned super shotgun");
        settle(shotgun);
    }
}

function native(upstream, cases) {
    const read = name => readFileSync(path.resolve(root, upstream, name), "utf8").replaceAll("\r\n", "\n");
    const keyboard = extractFunction(read("g_game.c"), "void", "G_BuildTiccmd")
        .match(/for\s*\(i=0\s*;\s*i<NUMWEAPONS-1\s*;\s*i\+\+\)\s*if\s*\(gamekeydown\['1'\+i\]\)\s*\{[^}]+\}/)?.[0];
    const think = extractFunction(read("p_user.c"), "void", "P_PlayerThink");
    const start = think.indexOf("if (cmd->buttons & BT_CHANGE)"), end = think.indexOf("// check for use", start);
    assert.ok(keyboard && start >= 0 && end > start, "pinned weapon command blocks");
    const source = path.join(scratch, "select.c"), exe = path.join(scratch, "select.exe");
    writeFileSync(source, `#include <stdio.h>
enum { NUMWEAPONS=9, BT_CHANGE=4, BT_WEAPONSHIFT=3, BT_WEAPONMASK=56,
    wp_fist=0, wp_shotgun=2, wp_plasma=5, wp_bfg=6, wp_chainsaw=7, wp_supershotgun=8,
    pw_strength=1, shareware=0, commercial=2 };
typedef struct { int buttons; } ticcmd_t;
typedef struct { int readyweapon, pendingweapon, powers[2], weaponowned[9]; } player_t;
static void selectSlot(unsigned mask, int gamemode, int strength, int ready, int pending) {
    int gamekeydown[128]={0}, i, newweapon;
    for (i=0; i<8; ++i) gamekeydown['1'+i]=(mask>>i)&1;
    ticcmd_t command={0}, *cmd=&command;
    player_t inventory={.readyweapon=ready, .pendingweapon=pending,
        .powers={0,strength}, .weaponowned={${owned.map(Number).join(",")}}}, *player=&inventory;
    ${keyboard}
    ${think.slice(start, end)}
    printf("[%d,%d]\\n", (cmd->buttons & BT_WEAPONMASK) >> BT_WEAPONSHIFT, player->pendingweapon);
}
int main(void) {
${cases.map(c => `    selectSlot(${c.digits.reduce((mask, d) => mask | (1 << (d - 1)), 0)},${c.commercial ? 2 : 0},${c.strength},${c.ready},${c.pending});`).join("\n")}
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", source, "-o", exe]);
    const rows = run(exe, []).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(rows.length, cases.length);
    cases.forEach((c, i) => assert.deepEqual([c.request, c.result], rows[i], "native command result: " + c.message));
}

try {
    const entry = prepare(), cases = [];
    exercise(entry, "E1M1", cases);
    exercise(entry, "MAP01", cases);
    if (values.upstream) native(values.upstream, cases);
    console.log(`Preview direct weapon controls passed ${cases.length} requests across E1M1 and MAP01, including sliced pulses.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-preview-direct-weapon-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
