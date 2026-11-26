// Drive an original IWAD campaign transition with keyboard input.
// The default diagnostic seeds E1M1 at the exit and continues through E1M2 rebirth.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: {
    wad: { type: "string" }, cli: { type: "string" }, "desktop-output": { type: "string" },
    "from-start": { type: "boolean" },
} });
assert.ok(values.wad, "Pass --wad PATH to the local Ultimate Doom IWAD");
const wad = path.resolve(values.wad), file = readFileSync(wad);
assert.equal(file.toString("ascii", 0, 4), "IWAD");
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples/doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-campaign-route-"));
const unit = 65536;
const mapWord = map => Buffer.from(map).readUInt32LE();
const buttons = ["forward", "reverse", "strafeLeft", "strafeRight", "use", "fire", "turnLeft", "turnRight",
    "forwardActivity", "turnActivity", "sidestepActivity", "actionActivity",
    "forwardLetter", "reverseLetter", "leftLetter", "rightLetter", "useLetter", "fireLetter"];
const eventTypes = ["route-load", "route-tic", "route-intermission"];
const eventWidth = 18;
const desktopHostLimit = 6000;
const bitFields = new Set(["restartPending", "advancing", "frame.Contacts.Inventory.Dead",
    "enemy.HasMonsterThinker(attacker)", "attacker.Transient"]);

const desktopReporter = `
const { x, y } = getPosition();
always(() => {
    if (state.reported) return;
    if (state.start === undefined) {
        state.start = Date.now();
        state.tick = world.getTick();
    }
    const pass = world.getSignal(x + 4, y) > 0;
    const fail = world.getSignal(x + 12, y) > 0;
    const ticks = world.getTick() - state.tick;
    if (!pass && !fail && ticks < ${desktopHostLimit}) return;
    state.reported = true;
    const elapsed = Date.now() - state.start;
    const verdict = pass && !fail ? "PASS" : fail ? "FAIL (state mismatch)" : "FAIL (no result)";
    const message = "Doom route " + verdict + " | " + ticks + " host ticks in " + elapsed + " ms";
    if (typeof showText === "function") showText(message);
    log("desktop-result", pass && !fail, ticks, elapsed);
});
`;

function lump(map, name) {
    const count = file.readUInt32LE(4), dir = file.readUInt32LE(8);
    let inMap = false;
    for (let i = 0; i < count; i++) {
        const entry = dir + 16 * i;
        const label = file.toString("ascii", entry + 8, entry + 16).replace(/\0.*$/, "");
        if (/^E\dM\d$/.test(label)) inMap = label === map;
        if (inMap && label === name) {
            const offset = file.readUInt32LE(entry);
            return file.subarray(offset, offset + file.readUInt32LE(entry + 4));
        }
    }
    assert.fail(`${map} lacks ${name}`);
}

function exitSwitch() {
    const lines = lump("E1M1", "LINEDEFS"), vertices = lump("E1M1", "VERTEXES");
    for (let i = 0; i < lines.length; i += 14) {
        if (lines.readUInt16LE(i + 6) !== 11) continue;
        const a = 4 * lines.readUInt16LE(i), b = 4 * lines.readUInt16LE(i + 2);
        const x1 = vertices.readInt16LE(a), x2 = vertices.readInt16LE(b);
        const y1 = vertices.readInt16LE(a + 2), y2 = vertices.readInt16LE(b + 2);
        const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy);
        return { index: i / 14, x: Math.round((x1 + x2) / 2 + 32 * dy / length),
            y: Math.round((y1 + y2) / 2 - 32 * dx / length), dx, dy };
    }
    assert.fail("E1M1 has no normal exit switch");
}

function playerStart(map) {
    const things = lump(map, "THINGS");
    for (let i = 0; i < things.length; i += 10) {
        if (things.readInt16LE(i + 6) === 1) return [things.readInt16LE(i) * unit, things.readInt16LE(i + 2) * unit];
    }
    assert.fail(`${map} has no player-one start`);
}

