import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratchRoot = realpathSync(artifacts);
const scratch = mkdtempSync(path.join(scratchRoot, "circuit-macros-"));

function write(relative, source) {
    const file = path.join(scratch, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
    return file;
}

function run(...args) {
    const result = spawnSync("dotnet", [cli, ...args], { cwd: root, encoding: "utf8", timeout: 20000 });
    if (result.error) throw result.error;
    return result;
}

function build(name, entry) {
    const level = path.join(scratch, name + ".json");
    const dump = path.join(scratch, name + ".ir.json");
    const result = run("build", entry, "-o", level, "--emit-ir", dump, "--explain");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const tiles = decode(JSON.parse(readFileSync(level, "utf8")).data);
    return { tiles, ir: JSON.parse(readFileSync(dump, "utf8")), report: result.stdout };
}

function diagnostic(name, source, expected) {
    const result = run("check", write(name + "/main.flt", source));
    assert.equal(result.status, 1, `${name}: ${result.stderr || result.stdout || "the compiler accepted the source"}`);
    assert.match(result.stderr, expected, name);
}

function position(report, name) {
    const [, x, y] = report.match(new RegExp("^" + name + "  .*? at \\((-?\\d+), (-?\\d+)\\)", "m"));
    return { x: Number(x), y: Number(y) };
}

try {
    const entry = write("backends/main.flt", `package main
import "gates"
backend circuit
map "File backend" {
    input a bit
    input b bit
    wire difference bit = gates.Different(a, b)
    output result bit = difference
    script {
        output clock bit = clockHigh()
        output observed bit = difference
    }
}`);
    write("backends/gates/gates.flt", `package gates
backend circuit
func Different(a bit, b bit) bit { return a ^ b }`);
    write("backends/clock.flt", `package main
func clockHigh() bit { return currentTick() % 2 == 0 }`);
    const mixed = build("file-backend", entry);
    const backend = new Map(mixed.ir.bindings.map(binding => [
        mixed.ir.symbols.find(symbol => symbol.id === binding.symbol).name, binding.backend,
    ]));
    assert.equal(backend.get("difference"), "Circuit");
    assert.equal(backend.get("result"), "Circuit");
    assert.equal(backend.get("clock"), "Script");
    assert.equal(backend.get("observed"), "Script");
    assert.match(mixed.report, /^result  circuit/m);
    assert.match(mixed.report, /^clock  script/m);
    assert.ok(mixed.tiles.some(tile => tile.type === 17), "the XOR function lowered to a physical gate");
    const a = position(mixed.report, "input a"), b = position(mixed.report, "input b"), result = position(mixed.report, "result");
    const clock = position(mixed.report, "clock"), observed = position(mixed.report, "observed");
    const model = simulator(mixed.tiles);
    let tick = 0;
    for (const [av, bv] of [[0, 0], [0, 1], [1, 1], [1, 0]]) {
        const held = new Map([[`${a.x + 1},${a.y}`, av], [`${b.x + 1},${b.y}`, bv]]);
        for (let settling = 0; settling < 160; settling++, tick++) {
            model.step([], held);
            assert.equal(model.value(clock), Number(tick >= 2 && tick % 2 === 0), "script override clock");
        }
        assert.equal(model.value(result), av ^ bv, "native XOR truth table");
        assert.equal(model.value(observed), av ^ bv, "script reads the settled native wire through its tap");
    }

    write("indexed/table.bin", Buffer.from([0, 0, 0, 0, 9, 3, 6, 12]));
    const indexed = build("indexed", write("indexed/main.flt", `
backend circuit
const Table = readFile("table.bin")
type Actor struct { Kind bits<2>; Active bit }
func selectActor(address bits<2>, lookup bits<2>, kind bits<2>) bits<5> {
    slots := [4]Actor{Actor{Kind: 0}, Actor{Kind: 1}, Actor{Kind: 2}, Actor{Kind: 3}}
    slots[int(address)] = Actor{Kind: kind, Active: true}
    actor := slots[int(lookup)]
    result := bits<5>(actor.Kind)
    signed := (int(address) << 31) >> 31
    result[2 | (signed & 1)] = actor.Active
    result[4] = Table[4 | int(address)][int(lookup)]
    return result
}
map "Indexed signals" {
    input address bits<2>
    input lookup bits<2>
    input kind bits<2>
    output selected bits<5> with { color = "yellow", bright = false } = selectActor(address, lookup, kind)
}
`));
    assert.match(indexed.report, /^selected  circuit/m);
    assert.ok(indexed.tiles.every(tile => ![22, 23, 33].includes(tile.type)));
    const selectedSymbol = indexed.ir.symbols.find(symbol => symbol.name === "selected").id;
    assert.equal(indexed.ir.ports.find(port => port.symbol === selectedSymbol).lampStyle, 3);
    const indexedModel = simulator(indexed.tiles);
    const selected = position(indexed.report, "selected");
    const lamps = [0, 1, 2, 3, 4].map(lane => ({ x: selected.x + 8 * lane, y: selected.y }));
    assert.deepEqual(lamps.map(lamp => indexedModel.tileAt(lamp).extra), [3, 3, 3, 3, 3]);
    const latency = Number(indexed.report.match(/^selected  .*?(\d+) route ticks$/m)[1]);
    const readBus = () => lamps.reduce((value, lamp, lane) => value | (indexedModel.value(lamp) << lane), 0);
    const driveBus = (held, name, value) => {
        const { x, y } = position(indexed.report, "input " + name);
        for (let lane = 0; lane < 2; lane++) held.set(`${x + 1},${y + 8 * lane}`, (value >> lane) & 1);
    };
    const trace = [];
    for (const address of [0, 1, 2, 3]) {
        for (const lookup of [0, 1, 2, 3]) {
            const kind = (address + 1) & 3;
            const held = new Map();
            driveBus(held, "address", address);
            driveBus(held, "lookup", lookup);
            driveBus(held, "kind", kind);
            const sample = (([9, 3, 6, 12][address] >> lookup) & 1) << 4;
            const activeLane = 2 | (address & 1);
            const expected = sample | (address === lookup ? kind | (1 << activeLane) : lookup);
            trace.push({ address, lookup, held, expected });
        }
    }
    for (let tick = 0; tick < latency + trace.length; tick++) {
        indexedModel.step([], trace[tick]?.held);
        if (tick >= latency) {
            const { address, lookup, expected } = trace[tick - latency];
            assert.equal(readBus(), expected, `write ${address}, read ${lookup}`);
        }
    }

    const insufficientRange = `
const Values = [3]bit{false, true, false}
map "Checked array index" {
    input address bits<2>
    output selected bit = Values[int(address)]
}
`;
    diagnostic("out-of-range-native-index", "backend circuit\n" + insufficientRange, /native index can be outside.*3 elements/i);
    const checkedIndex = build("script-index-fallback", write("index-fallback/main.flt", insufficientRange));
    assert.match(checkedIndex.report, /^selected  script.*native index can be outside/m);
    const indexModel = simulator(checkedIndex.tiles);
    const checkedAddress = position(checkedIndex.report, "input address");
    indexModel.step([], new Map([[`${checkedAddress.x + 1},${checkedAddress.y}`, 1]]));
    assert.throws(() => indexModel.step([], new Map([
        [`${checkedAddress.x + 1},${checkedAddress.y}`, 1],
        [`${checkedAddress.x + 1},${checkedAddress.y + 8}`, 1],
    ])), /index out of bounds/i);

    const memory = build("arrow-memory", write("arrow-memory/main.flt", `
macro MemoryCell(x int, y int, tint string) {
    place toggle at (x, y) facing right
    place lSplitter at (x + 1, y) facing right
    place lamp at (x + 2, y) with { color = tint, bright = true }
    place arrow at (x + 1, y + 1) facing down
    place arrow at (x + 1, y + 2) facing left
    place arrow at (x, y + 2) facing left
    place arrow at (x - 1, y + 2) facing left
    place xor at (x - 2, y + 2) facing up
    place arrow at (x - 2, y + 1) facing up
    place and at (x - 2, y) facing right
    place arrow at (x - 1, y) facing right
    place button at (x - 3, y) facing right
    place arrow at (x - 3, y + 2) facing right
}
map "Two native memory cells" {
    expand MemoryCell(0, 0, "red")
    place toggle at (-4, 2) facing right
    place button at (-5, 2) facing right
    input a bit at (-16, -16)
    input b bit at (-16, -8)
    circuit { output value bit at (60, 66) with { forward = "right" } = a ^ b }
    expand MemoryCell(64, 64, "blue")
}
`));
    assert.ok(memory.tiles.every(tile => ![22, 23, 33].includes(tile.type)));
    const memoryModel = simulator(memory.tiles);
    const stored = () => [[2, 0], [66, 64]].map(([x, y]) => memoryModel.value({ x, y }));
    function click(x, y, wait = 20) {
        memoryModel.step([`${x},${y}`]);
        for (let tick = 0; tick < wait; tick++) memoryModel.step();
    }
    assert.deepEqual(stored(), [0, 0]);
    click(-5, 2);
    assert.deepEqual(stored(), [0, 0], "changing the input alone leaves stored state unchanged");
    click(-3, 0);
    assert.deepEqual(stored(), [1, 0]);
    click(-3, 0);
    assert.deepEqual(stored(), [1, 0], "writing the same value keeps it stored");
    const settleMemory = Number(memory.report.match(/^value  .*?(\d+) route ticks$/m)[1]) + 20;
    click(-16, -16, settleMemory);
    click(61, 64);
    click(-16, -8, settleMemory);
    click(-5, 2);
    click(-3, 0);
    for (let tick = 0; tick < 256; tick++) memoryModel.step();
    assert.deepEqual(stored(), [0, 1], "both lamp pixels retain independently stored data");

    const macros = write("macros/main.flt", `package main
import geometry "caller"
import "placements"
map "Lexical expansion" {
    expand placements.Pair(geometry.Offset, 8)
    expand placements.Pair(15, -8)
}`);
    write("macros/caller/constants.flt", "package caller\nconst Offset = 5");
    write("macros/definition/constants.flt", "package definition\nconst Offset = 2");
    write("macros/placements/tiles.flt", `package placements
import geometry "definition"
macro tail(x int, y int) { place arrow at (x, y) facing left }
macro Pair(x int, y int) {
    place xor at (x, y) facing right
    expand tail(x + geometry.Offset, y)
}`);
    const expanded = build("macro-expansion", macros);
    const expected = [[5, 8, 17, 1], [7, 8, 1, 3], [15, -8, 17, 1], [17, -8, 1, 3]];
    const sortTiles = tiles => tiles.sort((left, right) => left[0] - right[0]);
    assert.deepEqual(sortTiles(expanded.tiles.map(t => [t.x, t.y, t.type, t.rotation])), expected);
    assert.deepEqual(sortTiles(expanded.ir.manualTiles.map(t => [t.position.x, t.position.y, t.type, t.rotation])), expected);

    diagnostic("circuit-default-cannot-fall-back", `backend circuit
map "Default stays native" { output value bit = currentTick() == 0 }`, /native circuit|requires script/i);
    const placement = `macro Gate(x int, y int) { place xor at (x, y) facing right }\n`;
    diagnostic("macro-argument-type", placement + 'map "Wrong type" { expand Gate(true, 2) }', /int.*bit|bit.*int/i);
    diagnostic("macro-argument-not-constant", placement + 'map "Runtime argument" { expand Gate(currentTick(), 2) }', /constant|compile.time/i);
    diagnostic("macro-argument-arity", placement + 'map "Missing argument" { expand Gate(5) }', /argument|parameter/i);
    diagnostic("recursive-macro", `macro First(x int) { expand Second(x + 1) }
macro Second(x int) { expand First(x + 1) }
map "Indirect macro cycle" { expand First(0) }`, /recurs|cycl/i);
    const circuitCall = /requires native circuit lowering|circuit.only|circuit function|native.only|circuit backend/i;
    diagnostic("circuit-function-in-script", `backend circuit
func native(value bit) bit { return !value }
map "Script calls circuit function" { input a bit; script { output out bit = native(a) } }`, circuitCall);
    write("indirect-circuit-call/gates/logic.flt", `package gates
backend circuit
func Toggle(value bit) bit { return !value }`);
    diagnostic("indirect-circuit-call", `package main
import "gates"
func wrapper(value bit) bit { return gates.Toggle(value) }
map "Script calls ordinary wrapper" { input a bit; script { output out bit = wrapper(a) } }`, circuitCall);

    const hardware = `package gates
backend circuit
type Device struct { Value bit }
func (device Device) Get() bit { return device.Value }`;
    write("unrelated-method/gates/device.flt", hardware);
    const unrelated = build("unrelated-method", write("unrelated-method/main.flt", `package main
import "gates"
type BitReader interface { Get() bit }
type TextReader interface { Get() string }
type Label struct { Text string }
func (label Label) Get() string { return label.Text }
map "Unrelated method signatures" {
    tick {
        var device BitReader = gates.Device{Value: true}
        var text TextReader = Label{Text: "read"}
        log(text.Get())
    }
}`));
    const reader = simulator(unrelated.tiles);
    reader.step();
    assert.deepEqual(reader.logs.map(row => [...row]), [["read"]]);
    write("wrapped-interface/gates/device.flt", hardware);
    diagnostic("wrapped-interface", `package main
import "gates"
type Reader interface { Get() bit }
func readValue(reader Reader) bit { return reader.Get() }
map "Script wraps native-only dispatch" {
    tick { var reader Reader = gates.Device{Value: true}; log(readValue(reader)) }
}`, circuitCall);

    const forwarded = build("forwarded-output", write("forwarded-output/main.flt", `
map "Script to manual music arrow" {
    input key bit at (-9, 10) with { key = "F" }
    script { output pulse bit at (3, 10) with { forward = "down" } = key }
    place arrow at (3, 11) facing right
    place music at (4, 11) with { note = 5 }
}`));
    for (const controllerLast of [false, true]) {
        const model = simulator(forwarded.tiles, controllerLast);
        const lamp = model.tileAt({ x: 3, y: 10 });
        assert.deepEqual([lamp.type, lamp.rotation, lamp.extra], [28, 2, 0x14]);
        const arrow = model.tileAt({ x: 3, y: 11 }), music = model.tileAt({ x: 4, y: 11 });
        assert.deepEqual([arrow.type, arrow.rotation, music.type], [1, 1, 29]);
        const pressed = t => t === 2 || t === 6;
        for (let tick = 0; tick < 12; tick++) {
            model.step([], new Map(), pressed(tick) ? [6] : []);
            assert.deepEqual([model.value(lamp), model.value(arrow), model.value(music)], [
                Number(pressed(tick - 2)), Number(pressed(tick - 3)), Number(pressed(tick - 4)),
            ], "a scripted key pulse advances to the music tile one physical hop per tick");
        }
    }
    diagnostic("forward-needs-anchor", `map "Unanchored forward" {
        input key bit
        script { output pulse bit with { forward = "down" } = key }
    }`, /position|anchor|at \(/i);
    diagnostic("forward-into-generated-output", `map "Generated outputs cannot drive each other" {
        input key bit
        script {
            output pulse bit at (3, 10) with { forward = "down" } = key
            output other bit at (3, 11) = !key
        }
    }`, /generated|manual|forward/i);
    console.log(`Indexed map: ${indexed.tiles.length} tiles, zero script tiles, ${latency} route ticks, one input per tick.`);
    console.log("Circuit backends, indexed array and file logic, native memory and lamps, IR, macros, and diagnostics passed.");
} finally {
    const target = realpathSync(scratch);
    assert.equal(path.dirname(target), scratchRoot);
    assert.match(path.basename(target), /^circuit-macros-[\w-]+$/);
    rmSync(target, { recursive: true, force: true });
}
