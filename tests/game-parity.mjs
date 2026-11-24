import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

// Build disposable Level maps which compare the running game against the
// offline simulator. A probe samples before it applies this tick's stimulus.
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Release/net11.0/fletcher.dll");
const output = path.resolve(root, process.argv[3] ?? "artifacts/game-parity");
const probe = { x: -30, y: -12 };
mkdirSync(output, { recursive: true });

function compile(id, source) {
    const input = path.join(output, id + ".flt");
    const map = path.join(output, id + ".json");
    writeFileSync(input, source);
    const result = spawnSync("dotnet", [cli, "build", input, "-o", map, "--explain"], {
        cwd: root,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
        encoding: "utf8",
        timeout: 15_000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return { map, report: result.stdout, data: decode(JSON.parse(readFileSync(map, "utf8")).data) };
}

function nameMap(source, title) {
    return source.replace(/\bmap\s+"[^"]+"/, 'map "' + title + '"');
}

function instrument(source, code) {
    return source.replace(/\}\s*$/, `    place scriptBlock at (${probe.x}, ${probe.y}) with { code = ${JSON.stringify(code)} }
}
`);
}

function example(id) {
    return readFileSync(path.join(root, "examples", id + ".flt"), "utf8");
}

function port(report, label) {
    const row = report.split(/\r?\n/).find(line => line.startsWith(label + "  "));
    assert.ok(row, "missing port " + label);
    const [, x, y] = row.match(/ at \((-?\d+), (-?\d+)\)/);
    return { x: +x, y: +y };
}

function offset(position, x, y = 0) {
    return { x: position.x + x, y: position.y + y };
}

function wire(position) {
    return offset(position, 2);
}

function held(position) {
    return offset(position, 1);
}

function findTile(data, type) {
    const tiles = data.filter(tile => tile.type === type);
    assert.equal(tiles.length, 1, "expected one tile of type " + type);
    return { x: tiles[0].x, y: tiles[0].y };
}

function observe(name, tile) {
    return { name, tile };
}

function drive(at, ...tiles) {
    return [at, tiles];
}

function estimate(tiles, samples, events, ticks, controllerLast) {
    const model = simulator(tiles, controllerLast);
    let trace = "";
    for (let t = 0; t < ticks; t++) {
        model.step();
        const mask = samples.reduce((bits, sample, index) => bits | (Number(model.value(sample.tile) > 0) << index), 0);
        trace += mask.toString(16).padStart(2, "0");
        for (const tile of events[t] ?? [])
            model.drive(tile, 1);
    }
    return trace;
}

function gameProbe(title, samples, events, expected, driveArrows) {
    return `const labels = ${JSON.stringify(samples.map(sample => sample.name))};
const sample = ${JSON.stringify(samples.map(({ tile }) => [tile.x, tile.y]))};
const events = ${JSON.stringify(Object.fromEntries(Object.entries(events).map(([t, tiles]) => [t, tiles.map(tile => [tile.x, tile.y])])))};
const expected = ${JSON.stringify(expected)};
const driveArrows = ${JSON.stringify(driveArrows.map(tile => [tile.x, tile.y]))};
const ticks = expected.length / 2;

onStart(() => {
    // Drive the circuit through ordinary arrows. This exercises the game's
    // receiving logic, including the blue activation phase of jump arrows.
    for (const [x, y] of driveArrows) world.setArrow(x, y, 1, 1, false, 0);
});

always(() => {
    if (state.result) return;
    const now = world.getTick();
    if (state.start === undefined) {
        state.start = now;
        for (const [x, y] of driveArrows) {
            const arrow = world.getArrow(x, y);
            if (arrow?.type === 1 && arrow.rotation === 1) continue;
            state.result = 'FAIL test setup: drive arrow missing at ' + x + ', ' + y;
            showText(state.result);
            return;
        }
    }
    const t = now - state.start;
    const observedTicks = (state.observedTicks || 0) + 1;
    state.observedTicks = observedTicks;
    if (observedTicks !== t + 1) {
        state.result = 'FAIL probe missed tick ' + (observedTicks - 1);
        showText(state.result);
        return;
    }
    let got = 0;
    for (let i = 0; i < sample.length; i++) {
        if (world.getSignal(sample[i][0], sample[i][1]) > 0) got |= 1 << i;
    }
    const want = parseInt(expected.slice(t * 2, t * 2 + 2), 16);
    if (got !== want) {
        state.failures = (state.failures || 0) + 1;
        if (!state.first) {
            const names = labels.filter((_, i) => ((want ^ got) & (1 << i)) !== 0);
            state.first = 'Tick ' + t + ' expected 0x' + want.toString(16) + ' got 0x' + got.toString(16) + ' (' + names.join(', ') + ')';
        }
    }
    for (const [x, y] of events[t] || []) world.setSignal(x, y, 1);
    if (t + 1 >= ticks) {
        const count = ticks * sample.length;
        state.result = state.failures
            ? 'FAIL ' + state.failures + ' of ' + ticks + ' ticks. ' + state.first
            : 'PASS ' + ticks + ' ticks, ' + count + ' signal samples.';
        showText(${JSON.stringify("**" + title + "** --- ")} + state.result);
        log(state.result);
    }
});`;
}

function make(id, title, source, fixture) {
    const named = nameMap(source, title);
    const stub = compile(id, instrument(named, ""));
    const { samples, stimuli, ticks, driveArrows = [] } = fixture(stub);
    const events = Object.fromEntries(stimuli);
    assert.ok(samples.length <= 8);
    const plainTiles = stub.data.map(tile => driveArrows.some(driver => tile.x === driver.x && tile.y === driver.y)
        ? { ...tile, type: 1 } : tile);
    const expected = estimate(plainTiles, samples, events, ticks, false);
    assert.equal(expected, estimate(plainTiles, samples, events, ticks, true), title + " must be independent of controller order");
    const ready = compile(id, instrument(named, gameProbe(title, samples, events, expected, driveArrows)));
    assert.equal(ready.report, stub.report, "the probe must leave placement and latency unchanged");
    const withoutProbe = tiles => tiles.filter(tile => tile.x !== probe.x || tile.y !== probe.y);
    assert.deepEqual(withoutProbe(ready.data), withoutProbe(stub.data));
    console.log(`${ready.map} — ${ticks} ticks, ${samples.length} signals`);
}

make("native", "Fletcher Parity Native", example("half-adder"), ({ report, data }) => {
    const a = port(report, "input a");
    const b = port(report, "input b");
    return {
        samples: [
            observe("input A", wire(a)), observe("input B", wire(b)),
            observe("native XOR", findTile(data, 17)), observe("native AND", findTile(data, 16)),
            observe("sum lamp", port(report, "sum")), observe("carry lamp", port(report, "carry")),
        ],
        stimuli: [[2, a], [180, b], [360, a, b], [540, a], [541, b], [700, b], [701, a]]
            .map(([tick, ...inputs]) => drive(tick, ...inputs.map(held))),
        driveArrows: [held(a), held(b)],
        ticks: 870,
    };
});

make("vector", "Fletcher Parity Vector", `map "Vector" {
    input lanes bits<2>
    circuit { output lamps bits<2> = lanes }
}
`, ({ report }) => {
    const input = port(report, "input lanes");
    const other = offset(input, 0, 8);
    const output = port(report, "lamps");
    return {
        samples: [observe("low drive", wire(input)), observe("high drive", wire(other)), observe("low lamp", output), observe("high lamp", offset(output, 8))],
        stimuli: [[2, input, other], [100, input], [200, other], [301, input], [302, other]]
            .map(([tick, ...inputs]) => drive(tick, ...inputs.map(held))),
        driveArrows: [held(input), held(other)],
        ticks: 410,
    };
});

make("script", "Fletcher Parity Script", example("counter"), ({ report }) => {
    const input = port(report, "input run");
    const lamp = port(report, "lamps");
    return {
        samples: [observe("run toggle", held(input)), ...Array.from({ length: 4 }, (_, lane) => observe("counter bit " + lane, offset(lamp, lane * 8)))],
        stimuli: [drive(2, input), drive(24, input), drive(32, input), drive(52, input)],
        driveArrows: [input],
        ticks: 60,
    };
});

make("hybrid", "Fletcher Parity Hybrid", example("hybrid"), ({ report, data }) => {
    const a = port(report, "input a");
    const b = port(report, "input b");
    const source = findTile(data, 22);
    return {
        samples: [
            observe("A toggle", held(a)), observe("B toggle", held(b)),
            observe("native-to-script tap", port(report, "different")),
            observe("script-to-native first wire", offset(source, 1)),
            observe("hybrid lamp", port(report, "indicator")),
        ],
        stimuli: [drive(2, a), drive(330, b), drive(660, a), drive(990, b)],
        driveArrows: [a, b],
        ticks: 1330,
    };
});

const increments = 2400;
const sum = increments * (increments + 1) / 2;
const splitSource = `const Sample = readFile("split-parity.bin")
func advance(value int) int {
    ${Array.from({ length: increments }, (_, index) => `value = value + ${index + 1}`).join("\n    ")}
    return value
}
map "Fletcher Parity Split" {
    screen at (0, 0) size (2, 1) with { style = "solid", slice = true }
    input confirm bit at (-8, 2) with { key = "B", buffer = true }
    register rows [6]bits<32> = [6]bits<32>{}
    publish sample [6]bits<32> = rows
    tick {
        clock := currentTick()
        value := advance(clock + 2)
        for range 8300 {}
        key := 0
        if confirm { key = 1 }
        next rows = [6]bits<32>{bits<32>(clock + 1), bits<32>(value), bits<32>(Sample[clock % len(Sample)]),
            bits<32>(mouseX() + 1), bits<32>(mouseY() + 1), bits<32>(key)}
        pixel(0, 0, value % 2 == 0, color.Green)
    }
}`;

const splitProbe = `
onStart(() => {
    game.focusCamera(-34, -16, 15, 12);
    const key = "__fletcherSplitParitySessions";
    globalState[key] = (globalState[key] ?? 0) + 1;
    state.session = globalState[key];
    const candidates = [globalThis, game, world, Object.getPrototypeOf(game), Object.getPrototypeOf(world)];
    const related = new Set(candidates.flatMap(object => object ? Object.getOwnPropertyNames(object) : [])
        .filter(name => /mouse|button|storage|save|pcm|sound|audio/i.test(name)));
    log("split-capabilities", [...related].sort().join(", "));
});
always(() => {
    if (state.done) return;
    const tick = world.getTick() - 1;
    const frame = tick % 2 === 0 ? globalState.__fletcherEven : globalState.__fletcherOdd;
    const row = tick >= 0 && frame?.t === tick ? frame.p?.sample : undefined;
    if (!row?.[0] || state.logical === row[0]) return;
    const [logical, actual, sample, mouseX, mouseY, key] = row;
    if (logical !== (state.logical ?? 0) + 1 || actual !== ${sum} + logical + 1 || sample !== (logical % 2 ? 17 : 43)) {
        state.done = true;
        finish("FAIL | logical " + logical + " | call " + actual + " | file " + sample);
        return;
    }
    state.logical = logical;
    if (logical === 1) finish("READY | reset at logical tic 0 | session " + state.session + " | move the mouse and press B");
    state.key = state.key || key === 1;
    if (mouseX && mouseY) {
        const point = mouseX + "," + mouseY;
        if (state.point && state.point !== point) state.moved = true;
        state.point = point;
    }
    if (logical >= 3 && state.key && state.moved) {
        state.done = true;
        finish("PASS | reset at logical tic 0 | " + logical + " split calls | file bytes, B and mouse verified | session " + state.session);
    }
});
function finish(result) {
    log(result);
    if (typeof showText === "function") showText("Split controller " + result);
}`;

writeFileSync(path.join(output, "split-parity.bin"), Buffer.from([17, 43]));
const split = compile("split", instrument(splitSource, splitProbe));
const parts = split.data.flatMap(tile => {
    const match = /^onStart\(\(\) => \{ globalState\["__fletcherCode(\d+)"\] = (.*); \}\);$/.exec(tile.payload?.toString() ?? "");
    return match ? [[Number(match[1]), JSON.parse(match[2])]] : [];
}).sort(([left], [right]) => left - right).map(([, body]) => body);
assert.ok(parts.length > 1);
assert.match(parts[0], /function\* __f0\(/);
assert.ok(parts.join("").indexOf("yield* __f0(") >= parts[0].length, "the caller and helper are stored in different blocks");
for (const controllerLast of [false, true]) {
    const model = simulator(split.data, controllerLast);
    model.moveMouse(0.25, 0.25);
    for (let t = 0; t < 32; t++) {
        if (t === 10) model.moveMouse(0.75, 0.75);
        model.step([], new Map(), t === 2 ? [2] : []);
    }
    assert.ok(model.logs.some(([line]) => line.startsWith("PASS | reset at logical tic 0")), JSON.stringify(model.logs));
}
console.log(`${split.map} — ${parts.length} controller fragments, keyboard and mouse`);