function build(exit, recording = false, replay = null) {
    const preview = path.join(scratch, "preview"), output = path.join(scratch, "map.json");
    cpSync(path.join(port, "wad-bsp"), preview, { recursive: true });
    const entry = path.join(preview, "main.flt");
    let source = readFileSync(entry, "utf8").replaceAll("\r\n", "\n");
    function replace(anchor, text) {
        assert.equal(source.split(anchor).length, 2, `unique diagnostic anchor: ${anchor}`);
        source = source.replace(anchor, () => text);
    }
    function routeLog(tag, fields) {
        const log = `log("${tag}", ${fields.join(", ")})`;
        if (!replay) return log;
        const cells = [eventTypes.indexOf(tag) + 1, ...fields.map(field =>
            bitFields.has(field) ? `desktopInt(${field})` : `int(${field})`)];
        return `${log}
        if desktopMatches(desktopEvent, [${eventWidth}]int{${cells.join(", ")}}) {
            next desktopEvent = desktopEvent + 1
        } else { next desktopStatus = 2 }`;
    }
    replace('readFile("LEVEL.WAD")', `readFile(${JSON.stringify(path.basename(wad))})`);
    const initial = "                                initial := start.Physics";
    if (!values["from-start"]) replace(initial, `                                if level.MapName.Low == ${mapWord("E1M1")} && !done {
                                    x, y := ${exit.x * unit}, ${exit.y * unit}
                                    sector := level.SectorAtPoint(x, y)
                                    start.Physics.Body.X, start.Physics.Body.Y = x, y
                                    start.Physics.Body.Floor, start.Physics.Body.Z = sector.Heights.Floor, sector.Heights.Floor
                                    start.Physics.Body.Ceiling = sector.Heights.Ceiling
                                    start.Physics.Angle = engine.PointToAngle(0, 0, ${-exit.dy * unit}, ${exit.dx * unit})
                                    start.Sector, start.Subsector = sector.Index, sector.Subsector
                                    spawned = spawned.WithActor(spawned.PlayerActors[0], start)
                                }
${initial}`);
    const load = "                                    next player = initial";
    replace(load, `${load}
                                    ${routeLog("route-load", ["level.MapName.Low", "initial.Body.X", "initial.Body.Y", "restartPending", "advancing"])}`);
    const tic = "                    next player = moved";
    replace(tic, `${tic}
                    attacker := actorFrame.Actors.ActorAt(frame.Contacts.Inventory.Attacker - 1)
                    ${routeLog("route-tic", ["base.MapName.Low", "levelTime", "moved.Body.X", "moved.Body.Y", "frame.Contacts.Inventory.Health",
                        "frame.Contacts.Inventory.Ammo[play.AmmoClip]", "frame.Contacts.Inventory.Dead", "enemy.HasMonsterThinker(attacker)",
                        "attacker.Kind", "attacker.Transient", "frame.Contacts.Inventory.Attacker", "mapActors",
                        "attacker.Physics.Body.X", "attacker.Physics.Body.Y", "attacker.Health", "int(moved.Angle)", "used.Doors.NextMover"])}`);
    const advance = "                next intermission = advanced";
    replace(advance, `${advance}
                ${routeLog("route-intermission", ["advanced.Stage", "advanced.BackgroundTics"])}`);
    if (recording) replace("    tick {", `    tick {
        log("route-buttons", currentTick(), ${buttons.join(", ")})`);
    if (replay) {
        const screen = 'map "Original WAD BSP View" {';
        const { commands, events } = replay;
        replace(screen, `const DesktopButtons = [${commands.length}]bits<${buttons.length}>{${commands.join(",")}}
const DesktopEvents = [${events.length}][${eventWidth}]int{
    ${events.map(row => `[${eventWidth}]int{${row.join(",")}}`).join(",\n    ")},
}
func desktopInt(value bit) int {
    if value { return 1 }
    return 0
}
func desktopMatches(index int, observed [${eventWidth}]int) bit {
    if index >= ${events.length} { return false }
    for field := range ${eventWidth} { if DesktopEvents[index][field] != observed[field] { return false } }
    return true
}
map "${values["from-start"] ? "Doom 160 Full Hangar Route" : "Doom Campaign Route Check"}" {
    place scriptBlock at (-60, ControlRow + 17) with { code = ${JSON.stringify(desktopReporter)} }
    script { output desktopResult bits<2> at (-56, ControlRow + 17) = desktopStatus }
    register desktopStatus bits<2> = 0
    register desktopEvent int = 0`);
        for (const button of buttons) replace(`    input ${button} bit at `, `    input native${button} bit at `);
        replace("    tick {", `    tick {
        if desktopStatus == 0 && currentTick() >= ${commands.length} {
            if desktopEvent == ${events.length} { next desktopStatus = 1 } else { next desktopStatus = 2 }
        }
        if desktopStatus == 0 && currentTick() < ${commands.length} {
            command := DesktopButtons[currentTick()]
            ${buttons.map((button, index) => `${button} := command[${index}]`).join("\n            ")}`);
        const end = "\n    }\n\n    host tick {";
        replace(end, "\n        }" + end);
    }
    if (values["from-start"]) {
        const setConstant = (file, name, original, value) => {
            const target = path.join(preview, file + ".flt");
            const data = readFileSync(target, "utf8");
            const anchor = `const ${name} = ${original}`;
            assert.equal(data.split(anchor).length, 2, anchor);
            writeFileSync(target, data.replace(anchor, `const ${name} = ${value}`));
        };
        setConstant("combat-preview", "previewCombatSkill", 2, 0);
        setConstant("display", "Width", 128, 160);
        setConstant("display", "Height", 96, 120);
        setConstant("display", "DisplayScale", 1, 2);
        setConstant("display", "DisplayStyle", '"solid"', '"rgb"');
        setConstant("display", "DisplayZoom", '""', '"4"');
        setConstant("display", "DisplaySliceWork", 0, 65536);
    }
    replace("    register soundMuted bit = false", "    register soundMuted bit = true");
    writeFileSync(entry, source);
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "--asset-root", path.dirname(wad), "-o", output],
        { cwd: root, encoding: "utf8", timeout: 120000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return readFileSync(output, "utf8");
}

const makeSimulator = level => simulator(decode(JSON.parse(level).data), true);

function walkHangar(until, current, exit) {
    function turnTo(degrees) {
        const heading = (current()[16] >>> 0) * 360 / 2 ** 32;
        return (degrees - heading + 540) % 360 - 180;
    }
    function walk(x, y) {
        let best = Infinity, progress = 0;
        const delta = () => [x - current()[3] / unit, y - current()[4] / unit];
        until(() => Math.hypot(...delta()) < 12, host => {
            assert.equal(current()[7], false, `player died on the way to (${x}, ${y})`);
            const [dx, dy] = delta();
            const distance = Math.hypot(dx, dy);
            if (distance < best - 2) { best = distance; progress = host; }
            const turn = turnTo(Math.atan2(dy, dx) * 180 / Math.PI);
            const keys = Math.abs(turn) > 5 ? [turn > 0 ? 1 : 4] : [];
            if (Math.abs(turn) < 18) {
                keys.push(23);
                if (host - progress > 18) keys.push(18);
            }
            return keys;
        }, 550, `walk to (${x}, ${y})`);
    }
    function face(degrees) {
        until(() => Math.abs(turnTo(degrees)) < 6, () => [turnTo(degrees) > 0 ? 1 : 4], 160, `face ${degrees} degrees`);
    }
    function door(x, y, degrees) {
        walk(x, y);
        face(degrees);
        const mover = current()[17];
        const position = [Math.round(current()[3] / unit), Math.round(current()[4] / unit)];
        until(() => current()[17] !== mover, i => i % 14 < 7 ? [6] : [], 75, `open door near (${position.join(", ")})`);
        const openedAt = current()[2];
        until(() => current()[2] >= openedAt + 40, [], 160, "let the original door open");
    }
    walk(1184, -2944);
    walk(1248, -2880);
    walk(1360, -2576);
    door(1506, -2512, 0);
    walk(1616, -2512);
    walk(2048, -2560);
    walk(2112, -2624);
    walk(2704, -2672);
    walk(2912, -2880);
    walk(2976, -3792);
    door(3008, -3976, 270);
    walk(3008, -4112);
    walk(3008, -4544);
    door(3008, -4610, 270);
    walk(3008, -4704);
    walk(exit.x, exit.y);
    face(Math.atan2(exit.dx, -exit.dy) * 180 / Math.PI);
}

function writeDesktopReplay(exit, logs, destination) {
    const commands = logs.filter(([tag]) => tag === "route-buttons").map(([, tick, ...sample], index) => {
        assert.equal(tick, index, "recorded logical tics are contiguous");
        return sample.reduce((mask, key, lane) => mask | (Number(key) << lane), 0);
    });
    const trace = logs.filter(([tag]) => eventTypes.includes(tag)).map(row => Array.from(row));
    const events = trace.map(([tag, ...fields]) => [eventTypes.indexOf(tag) + 1, ...fields.map(Number)]);
    assert.ok(commands.length > 0 && events.length > 0);
    const level = build(exit, false, { commands, events });
    const sim = makeSimulator(level);
    for (let host = 0; host <= desktopHostLimit && !sim.logs.some(([tag]) => tag === "desktop-result"); host++) sim.step();
    assert.equal(sim.logs.find(([tag]) => tag === "desktop-result")?.[1], true, "the generated desktop replay verified its trace");
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs.filter(([tag]) => eventTypes.includes(tag)))), trace);

    const output = path.resolve(destination);
    const parent = realpathSync(path.dirname(output));
    const relative = path.relative(realpathSync(root), parent);
    assert.ok(relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative),
        "the desktop replay contains the supplied WAD and must stay outside the repository");
    writeFileSync(path.join(parent, path.basename(output)), level, { flag: "wx" });
    console.log(`Wrote verified desktop route check with ${commands.length} logical input tics and ${events.length} state records to ${output}.`);
}

try {
    const exit = exitSwitch(), spawn = playerStart("E1M2"), sim = makeSimulator(build(exit, Boolean(values["desktop-output"])));
    const last = tag => sim.logs.findLast(row => row[0] === tag);
    let host = 0;
    function until(condition, keys, limit, label) {
        for (let i = 0; i < limit && !condition(); i++, host++) {
            const n = sim.logs.length;
            sim.step([], new Map(), typeof keys === "function" ? keys(i) : keys);
            for (const [tag, map, tic, x, y, health] of sim.logs.slice(n)) {
                assert.doesNotMatch(tag, /could not|invalid|cannot spawn|exceeds/i);
                if (tag === "route-tic" && map === mapWord("E1M2") && tic % 64 === 0) {
                    console.log(`E1M2 tic ${tic}, position (${Math.round(x / unit)}, ${Math.round(y / unit)}), health ${health}.`);
                }
            }
        }
        assert.ok(condition(), `${label}: ${JSON.stringify(sim.logs.slice(-4))}`);
    }
    until(() => last("route-tic"), [], 600, "start E1M1");
    const fromStart = values["from-start"];
    const start = fromStart ? playerStart("E1M1") : [exit.x * unit, exit.y * unit];
    assert.deepEqual(Array.from(last("route-load")).slice(1, 4), [mapWord("E1M1"), ...start]);
    if (fromStart) walkHangar(until, () => last("route-tic"), exit);
    until(() => last("Doom level exit requested"), [6], 150, "use the original E1M1 exit");
    const exitTic = last("route-tic");
    console.log(`Used E1M1 linedef ${exit.index} ${fromStart ? "after walking from the original spawn" : "from a seeded position 32 units in front of its switch"}.`);
    until(() => last("Doom next level rendered"), i => i % 24 < 12 ? [fromStart ? 6 : 18] : [], 1600, "complete intermission");
    const stages = new Set(sim.logs.filter(row => row[0] === "route-intermission").map(row => row[1]));
    assert.deepEqual([...stages], [1, 2, 3, 4]);
    until(() => last("route-tic")[1] === mapWord("E1M2"), [], 600, "start E1M2");
    assert.deepEqual(Array.from(last("route-load")).slice(1), [mapWord("E1M2"), ...spawn, false, true]);
    console.log("Entered E1M2 at its original player start after all four intermission stages.");
    if (fromStart) {
        assert.deepEqual(Array.from(last("route-tic")).slice(2, 8), [0, ...spawn, exitTic[5], exitTic[6], false]);
        console.log(`E1M2 preserved ${exitTic[5]} health and ${exitTic[6]} bullets at level tic zero (${host} simulator host ticks).`);
    } else {
        until(() => last("route-tic")[6] < 50, [18], 600, "fire the pistol to alert the monsters");
        // Leave the spawn corridor, cross the open hall, then approach the
        // original zombieman in the eastern room. All three legs use WASD.
        until(() => last("route-tic")[4] >= 32 * unit || last("route-tic")[7], [23], 1200, "leave the spawn corridor");
        until(() => last("route-tic")[3] >= 330 * unit || last("route-tic")[7], [5], 1400, "strafe east across the hall");
        until(() => last("route-tic")[4] >= 190 * unit || last("route-tic")[7], [23], 1000, "approach the eastern room");
        // Face north throughout the route. After taking a hit, move closer to
        // its source using keyboard input so knockback cannot park us in cover.
        function approachAttacker() {
            const row = last("route-tic");
            if (!row[8] || row[15] <= 0) return [];
            const dx = (row[13] - row[3]) / unit, dy = (row[14] - row[4]) / unit;
            const keys = [];
            if (Math.abs(dx) > 26) keys.push(dx > 0 ? 5 : 17);
            if (Math.abs(dy) > 26) keys.push(dy > 0 ? 23 : 19);
            return keys;
        }
        until(() => last("route-tic")[7], approachAttacker, 15000, "die to an original E1M2 monster");
        const dead = last("route-tic");
        assert.equal(dead[5], 0);
        assert.ok(dead[8] && !dead[10] && dead[11] > 0 && dead[11] <= dead[12], "the killer is an original map actor");
        console.log(`E1M2 player died on level tic ${dead[2]} to map actor ${dead[11]} (kind ${dead[9]}).`);
        until(() => last("Doom level restarted"), [6], 900, "request E1M2 rebirth with F");
        until(() => last("route-tic")[2] === 0 && !last("route-tic")[7], [], 600, "play the first restarted tic");
        assert.deepEqual(Array.from(last("route-load")).slice(1), [mapWord("E1M2"), ...spawn, true, false]);
        assert.deepEqual(Array.from(last("route-tic")).slice(1, 8), [mapWord("E1M2"), 0, ...spawn, 100, 50, false]);
        console.log(`Restarted E1M2 at its original start with 100 health and 50 bullets (${host} simulator host ticks).`);
    }
    if (values["desktop-output"]) writeDesktopReplay(exit, sim.logs, values["desktop-output"]);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-campaign-route-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
