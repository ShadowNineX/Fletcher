import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, keyOf, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv.slice(2).find(arg => arg !== "--lab") ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "smoke-"));

function run(...args) {
    const child = spawnSync("dotnet", [cli, ...args], {
        encoding: "utf8",
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
        cwd: root,
        timeout: 15_000,
    });
    if (child.error) throw child.error;
    return child;
}

function build(name, source = path.join(root, "examples", name + ".flt"), template) {
    const output = path.join(scratch, name + ".json");
    const options = template ? ["--template", template] : [];
    const result = run("build", source, "-o", output, "--explain", ...options);
    assert.equal(result.status, 0, result.stderr);
    const wrapper = JSON.parse(readFileSync(output, "utf8"));
    const data = decode(wrapper.data);
    const preview = decode(wrapper.preview_data);
    const dataByPosition = new Map(data.map(tile => [keyOf(tile), tile]));
    for (const tile of preview) {
        const main = dataByPosition.get(keyOf(tile));
        const script = [22, 23, 33].includes(tile.type);
        assert.ok(main, "preview tile must exist in the main map");
        assert.deepEqual(tile, script ? { ...main, payload: undefined } : main);
    }
    assert.ok(preview.length > 0 || data.length === 0);
    assert.deepEqual(wrapper._preview_header_end, { version: 1, fields: 395 });
    assert.equal(wrapper.map_type, "Level");
    return { data, wrapper, report: result.stdout, output };
}

function port(report, name) {
    const row = report.split(/\r?\n/).find(line => line.startsWith(name + "  "));
    assert.ok(row, "missing port " + name);
    const [, x, y] = row.match(/ at \((-?\d+), (-?\d+)\)/);
    return { x: +x, y: +y };
}

function routeTicks(report, name) {
    const row = report.split(/\r?\n/).find(line => line.startsWith(name + "  "));
    const match = row?.match(/ (\d+) route ticks$/);
    assert.ok(match, "missing route latency for " + name);
    return Number(match[1]);
}

function footprint(tiles) {
    const columns = tiles.map(tile => tile.x);
    const rows = tiles.map(tile => tile.y);
    return [Math.max(...columns) - Math.min(...columns) + 1, Math.max(...rows) - Math.min(...rows) + 1];
}

function writeSource(name, source) {
    const file = path.join(scratch, name + ".flt");
    writeFileSync(file, source);
    return file;
}

function writeUnit(relative, source) {
    const file = path.join(scratch, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
    return file;
}

function diagnostic(name, source, expected) {
    const result = run("check", writeSource(name, source));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /\(\d+,\d+\): error:/);
    assert.match(result.stderr, expected);
}

try {
    const irSource = writeSource("ir-asset", `
const Asset = readFile("ir-asset.bin")
map "IR asset reference" { tick { log(len(Asset), Asset[currentTick()]) } }
`);
    const irAsset = path.join(scratch, "ir-asset.bin");
    const irAssetData = Buffer.from("IR_ASSET_BYTES_ARE_NOT_JSON");
    writeFileSync(irAsset, irAssetData);
    const implicitIr = path.join(scratch, "ir-asset.ir.json"), explicitIr = path.join(scratch, "explicit.ir.json");
    const plainIrCheck = run("check", irSource);
    assert.equal(plainIrCheck.status, 0, plainIrCheck.stderr);
    assert.ok(!existsSync(implicitIr), "IR generation is opt-in");
    const irCheck = run("check", irSource, "--emit-ir");
    assert.equal(irCheck.status, 0, irCheck.stderr);
    const irBuild = run("build", irSource, "-o", path.join(scratch, "ir-map.json"), "--emit-ir", explicitIr);
    assert.equal(irBuild.status, 0, irBuild.stderr);
    const ir = readFileSync(implicitIr, "utf8");
    assert.equal(ir, readFileSync(explicitIr, "utf8"), "check and build emit identical IR");
    assert.equal(JSON.parse(ir).name, "IR asset reference");
    assert.ok(ir.includes(createHash("sha256").update(irAssetData).digest("hex")), "the imported bytes are fingerprinted");
    for (const token of [irAssetData.toString(), irAssetData.toString("base64"), scratch.replaceAll("\\", "\\\\")]) {
        assert.ok(!ir.includes(token), "the dump omits asset contents and local paths");
    }
    const collision = run("check", irSource, "--emit-ir", irAsset);
    assert.equal(collision.status, 2, collision.stderr);
    assert.deepEqual(readFileSync(irAsset), irAssetData, "IR output cannot replace an imported file");
    const targetFailure = writeSource("ir-target-failure", `
map "Circuit target failure" { circuit { output value bit = currentTick() == 0 } }
`);
    const targetIr = path.join(scratch, "failed-target.ir.json");
    const failedTarget = run("check", targetFailure, "--emit-ir", targetIr);
    assert.equal(failedTarget.status, 1, failedTarget.stderr);
    assert.match(failedTarget.stderr, /currentTick\(\) requires script/);
    assert.match(readFileSync(targetIr, "utf8"), /"currentTick"/, "a target failure still emits its bound IR");
    const shortCircuit = writeSource("ir-short-circuit", `
func needsNonZero(value int) bit { return 1 / value > 0 }
map "IR logical evaluation" {
    tick {
        zero := currentTick()
        log(zero != 0 && needsNonZero(zero), zero == 0 || needsNonZero(zero))
    }
}
`);
    const logic = simulator(build("ir-short-circuit", shortCircuit).data);
    logic.step();
    assert.deepEqual(logic.logs, [[false, true]], "script logical operators skip the right operand when decided");

    const hello = build("hello-screen", path.join(root, "examples", "hello-screen", "main.flt"));
    assert.equal(hello.data.filter(tile => tile.type === 25 && tile.extra === 7).length, 45 * 7);
    assert.ok(hello.data.every(tile => tile.type !== 27), "the solid display must not contain lamp icons");
    assert.equal(hello.data.filter(tile => tile.type === 33).length, 1);
    assert.deepEqual(footprint(hello.data), [48, 7]);
    const letters = {
        H: ["#.#", "#.#", "###", "#.#", "#.#"], E: ["###", "#..", "##.", "#..", "###"],
        L: ["#..", "#..", "#..", "#..", "###"], O: [".#.", "#.#", "#.#", "#.#", ".#."],
        W: ["#.#", "#.#", "###", "###", "#.#"], R: ["##.", "#.#", "##.", "#.#", "#.#"],
        D: ["##.", "#.#", "#.#", "#.#", "##."], " ": Array(5).fill("..."),
    };
    const display = simulator(hello.data);
    const colors = ["W", "R", "B", "Y", "G", "O", "P", "."];
    function displayRow(y) {
        return Array.from({ length: 45 }, (_, x) => {
            const tile = display.tileAt({ x: x - 22, y: y - 3 });
            assert.equal(tile.type, 25);
            assert.ok(colors[tile.extra]);
            return colors[tile.extra];
        }).join("");
    }
    function assertHelloFrame() {
        for (let y = 0; y < 7; y++) {
            const expected = y === 0 || y === 6 ? ".".repeat(45) :
                "." + Array.from("HELLO WORLD", letter => letters[letter][y - 1]).join(".") + ".";
            assert.equal(displayRow(y), expected.replaceAll("#", "G"));
        }
    }
    display.step();
    assertHelloFrame();
    const textWrites = display.tileWrites;
    assert.ok(textWrites > 0);
    display.step();
    assertHelloFrame();
    assert.equal(display.tileWrites, textWrites, "an unchanged frame should require no tile writes");
    const animate = keyOf(port(hello.report, "input animate"));
    display.step([animate]);
    for (let x = 3; x < 6; x++) {
        display.step();
        const ink = x === 3 ? "B" : "Y";
        for (let y = 0; y < 7; y++) {
            const expected = y === 3 ? ".".repeat(x) + `${ink}W${ink}` + ".".repeat(42 - x) :
                y === 2 || y === 4 ? ".".repeat(x + 1) + ink + ".".repeat(43 - x) : ".".repeat(45);
            assert.equal(displayRow(y), expected, "moving pixels should recolor and clear the previous frame");
        }
    }
    display.step([animate]);
    display.step();
    assertHelloFrame();

    const raycaster = build("raycaster", path.join(root, "examples", "raycaster", "main.flt"));
    assert.equal(raycaster.data.filter(tile => tile.type === 25 && tile.extra === 7).length, 192 * 118);
    const viewCells = Array.from({ length: 192 * 108 }, (_, i) => ({ x: i % 192 - 96, y: Math.floor(i / 192) - 54 }));
    const viewFrame = sim => viewCells.map(cell => sim.tileAt(cell).extra).join("");
    const paintColors = new Set();
    const viewpoints = new Set();
    const tour = simulator(raycaster.data);
    assert.deepEqual(tour.cameraFrames, [[-105, -62, 154, 82]], "the startup camera should frame the screen and controls");
    for (let tick = 0; tick < 512; tick++) {
        tour.step();
        if (tick > 0 && tick % 2 === 0) continue;
        const frame = viewFrame(tour);
        viewpoints.add(frame);
        for (const ink of frame) paintColors.add(ink);
    }
    assert.equal(viewpoints.size, 256, "the automatic tour should render all 256 headings");
    assert.deepEqual([...paintColors].sort(), ["0", "1", "2", "3", "4", "5", "6", "7"]);

    const walk = simulator(raycaster.data);
    const viewButton = name => keyOf(port(raycaster.report, "input " + name));
    walk.step([viewButton("manual")]);
    walk.step();
    const still = viewFrame(walk);
    const stillWrites = walk.tileWrites;
    for (let tick = 0; tick < 6; tick++) walk.step();
    assert.equal(walk.tileWrites, stillWrites, "manual mode should hold the camera when controls are idle");
    walk.step([viewButton("forward")]);
    for (let tick = 0; tick < 14; tick++) walk.step();
    assert.notEqual(viewFrame(walk), still, "walking should move the camera through the maze");
    for (let tick = 0; tick < 115; tick++) walk.step();
    const atWall = viewFrame(walk);
    const atWallWrites = walk.tileWrites;
    for (let tick = 0; tick < 14; tick++) walk.step();
    assert.equal(walk.tileWrites, atWallWrites, "walking into a wall should stop the camera");
    walk.step([viewButton("forward"), viewButton("right")]);
    for (let tick = 0; tick < 70; tick++) walk.step();
    assert.ok(viewFrame(walk) !== atWall, "turning should still work beside a wall");

    assert.deepEqual(raycaster.data.filter(tile => tile.type === 21).map(tile => tile.extra).sort((a, b) => a - b), [1, 4, 19, 23]);
    const keyboard = simulator(raycaster.data);
    keyboard.step([viewButton("manual")]);
    keyboard.step();
    const beforeKey = viewFrame(keyboard);
    keyboard.step([], new Map(), [23]);
    assert.ok(viewFrame(keyboard) !== beforeKey, "W should move forward");
    keyboard.step([], new Map(), [19]);
    assert.ok(viewFrame(keyboard) === beforeKey, "S should reverse that step");
    keyboard.step([], new Map(), [1]);
    assert.ok(viewFrame(keyboard) !== beforeKey, "A should turn left");
    keyboard.step([], new Map(), [4]);
    assert.ok(viewFrame(keyboard) === beforeKey, "D should reverse that turn");

    keyboard.moveMouse(0.4, 0.5);
    keyboard.step([viewButton("mouseLook")]);
    keyboard.step();
    assert.ok(viewFrame(keyboard) === beforeKey, "enabling mouse-look should not move the view");
    keyboard.moveMouse(0.6, 0.5);
    keyboard.step();
    const turned = viewFrame(keyboard);
    assert.ok(turned !== beforeKey, "horizontal pointer movement should turn the camera");
    keyboard.moveMouse(0.95, 0.93);
    keyboard.step();
    keyboard.moveMouse(0.4, 0.5);
    keyboard.step();
    assert.ok(viewFrame(keyboard) === turned, "moving to the speed controls and back should not jump the camera");

    const heldScreen = build("held-screen", writeSource("held-screen", `
map "Hold frame" {
    screen at (0, 0) size (2, 1) with { style = "solid", hold = true }
    tick {
        if currentTick() == 0 { pixel(0, 0, true) }
        if currentTick() == 2 { pixel(0, 0, false) }
    }
}
`));
    const heldDisplay = simulator(heldScreen.data);
    for (const [color, writes] of [[4, 1], [4, 1], [7, 2]]) {
        heldDisplay.step();
        assert.equal(heldDisplay.tileAt({ x: 0, y: 0 }).extra, color);
        assert.equal(heldDisplay.tileWrites, writes);
    }

    const wideScreen = build("wide-screen", writeSource("wide-screen", `
map "320x200 solid frame" {
    screen at (-160, -100) size (320, 200) with { style = "solid", hold = true, slice = true }
    tick { pixel(319, 199, true, color.Green) }
}
`));
    assert.equal(wideScreen.data.filter(tile => tile.type === 25).length, 64_000);
    const wideDisplay = simulator(wideScreen.data);
    wideDisplay.step();
    assert.equal(wideDisplay.tileAt({ x: 159, y: 99 }).extra, 4, "the last cell of a 320x200 screen is drawable");

    const registerMap = build("register-values", writeSource("register-values", `
const Initial = [2]int{9, 11}
type Position struct {
    X int
}
type Actor struct {
    Location Position
    History [2]int
}
map "Register values" {
    register actor Actor = Actor{Location: Position{X: 4}, History: [2]int{5, 8}}
    register history [2]int = Initial
    tick {
        candidate := actor
        candidate.Location.X = candidate.Location.X + 10
        candidate.History[0] = candidate.History[0] + 1
        next actor = candidate
        if currentTick() != 2 { next history = candidate.History }
        candidate.Location.X = 999
        candidate.History[0] = 999
        if currentTick() == 1 {
            next actor = Actor{Location: Position{X: 42}, History: [2]int{20, 30}}
        }
        log(actor.Location.X, actor.History[0], actor.History[1], history[0], history[1])
    }
}
`));
    const persistent = simulator(registerMap.data);
    for (let i = 0; i < 4; i++) persistent.step();
    assert.deepEqual(JSON.parse(JSON.stringify(persistent.logs)), [
        [4, 5, 8, 9, 11], [14, 6, 8, 6, 8], [42, 20, 30, 7, 8], [52, 21, 30, 7, 8],
    ], "registers preserve the old value within a tick and snapshot each staged update");

    writeUnit("resource-registers/first.bin", Buffer.from([17, 0]));
    writeUnit("resource-registers/second.bin", Buffer.from([29]));
    const resourceMap = build("resource-registers", writeUnit("resource-registers/main.flt", `
const First = readFile("first.bin")
const Second = readFile("second.bin")
type Reader interface {
    Read() int
    Write() int
}
type Sample struct { Values [2]int }
func (sample Sample) Read() int { return sample.Values[0] }
func (sample Sample) Write() int {
    if true {
        for i := range 1 { sample.Values[i] = 99 }
    }
    return sample.Values[0]
}
type Resource struct {
    File bytes
    View Reader
}
map "Resource register snapshots" {
    register resource Resource = Resource{File: First, View: Sample{Values: [2]int{2, 3}}}
    tick {
        sample := Sample{Values: [2]int{currentTick() + 10, 0}}
        var boxed Reader = sample
        candidate := resource
        candidate.View = boxed
        candidate.File = Second
        next resource = candidate
        sample.Values[0] = 45
        candidate.File = First
        log(resource.View.Read(), resource.View.Write(), resource.View.Read(),
            len(resource.File), resource.File[0], boxed.Read(), sample.Values[0])
    }
}
`));
    const resources = simulator(resourceMap.data, true);
    for (let tick = 0; tick < 3; tick++) resources.step();
    assert.deepEqual(JSON.parse(JSON.stringify(resources.logs)), [
        [2, 99, 2, 2, 17, 10, 45], [10, 99, 10, 1, 29, 11, 45], [11, 99, 11, 1, 29, 12, 45],
    ], "bytes and boxed concrete values survive register updates without aliasing");

    writeUnit("file-identity/first.bin", Buffer.from([7]));
    writeUnit("file-identity/second.bin", Buffer.from([7]));
    writeUnit("file-identity/empty-first.bin", Buffer.alloc(0));
    writeUnit("file-identity/empty-second.bin", Buffer.alloc(0));
    const identityMap = build("file-identity", writeUnit("file-identity/main.flt", `
const First = readFile("first.bin")
const FirstAgain = readFile("first.bin")
const Second = readFile("second.bin")
const EmptyFirst = readFile("empty-first.bin")
const EmptySecond = readFile("empty-second.bin")
map "File identity" { tick { log(sameFile(First, FirstAgain), sameFile(First, Second), sameFile(EmptyFirst, EmptySecond)) } }
`));
    const identity = simulator(identityMap.data);
    identity.step();
    assert.deepEqual(JSON.parse(JSON.stringify(identity.logs)), [[true, false, true]],
        "sameFile identifies immutable import snapshots without comparing their contents");

    const slicedProgram = `
type Task interface { Work() int }
type Worker struct { Count int }
func (worker Worker) Work() int {
    total := 0
    for range worker.Count { total = total + 1 }
    return total
}
map "Sliced work" {
    screen at (0, 0) size (2, 1) with { style = "solid", hold = true, slice = true }
    input button bit at (-5, 1) with { key = "F" }
    register saved int = 0
    script { output ready bit = saved == 0 }
    tick {
        next saved = saved + 1
        log("starting", currentTick())
        if currentTick() == 0 { pixel(0, 0, true, color.Blue) }
        var task Task = Worker{Count: 4100}
        work := task.Work()
        if currentTick() == 0 { pixel(1, 0, true, color.Green) }
        log(currentTick(), saved, work, button, mouseX())
    }
}
`;
    const slicedMap = build("sliced-work", writeSource("sliced-work", slicedProgram));
    const slicedDriver = slicedMap.data.find(tile => tile.type === 22 && tile.payload?.toString().includes("__fletcherEven"));
    assert.ok(slicedDriver, "the sliced output uses the usual frame driver");
    for (const controllerLast of [false, true]) {
        const running = simulator(slicedMap.data, controllerLast);
        const signal = port(slicedMap.report, "ready");
        running.moveMouse(0.25, 0.10);
        running.step([], new Map(), [6]);
        assert.equal(running.tileWrites, 0, "a yielded frame must not paint its first pixel");
        assert.equal(running.logs.length, 0, "logs belong to the completed logical tick");
        assert.equal(running.value(signal), 0);
        running.moveMouse(0.75, 0.10);
        running.step();
        assert.equal(running.tileWrites, 2, "both pixels commit after resumption");
        assert.equal(running.tileAt({ x: 0, y: 0 }).extra, 2);
        assert.equal(running.tileAt({ x: 1, y: 0 }).extra, 4);
        running.step();
        assert.equal(running.value(slicedDriver), 1, "driver sees the first completed output");
        assert.equal(running.value(signal), 0, "the lamp has one more hop");
        running.step();
        assert.equal(running.value(signal), 1, "the last output publishes during an unfinished tick");
        assert.equal(running.tileWrites, 2, "hold retains the completed frame across a tick with no pixels");
        assert.deepEqual(JSON.parse(JSON.stringify(running.logs)), [
            ["starting", 0], [0, 0, 4100, true, 256], ["starting", 1], [1, 1, 4100, false, 768],
        ], "logical time, register reads, and external inputs remain stable across slices");
        running.step();
        assert.equal(running.value(slicedDriver), 0, "the next committed output arrives through the normal driver");
        running.step();
        assert.equal(running.value(signal), 0);
    }
    const discontinuous = simulator(slicedMap.data);
    discontinuous.moveMouse(0.25, 0.10);
    discontinuous.step([], new Map(), [6]);
    discontinuous.setTick(7);
    discontinuous.moveMouse(0.5, 0.10);
    discontinuous.step();
    assert.equal(discontinuous.tileWrites, 0, "a skipped host tick discards pending work");
    discontinuous.step();
    assert.deepEqual(JSON.parse(JSON.stringify(discontinuous.logs)), [["starting", 0], [0, 0, 4100, false, 512]]);

    const resultProgram = `
type Pair struct { Values [2]int }
type Twins struct { Left Pair; Right Pair }

func fresh(first int) Pair { return Pair{Values: [2]int{first, 4}} }
func changed(pair Pair) Pair { pair.Values[0] = 7; return pair }
func pick(pair Pair, independent bit) Pair {
    if independent { return Pair{Values: [2]int{8, 9}} }
    return pair
}
func twins(pair Pair) Twins {
    local := pair
    return Twins{Left: local, Right: local}
}
func firstOf(pairs [1]Pair) Pair {
    for _, pair := range pairs { return pair }
    return Pair{}
}
func values(pair Pair) [2]int { local := pair; return local.Values }
func twice(pair Pair) (Pair, Pair) { local := pair; return local, local }

map "Returned snapshots" {
    tick {
        original := fresh(2)
        modified := changed(original)
        modified.Values[1] = 19
        borrowed := pick(original, false)
        borrowed.Values[0] = 21
        slots := twins(original)
        slots.Left.Values[1] = 23
        pairs := [1]Pair{original}
        element := firstOf(pairs)
        element.Values[1] = 26
        nested := values(original)
        nested[0] = 31
        left, right := twice(original)
        left.Values[1] = 32
        log(original.Values[0], original.Values[1], modified.Values[0], modified.Values[1],
            borrowed.Values[0], slots.Left.Values[1], slots.Right.Values[1], element.Values[1], pairs[0].Values[1],
            nested[0], left.Values[1], right.Values[1])
    }
}
`;
    const resultCopies = build("returned-snapshots", writeSource("returned-snapshots", resultProgram));
    const resultScript = resultCopies.data.find(tile => tile.payload?.includes("function __f"))?.payload.toString() ?? "";
    assert.match(resultScript, /const __t\d+ = __f\d+\(2\);/, "a freshly allocated result enters its caller without a copy");
    const copiedResults = simulator(resultCopies.data);
    copiedResults.step();
    const snapshots = [[2, 4, 7, 19, 21, 23, 4, 26, 4, 31, 32, 4]];
    assert.deepEqual(copiedResults.logs, snapshots,
        "owned results transfer, while borrowed branches, shared fields, and array elements preserve snapshots");

    const slicedResults = resultProgram
        .replace('map "Returned snapshots" {', 'map "Sliced returned snapshots" {\n    screen at (0, 0) size (1, 1) with { style = "solid", slice = true }')
        .replace("func changed(pair Pair) Pair {", "func changed(pair Pair) Pair {\n    for range 4100 {}\n   ");
    const slicedSnapshots = simulator(build("sliced-returned-snapshots", writeSource("sliced-returned-snapshots", slicedResults)).data);
    slicedSnapshots.step();
    assert.deepEqual(slicedSnapshots.logs, [], "the owned result can suspend before returning");
    slicedSnapshots.step();
    assert.deepEqual(slicedSnapshots.logs, snapshots, "resuming a composite return preserves snapshot semantics");

    const slicedCalls = build("sliced-call-entry", writeSource("sliced-call-entry", `
type Source interface { Value() int }
type Reading struct { Number int }
func (reading Reading) Value() int { return reading.Number }
func readClock() int { return hostTimeMillis() }
func collect(first int, second int) (int, int, int) { return first, second, hostTimeMillis() }

map "Sliced call entry" {
    screen at (0, 0) size (1, 1) with { style = "solid", slice = true }
    tick {
        var source Source = Reading{Number: 7}
        for range 4095 {}
        first, second, body := collect(hostTimeMillis(), readClock())
        log(first, second, body, source.Value(), Reading{Number: 9}.Value())
    }
    host tick { log("host", readClock()) }
}
`));
    const callController = slicedCalls.data.find(tile => tile.payload?.includes("function* __tick()"));
    assert.match(callController?.payload.toString() ?? "", /function __f\d+\([^)]*\) \{\s*--__budget;/,
        "a straight-line function uses the direct sliced path");
    const calls = simulator(slicedCalls.data, false, undefined, tick => 1000 + tick * 100);
    calls.step();
    assert.deepEqual(calls.logs, [["host", 1000]], "the nested argument spends the last slot before the outer body runs");
    calls.step();
    assert.deepEqual(calls.logs, [["host", 1000], [1000, 1000, 1100, 7, 9], ["host", 1100]],
        "resumption retains evaluated arguments and both interface and concrete calls work");

    const bufferedMap = build("buffered-sliced-work", writeSource("buffered-sliced-work",
        slicedProgram.replace('key = "F" }', 'key = "F", buffer = true }')));
    const buffered = simulator(bufferedMap.data);
    buffered.step();
    buffered.step([], new Map(), [6]);
    buffered.step();
    assert.equal(buffered.logs.length, 2, "the first logical tick completes after its slices");
    assert.equal(buffered.logs[1][3], false, "a buffered key pressed during a slice belongs to the next logical tick");
    buffered.step();
    assert.equal(buffered.logs.at(-1)[3], true, "a buffered key pulse survives until the next snapshot");
    buffered.step([], new Map(), [6]);
    buffered.setTick(20);
    buffered.step();
    buffered.step();
    assert.equal(buffered.logs.at(-1)[3], false, "a host-tick discontinuity clears a pending buffered key");

    const keyId = [6, 17, 18, 23, 4];
    const groupedSource = slicedProgram
        .replace('input button bit at (-5, 1) with { key = "F" }', [
            'input button bit at (-5, 1) with { key = "F", buffer = true }',
            'input strafe bit at (-5, 4) with { key = "Q", buffer = true }',
            'input fire bit at (-5, 7) with { key = "R", buffer = true }',
            'input forward bit at (-5, 10) with { key = "W", buffer = true }',
            'input right bit at (-5, 13) with { key = "D", buffer = true }',
        ].join("\n    "))
        .replace("log(currentTick(), saved, work, button, mouseX())",
            "log(currentTick(), button, strafe, fire, forward, right)");
    const groupedMap = build("grouped-keys", writeSource("grouped-keys", groupedSource));
    const gate = groupedMap.data.find(tile => tile.type === 10);
    assert.ok(gate, "buffered keyboard groups use a physical OR gate");
    const adjacentKeys = groupedMap.data.filter(tile => tile.type === 21 &&
        Math.abs(tile.x - gate.x) + Math.abs(tile.y - gate.y) === 1);
    assert.deepEqual(adjacentKeys.map(tile => tile.extra).sort((a, b) => a - b), keyId.slice(0, 4),
        "the four original key IDs drive the native group");
    const grouped = simulator(groupedMap.data);
    const keyMask = mask => keyId.filter((_, bit) => (mask & (1 << bit)) !== 0);
    const groupedExpected = [];
    let pendingMask = 0;
    for (let logical = 0; logical < 32; logical++) {
        const boundaryMask = logical === 0 ? 0 : logical ^ 7;
        const slicedMask = logical ^ 16;
        grouped.step([], new Map(), keyMask(boundaryMask));
        grouped.step([], new Map(), keyMask(slicedMask));
        groupedExpected.push([logical, ...keyId.map((_, bit) => ((pendingMask | boundaryMask) & (1 << bit)) !== 0)]);
        pendingMask = slicedMask;
    }
    grouped.setTick(100);
    grouped.step([], new Map(), [23]);
    grouped.step();
    groupedExpected.push([32, false, false, false, true, false]);
    assert.deepEqual(grouped.logs.filter(row => row.length === 6), groupedExpected,
        "grouped keys preserve same-slice, buffered, combined and reset samples");

    const unslicedMap = build("unsliced-work", writeSource("unsliced-work", slicedProgram.replace("slice = true", "slice = false")));
    const unsliced = simulator(unslicedMap.data);
    unsliced.step();
    assert.equal(unsliced.logs[1][2], 4100, "unsliced work finishes in the same host callback");

    const busProgram = `
map "Mixed output drivers" {
    screen at (0, 0) size (1, 1) with { style = "solid", slice = true }
    input incoming bit at (27, 2) with { key = "F" }
    register packets [2]bits<3> = [2]bits<3>{0, 5}
    script {
        output word bits<3> at (4, 2) = packets[1]
        output phase bit at (4, 5) = currentTick() % 2 == 0
        output guarded bit at (30, 2) = currentTick() < 0
    }
    tick { next packets = [2]bits<3>{0, bits<3>(currentTick() + 6)} }
}`;
    const bus = build("sliced-output-bus", writeSource("sliced-output-bus", busProgram));
    const plainBus = build("unsliced-output-bus", writeSource("unsliced-output-bus", busProgram.replace("slice = true", "slice = false")));
    const lamps = [{ x: 4, y: 2 }, { x: 12, y: 2 }, { x: 20, y: 2 }, { x: 4, y: 5 }, { x: 30, y: 2 }];
    const drivers = lamps.map(({ x, y }) => ({ x: x - 1, y }));
    assert.equal(bus.data.length, plainBus.data.length, "batching reuses the output driver positions");
    for (const controllerLast of [false, true]) {
        let reads = 0;
        const circuit = simulator(bus.data, controllerLast, key => {
            if (key === "__fletcherEven" || key === "__fletcherOdd") reads++;
        });
        const plain = simulator(plainBus.data, controllerLast);
        assert.deepEqual(drivers.map(pos => circuit.tileAt(pos).type), [22, 1, 1, 1, 22],
            "one Script Source drives the isolated lanes; the incoming keyboard arrow keeps its neighbor a Script Source");
        assert.deepEqual(drivers.map(pos => plain.tileAt(pos).type), [22, 22, 22, 22, 22]);
        assert.ok(drivers.every(pos => circuit.tileAt(pos).rotation === 1), "each driver faces its adjacent lamp");
        assert.ok(lamps.every(pos => circuit.tileAt(pos).type === 27 && circuit.tileAt(pos).extra === 0x14));
        for (let tick = 0; tick < 14; tick++) {
            const keys = tick === 5 ? [6] : [];
            circuit.step([], new Map(), keys);
            plain.step([], new Map(), keys);
            const logical = tick - 2;
            const word = logical < 0 ? 0 : (logical + 5) & 7;
            const expected = [word & 1, (word >>> 1) & 1, (word >>> 2) & 1, Number(logical >= 0 && logical % 2 === 0), 0];
            assert.deepEqual(lamps.map(pos => circuit.value(pos)), expected, "sliced lamps at host tick " + tick);
            assert.deepEqual(lamps.map(pos => plain.value(pos)), expected, "unsliced lamps at host tick " + tick);
            assert.equal(reads, tick * 2, "one previous-frame read for the batch and one for the guarded driver");
        }
    }

    const preservedMap = build("sliced-preserve-screen", writeSource("sliced-preserve-screen", `
map "Sliced preserve screen" {
    screen at (0, 0) size (2, 1) with { style = "solid", hold = true, slice = true }
    tick {
        if currentTick() == 0 { pixel(0, 0, true, color.Blue) }
        if currentTick() == 1 {
            preserveScreen()
            pixel(1, 0, true, color.Green)
        }
    }
}
`));
    const preserved = simulator(preservedMap.data);
    preserved.step();
    assert.equal(preserved.tileAt({ x: 0, y: 0 }).extra, 2, "the initial sliced frame commits");
    preserved.step();
    assert.equal(preserved.tileAt({ x: 0, y: 0 }).extra, 2, "preserveScreen retains the prior committed color");
    assert.equal(preserved.tileAt({ x: 1, y: 0 }).extra, 4, "the overlay is added to the preserved sliced frame");
    const meltMap = build("sliced-screen-reveal", writeSource("sliced-screen-reveal", `
map "Sliced screen reveal" {
    screen at (0, 0) size (2, 2) with { style = "solid", hold = true, slice = true }
    register start string = ""
    register end string = ""
    tick {
        if currentTick() == 0 {
            pixel(0, 0, true, color.Blue)
            pixel(1, 0, true, color.Blue)
            pixel(0, 1, true, color.Blue)
            pixel(1, 1, true, color.Blue)
            next start = captureScreen(false)
        }
        if currentTick() == 1 {
            pixel(0, 0, true, color.Green)
            pixel(1, 0, true, color.Green)
            pixel(0, 1, true, color.Green)
            pixel(1, 1, true, color.Green)
            next end = captureScreen(false)
        }
        if currentTick() == 2 { revealScreen(start, end, [1]int{1}, 2) }
    }
}
`));
    const melt = simulator(meltMap.data);
    melt.step(); melt.step(); melt.step();
    assert.equal(melt.tileAt({ x: 0, y: 0 }).extra, 4, "the reveal uses the destination above each column split");
    assert.equal(melt.tileAt({ x: 1, y: 1 }).extra, 2, "the reveal scrolls the source below each column split");
    const longTickMap = build("long-logical-tick", writeSource("long-logical-tick", `
map "Long logical tick" {
    screen at (0, 0) size (1, 1) with { style = "solid", slice = true }
    tick {
        pixel(0, 0, true)
        total := 0
        for range 2000001 { total = total + 1 }
        log(total)
    }
}
`));
    const longTick = simulator(longTickMap.data);
    for (let i = 0; i < 488; i++) longTick.step();
    assert.equal(longTick.tileWrites, 0, "long logical ticks keep their pixels staged");
    longTick.step();
    assert.equal(longTick.tileWrites, 1, "long logical ticks still commit");
    assert.equal(longTick.logs[0][0], 2000001);

    const repaint = build("repaint", writeSource("repaint", `
map "In-place repaint" {
    screen at (0, 0) size (2, 1) with { style = "solid" }
    place wall at (-1, 0) with { color = "red" }
    tick {
        pixel(-1, 0, true, color.White)
        pixel(1, 0, true, color.Orange)
        pixel(1, 0, false)
        if currentTick() == 0 {
            pixel(0, 0, true, color.Blue)
        } else {
            pixel(0, 0, true, color.Purple)
        }
    }
}
`));
    const paint = simulator(repaint.data);
    for (const [color, writes] of [[2, 1], [6, 2], [6, 2]]) {
        paint.step();
        assert.equal(paint.tileAt({ x: -1, y: 0 }).extra, 1, "clipping must leave adjacent cells alone");
        assert.equal(paint.tileAt({ x: 0, y: 0 }).extra, color);
        assert.equal(paint.tileAt({ x: 1, y: 0 }).extra, 7, "the last pixel call in a frame wins");
        assert.equal(paint.tileWrites, writes);
    }

    const clip = build("clip", writeSource("clip", `
map "Pixel clipping" {
    screen at (-2, 8) size (2, 2) with { color = "blue" }
    place lamp at (-3, 8)
    tick {
        pixel(-1, 0, true)
        pixel(1, 1, currentTick() % 2 == 1)
    }
}
`));
    const clipSim = simulator(clip.data);
    for (let frame = 0; frame < 3; frame++) {
        clipSim.step();
        assert.equal(clipSim.value({ x: -3, y: 8 }), 0);
        assert.equal(clipSim.value({ x: -1, y: 9 }), frame % 2 ? 2 : 0);
    }

    const packageEntry = writeUnit("packages/main.flt", `package main
import (
    a "lib/left"
    "lib/right"
)
map "Package symbols" {
    output lamp bit = helper() & a.Id<bit>(a.Make<bit>{Value: right.Value}.Get())
    output word bits<a.Width> = 1
}
`);
    writeUnit("packages/other.flt", `package main
import a "lib/right"
func helper() bit { return a.Value }
`);
    writeUnit("packages/lib/left/types.flt", `package left
import "common"
const Width = common.Width
type Make<T> struct { Value T }
func (box Make<T>) Get() T { return box.Value }
`);
    writeUnit("packages/lib/left/function.flt", `package left
const hidden = false
func Id<T>(value T) T { return value }
`);
    writeUnit("packages/lib/right/other.flt", `package right
import "common"
const Value = common.Width == 2
func Id<T>(value T) T { return value }
`);
    writeUnit("packages/common/base.flt", `package common
const Width = 2
`);
    const packages = build("packages", packageEntry);
    assert.match(packages.report, /lamp  circuit/);
    assert.match(packages.report, /word  circuit/);
    const packageSim = simulator(packages.data);
    for (let tick = 0; tick < 200; tick++) packageSim.step();
    assert.equal(packageSim.value(port(packages.report, "lamp")), 1);
    const word = port(packages.report, "word");
    assert.equal(packageSim.value(word), 1);
    assert.equal(packageSim.value({ x: word.x + 8, y: word.y }), 0);
    const external = writeUnit("package-app/main.flt", `package main
import "lib/right"
map "Shared package root" { output lamp bit = right.Id(right.Value) }
`);
    assert.equal(run("check", external, "--package-root", path.dirname(packageEntry)).status, 0);

    const manyFilesEntry = writeUnit("many-files/main.flt", `package main
import "part0"
map "Many package files" { tick { log(part0.Value) } }
`);
    const depth = 129;
    for (let index = 0; index < depth; index++) {
        const imported = "part" + (index + 1);
        const declaration = index === depth - 1 ? "const Value = 31" : `import "${imported}"\nconst Value = ${imported}.Value`;
        writeUnit(`many-files/part${index}/part.flt`, `package part${index}\n${declaration}\n`);
    }
    for (let index = depth + 1; index <= 1024; index++) {
        writeUnit(`many-files/part0/extra${index}.flt`, "package part0\n");
    }
    const manyFiles = simulator(build("many-files", manyFilesEntry).data);
    manyFiles.step();
    assert.equal(manyFiles.logs[0][0], 31);

    const invalidPackageEntry = writeUnit("invalid-package/main.flt", `package main
import "library"
map "Bad library" { output lamp bit = library.On() }
`);
    const invalidLibrary = writeUnit("invalid-package/library/lib.flt", `package library

func On() bit { return "wrong" }
`);
    const invalidPackage = run("check", invalidPackageEntry);
    assert.equal(invalidPackage.status, 1);
    assert.ok(invalidPackage.stderr.includes(`${invalidLibrary}(3,24): error:`), invalidPackage.stderr);
    assert.match(invalidPackage.stderr, /Cannot use 'string' as 'bit'/);

    const cycleEntry = writeUnit("package-cycle/main.flt", `package main
import "first"
map "Cycle" {}
`);
    writeUnit("package-cycle/first/a.flt", `package first
import "second"
`);
    writeUnit("package-cycle/second/b.flt", `package second
import "first"
`);
    const cycle = run("check", cycleEntry);
    assert.equal(cycle.status, 1);
    assert.match(cycle.stderr, /Import cycle through 'first'/);

    const privateEntry = writeUnit("private-package/main.flt", `package main
import "library"
map "Privacy" {
    output top bit = library.hidden
    script { output member bit = library.Box{hidden: true}.hidden }
}
`);
    writeUnit("private-package/library/lib.flt", `package library
const hidden = true
type Box struct { hidden bit }
`);
    const privateResult = run("check", privateEntry);
    assert.equal(privateResult.status, 1);
    assert.match(privateResult.stderr, /'hidden' is not exported by package 'library'/);
    assert.match(privateResult.stderr, /Field 'hidden' of 'library.Box' is not exported/);

    const macros = Array.from({ length: 65 }, (_, index) => `macro part${index}() { expand part${index + 1}() }`).join("\n");
    const deepMacro = build("deep-macro", writeSource("deep-macro", `
${macros}
macro part65() { place wall at (1, 2) }
map "Deep macro" { expand part0() }
`));
    assert.deepEqual(deepMacro.data.map(tile => [tile.x, tile.y]), [[1, 2]]);
    diagnostic("recursive-macro", `
macro a() { expand b() }
macro b() { expand a() }
map "Recursive macro" { expand a() }
`, /Macro 'a' is recursive/);

    diagnostic("typed-constant", `const Value int = 1
map "Typed constant" { output word bits<4> = Value }
`, /Cannot use 'int' as 'bits<4>'/);
    diagnostic("type-pixel", `map "Invalid pixel" {
    screen at (0, 0) size (2, 2)
    tick { pixel(0, 0, "on") }
}
`, /Cannot use 'string' as 'bit'/);
    diagnostic("screen-color", `map "Unlit color" { screen at (0, 0) size (2, 2) with { color = "white" } }
`, /Screen color must be red, blue, yellow, green, orange, or purple/);
    diagnostic("pixel-color-type", `map "Invalid pixel color" {
    screen at (0, 0) size (2, 2) with { style = "solid" }
    tick { pixel(0, 0, true, "blue") }
}
`, /Cannot use 'string' as 'color'/);
    diagnostic("pixel-color-lamp", `map "Lamp pixel color" {
    screen at (0, 0) size (2, 2)
    tick { pixel(0, 0, true, color.Blue) }
}
`, /A per-pixel color requires a solid screen/);
    diagnostic("missing-screen", `map "Missing screen" { tick { pixel(0, 0, true) } }
`, /pixel requires a screen declaration/);
    diagnostic("type-generic", `func same<T>(a T, b T) T { return a }
map "Invalid generic invocation" { output lamp bit = same(true, 1) }
`, /Conflicting types for 'T'/);
    diagnostic("type-assignment", `type Row int
type Column int
map "Distinct types" { tick { var r Row = 0; var c Column = r } }
`, /Cannot use 'Row' as 'Column'/);

    const half = build("half-adder");
    assert.match(half.report, /2 native gates/);
    assert.match(half.report, /sum  circuit/);
    assert.ok(half.data.length <= 45, `half-adder regressed to ${half.data.length} tiles`);
    assert.deepEqual(footprint(half.data), [12, 17]);
    assert.ok(!half.data.some(tile => tile.payload), "half-adder must use only native tiles");
    assert.ok(half.data.some(tile => tile.type === 10), "the native layout should include a blue crossing");
    assert.ok(half.data.some(tile => tile.type === 11), "the native layout should fold corners into diagonals");
    assert.ok(half.data.some(tile => tile.type === 13), "the native layout should shorten a branch with a blue splitter");
    const a = port(half.report, "input a");
    const b = port(half.report, "input b");
    const sum = port(half.report, "sum");
    const carry = port(half.report, "carry");
    for (let inputs = 0; inputs < 4; inputs++) {
        const sim = simulator(half.data);
        sim.step([], new Map([[(a.x + 1) + "," + a.y, inputs & 1], [(b.x + 1) + "," + b.y, (inputs >>> 1) & 1]]));
        const sums = [], carries = [];
        for (let i = 0; i < 800; i++) {
            sim.step([], new Map([[(a.x + 1) + "," + a.y, 0], [(b.x + 1) + "," + b.y, 0]]));
            if (sim.value(sum)) sums.push(i + 1);
            if (sim.value(carry)) carries.push(i + 1);
        }
        assert.deepEqual(sums, inputs === 1 || inputs === 2 ? [routeTicks(half.report, "sum")] : [],
            "half-adder sum for a one-tick pulse");
        assert.deepEqual(carries, inputs === 3 ? [routeTicks(half.report, "carry")] : [],
            "half-adder carry for simultaneous one-tick pulses");
    }

    const reduced = build("reduced", writeSource("reduced", `
map "Redundant gates" {
    input a bit at (0, 0)
    input b bit
    circuit {
        output lamp bit = !!(((a & (a | b)) ^ b) ^ b)
    }
}
`));
    assert.match(reduced.report, /0 native gates, 5 tiles/);
    assert.deepEqual(port(reduced.report, "lamp"), { x: 2, y: 0 });
    assert.equal(routeTicks(reduced.report, "lamp"), 1);
    const reducedSim = simulator(reduced.data);
    reducedSim.step([], new Map([["1,0", 1]]));
    reducedSim.step([], new Map([["1,0", 0]]));
    assert.equal(reducedSim.value({ x: 2, y: 0 }), 1);
    reducedSim.step();
    assert.equal(reducedSim.value({ x: 2, y: 0 }), 0);

    const factored = build("factored", writeSource("factored", `
map "Shared factor" {
    input a bit
    input b bit
    input c bit
    circuit {
        output lamp bit = (a & b) | (a & c)
    }
}
`));
    assert.match(factored.report, /2 native gates/);
    const factors = ["a", "b", "c"].map(name => port(factored.report, "input " + name));
    const factoredLamp = port(factored.report, "lamp");
    const factoredTicks = routeTicks(factored.report, "lamp");
    for (let word = 0; word < 8; word++) {
        const sim = simulator(factored.data);
        const launch = value => new Map(factors.map(({ x, y }, bit) => [`${x + 1},${y}`, (value >>> bit) & 1]));
        sim.step([], launch(word));
        for (let tick = 1; tick <= factoredTicks + 1; tick++) {
            sim.step([], launch(0));
            const expected = tick === factoredTicks && (word & 1) !== 0 && (word & 6) !== 0;
            assert.equal(sim.value(factoredLamp), Number(expected));
        }
    }

    const shared = build("shared-terms", writeSource("shared-terms", `
map "Shared terms" {
    input a bit
    input b bit
    input c bit
    circuit {
        wire left bit = a & b
        wire right bit = a & c
        output first bit = left
        output second bit = right
        output combined bit = left | right
    }
}
`));
    assert.match(shared.report, /3 native gates/, "factoring must account for other consumers of the terms");

    const vector = build("vector", writeSource("vector", `
const Width = 2
const Row = 8
map "Vector latency" {
    input values bits<Width> at (0, Row)
    circuit {
        output lamps bits<Width> = values
    }
}
`));
    const laneButton = port(vector.report, "input values");
    const laneLamp = port(vector.report, "lamps");
    const vectorSim = simulator(vector.data);
    const first = (laneButton.x + 1) + "," + laneButton.y;
    const second = (laneButton.x + 1) + "," + (laneButton.y + 8);
    vectorSim.step([], new Map([[first, 1], [second, 1]]));
    let pulses = 0;
    for (let i = 0; i < 200; i++) {
        vectorSim.step([], new Map([[first, 0], [second, 0]]));
        const low = vectorSim.value(laneLamp);
        const high = vectorSim.value({ x: laneLamp.x + 8, y: laneLamp.y });
        assert.equal(low, high, "live lanes must arrive in the same tick");
        pulses += low;
    }
    assert.equal(pulses, 1);

    const vectorTap = build("vector-tap", writeSource("vector-tap", `
map "Sampled vector" {
    input values bits<2>
    circuit { wire tap bits<2> = values }
    register saved bits<2> = 0
    tick { next saved = tap }
    script { output lamps bits<2> = saved }
}
`));
    const tapInput = port(vectorTap.report, "input values");
    const tapLamp = port(vectorTap.report, "tap");
    const tapLanes = [tapLamp, { x: tapLamp.x + 8, y: tapLamp.y }];
    const vectorTapSim = simulator(vectorTap.data);
    const forceTap = value => new Map([0, 8].map(offset => [`${tapInput.x + 1},${tapInput.y + offset}`, value]));
    assert.equal(routeTicks(vectorTap.report, "tap"), 79);
    vectorTapSim.step([], forceTap(1));
    for (let tick = 1; tick <= 80; tick++) {
        vectorTapSim.step([], forceTap(0));
        const expected = Number(tick === 79);
        assert.deepEqual(tapLanes.map(lane => vectorTapSim.value(lane)), [expected, expected]);
    }

    const auto = build("auto", writeSource("auto", `
map "Automatic fallback" {
    input a bit
    output lamp bit at (-8, 0) = a
}
`));
    assert.match(auto.report, /lamp  script  \(placement:/);
    const autoSim = simulator(auto.data);
    autoSim.step([keyOf(port(auto.report, "input a"))]);
    for (let i = 0; i < 10; i++) autoSim.step();
    assert.equal(autoSim.value(port(auto.report, "lamp")), 1);

    const counter = build("counter");
    assert.match(counter.report, /lamps  script/);
    assert.deepEqual(footprint(counter.data), [26, 2], "script outputs should use the first available row");
    const runButton = keyOf(port(counter.report, "input run"));
    const lamp = port(counter.report, "lamps");
    const trace = controllerLast => {
        const sim = simulator(counter.data, controllerLast);
        return Array.from({ length: 22 }, (_, tick) => {
            sim.step(tick === 0 ? [runButton] : []);
            return Array.from({ length: 4 }, (_, lane) => sim.value({ x: lamp.x + 8 * lane, y: lamp.y }) << lane)
                .reduce((left, right) => left | right);
        });
    };
    const counts = trace(false);
    assert.deepEqual(counts, trace(true), "script frames are independent of callback order");
    const active = counts.slice(counts.indexOf(1));
    assert.ok(active.length >= 17);
    assert.deepEqual(active, active.map((_, index) => (index + 1) & 15), "counter increments once per tick and wraps");

    const increments = 2400;
    const total = increments * (increments + 1) / 2;
    const splitProgram = body => `
const Sample = readFile("sample.bin")
func advance(value int) int {
    ${body}
    return value
}
map "Automatic script splitting" {
    screen at (0, 0) size (1, 1) with { style = "solid" }
    register count int = 2
    script { output even bit = count % 2 == 0 }
    tick {
        value := advance(count)
        log(value, Sample[currentTick() % len(Sample)], mouseX(), mouseY(), "🔧")
        pixel(0, 0, value % 2 == 0, color.Green)
        next count = count + 1
    }
}
`;
    writeUnit("split/sample.bin", Buffer.from([17, 43]));
    const compact = build("compact-controller", writeUnit("split/compact.flt", splitProgram(`value = value + ${total}`)));
    const split = build("split-controller", writeUnit("split/full.flt", splitProgram(
        Array.from({ length: increments }, (_, index) => `value = value + ${index + 1}`).join("\n"))));
    const fragments = split.data.filter(tile => tile.type === 33 &&
        /^onStart\(\(\) => \{ globalState\["__fletcherCode\d+"\] =/.test(tile.payload.toString()));
    assert.ok(fragments.length >= 2, "oversized code uses automatically placed Script Blocks");
    assert.ok(split.data.filter(tile => tile.payload).every(tile => tile.payload.length <= 65535));
    assert.equal(Buffer.from(split.wrapper.data, "base64")[2], 1, "the split map body stays compressed");

    const splitTrace = (map, controllerLast, reversed) => {
        const sim = simulator(reversed ? [...map.data].reverse() : map.data, controllerLast);
        sim.moveMouse(0.25, 0.75);
        return Array.from({ length: 5 }, () => {
            sim.step();
            return [
                ...sim.logs.at(-1),
                sim.tileAt({ x: 0, y: 0 }).extra,
                sim.value(port(map.report, "even")),
            ];
        });
    };
    const compactTrace = splitTrace(compact, false, false);
    assert.deepEqual(compactTrace[0], [total + 2, 17, 256, 768, "🔧", 4, 0]);
    assert.deepEqual(splitTrace(split, false, false), compactTrace);
    assert.deepEqual(splitTrace(split, true, true), compactTrace);
    const incomplete = simulator(split.data.filter(tile => tile !== fragments[0]));
    assert.throws(() => incomplete.step(), /Missing Fletcher code tile/);

    const hybrid = build("hybrid");
    assert.ok(hybrid.data.length <= 250, `hybrid map regressed to ${hybrid.data.length} tiles`);
    assert.deepEqual(footprint(hybrid.data), [97, 65], "the packed delay line should fit within the fixed tiles");
    assert.match(hybrid.report, /different  circuit/);
    assert.match(hybrid.report, /enabled  script/);
    assert.match(hybrid.report, /indicator  circuit  at \(92, 64\)/);
    assert.match(hybrid.report, /Circuit to script samples: different/);
    assert.ok(hybrid.data.some(tile => tile.type === 25 && tile.x === -4 && tile.extra === 0x12));
    assert.equal(routeTicks(hybrid.report, "different"), 141);
    const hybridTap = port(hybrid.report, "different");
    for (const name of ["input a", "input b"]) {
        const input = port(hybrid.report, name);
        const drive = `${input.x + 1},${input.y}`;
        const pulse = simulator(hybrid.data);
        pulse.step([], new Map([[drive, 1]]));
        for (let tick = 1; tick <= 142; tick++) {
            pulse.step([], new Map([[drive, 0]]));
            assert.equal(pulse.value(hybridTap), Number(tick === 141), `${name} tap pulse at tick ${tick}`);
        }
    }
    const sim = simulator(hybrid.data);
    const button = keyOf(port(hybrid.report, "input a"));
    const output = port(hybrid.report, "indicator");
    sim.step([button]);
    for (let i = 0; i < 800; i++) sim.step();
    assert.equal(sim.value(output), 1, "native XOR drives script register, which drives native AND");
    sim.step([button]);
    for (let i = 0; i < 800; i++) sim.step();
    assert.equal(sim.value(output), 0, "native AND responds to the other input after settling");

    const types = build("types", writeSource("types", `
type Switches<T> struct {
    values [3]T
}

func (s Switches<T>) Middle() T {
    return s.values[1]
}

func pick<T>(values [3]T, fallback T) T {
    var selected T = fallback
    for i, value := range values {
        if i == 1 {
            selected, previous := value, selected
            _ = previous
            return selected
        }
    }
    return selected
}

map "Types" {
    script {
        output selected bit = pick([3]bit{false, true, false}, false)
        output middle bit = Switches<bit>{values: [3]bit{false, true, false}}.Middle()
    }
}
`));
    const ts = simulator(types.data);
    for (let i = 0; i < 10; i++) ts.step();
    assert.equal(ts.value(port(types.report, "selected")), 1);
    assert.equal(ts.value(port(types.report, "middle")), 1);

    const selections = build("selections", writeSource("selections", `
const Table = [3]int{11, 22, 33}
const First = Table[0]

func pick(index int) int {
    switch index {
    case 0, 1:
        n := Table[index]
        return n
    default:
        n := -1
        return n
    }
}

func classify(value bits<2>) bit {
    result := false
    switch value {
    default:
        result = false
    case 1, 2:
        active := true
        result = active
    }
    return result
}

map "Switch and lookup" {
    input selector bits<2>
    circuit { output selected bit = classify(selector) }
    tick {
        copy := Table
        copy[0] = -1
        switch currentTick() % 3 {
        case 0, 1: log(pick(currentTick() % 3), copy[0], First)
        default: log(pick(2))
        }
    }
}
`));
    const selectionSource = selections.data.find(tile => tile.type === 33).payload.toString("utf8");
    assert.equal(selectionSource.match(/Object\.freeze\(\[11, 22, 33\]\)/g)?.length, 1);
    assert.match(selectionSource, /switch\s*\(/);
    const selectInput = port(selections.report, "input selector");
    const selectOutput = port(selections.report, "selected");
    for (let value = 0; value < 4; value++) {
        const selectSim = simulator(selections.data);
        const levels = new Map([0, 1].map(lane => [`${selectInput.x + 1},${selectInput.y + lane * 8}`, (value >> lane) & 1]));
        for (let tick = 0; tick < 190; tick++) selectSim.step([], levels);
        assert.equal(selectSim.value(selectOutput), Number(value === 1 || value === 2));
        assert.deepEqual(JSON.parse(JSON.stringify(selectSim.logs.slice(0, 3))), [[11, -1, 11], [22, -1, 11], [-1]]);
    }
    diagnostic("duplicate-case", `map "Duplicate case" { tick { switch 1 { case 1: log(1); case 1 + 0: log(2) } } }`, /Duplicate case/);
    diagnostic("duplicate-default", `map "Duplicate default" { tick { switch 1 { default: log(1); default: log(2) } } }`, /only one default/);
    diagnostic("dynamic-case", `map "Dynamic case" { tick { switch 1 { case currentTick(): log(1) } } }`, /compile-time constant/);
    diagnostic("nonconstant-table", `const Table = [1]int{currentTick()}\nmap "Dynamic table" {}`, /compile-time constant/);

    const translatedPath = path.join(scratch, "translated-c", "cport", "kernel.flt");
    const sourcePath = path.join(root, "tests", "fixtures", "portable-c.c");
    const translated = run("transpile-c", sourcePath, "-o", translatedPath);
    assert.equal(translated.status, 0, translated.stderr);
    const generatedSource = readFileSync(translatedPath, "utf8");
    for (const [name, source, expected] of [
        ["pointer", "int read(int *p) { return *p; }", /Unsupported C syntax/],
        ["loop-limit", "int count(int n) { for (int i = 0; i < n; ++i) n--; return n; }", /active loop limit/],
        ["recursive", "int again(void) { return again(); }", /Recursive call/],
    ]) {
        const original = path.join(scratch, `${name}.c`);
        writeFileSync(original, source);
        const rejected = run("transpile-c", original, "-o", translatedPath);
        assert.equal(rejected.status, 1, rejected.stderr);
        assert.match(rejected.stderr, /\(\d+,\d+\): error:/);
        assert.match(rejected.stderr, expected);
        assert.equal(readFileSync(translatedPath, "utf8"), generatedSource, "failed translation must preserve existing output");
    }
    const translatedMap = build("translated-c", writeUnit("translated-c/main.flt", `
package main

import "cport"

map "Portable C" {
    tick {
        log(cport.C_shade(6, 8), cport.C_shade(2, -7), cport.C_shade(0, 2), cport.C_shade(9, 0))
        log(cport.C_mix(0, -1), cport.C_mix(0xDEADBEEF, 255), cport.C_mix(0xFFFFFFFF, -1))
        log(cport.C_guarded(0), cport.C_guarded(7), cport.C_guarded(12))
        log(cport.C_shadow(5), cport.C_shadow(-1))
        log(cport.C_precedence(3, 2), cport.C_precedence(3, 4), cport.C_precedence(0xFFFFFFFF, 4))
        log(cport.C_large_array(0), cport.C_large_array(1), cport.C_large_array(8191))
    }
}
`));
    const translatedSimulation = simulator(translatedMap.data);
    translatedSimulation.step();
    // These rows also come from running the original fixture compiled as C17 with GCC.
    assert.deepEqual(JSON.parse(JSON.stringify(translatedSimulation.logs)), [
        [5, 21, 0, -1], [2582904806, 114300957, 0], [0, 1, 0], [50, 0], [1, 0, 1], [7, 0, 31],
    ]);

    diagnostic("cycles", `map "Cycle" {
    wire x bit = y
    wire y bit = x
    output lamp bit = x
}`, /Combinational cycle/);
    diagnostic("types-invalid", `map "Invalid" {
    output lamp bit = 12
}`, /Cannot use 'int' as 'bit'/);
    diagnostic("overlap", `map "Overlap" {
    input a bit at (0, 0)
    place lamp at (1, 0)
}`, /overlap/);
    diagnostic("bad-range", `map "Bad range" {
    tick {
        for index := range true {}
    }
}`, /range requires/);
    diagnostic("duplicate-short", `map "Duplicate local" {
    tick {
        count := 1
        count := 2
    }
}`, /requires at least one new name/);
    diagnostic("forced-script", `map "Forced circuit" {
    circuit {
        output lamp bit = currentTick() == 1
    }
}`, /requires a native circuit/);

    const publishedReader = `always(() => {
        const tick = world.getTick() - 1;
        const frame = tick % 2 === 0 ? globalState.__fletcherEven : globalState.__fletcherOdd;
        const packet = tick >= 0 && frame?.t === tick ? frame.p?.packet : undefined;
        log(packet?.[0] ?? -1, packet?.[1] ?? -1);
    });`;
    for (const sliced of [false, true]) {
        const name = sliced ? "published-sliced" : "published";
        const source = writeSource(name, `map "Shared packets" {
    ${sliced ? 'screen at (0, 0) size (1, 1) with { style = "solid", slice = true }' : ""}
    register count int = 0
    publish packet [2]bits<8> = [2]bits<8>{bits<8>(count), bits<8>(255 - count)}
    place scriptSource at (10, 1) with { code = ${JSON.stringify(publishedReader)} }
    tick {
        ${sliced ? "for range 4100 {}" : ""}
        next count = count + 1
    }
}`);
        const publishedMap = build(name, source);
        assert.equal(publishedMap.data.filter(tile => tile.type === 22).length, 1, "only the explicit reader is a Script Source");
        assert.ok(publishedMap.data.every(tile => ![23, 27, 28].includes(tile.type)), "a published signal needs no physical bus");
        for (const controllerLast of [false, true]) {
            const running = simulator(publishedMap.data, controllerLast);
            for (let tick = 0; tick < 6; tick++) running.step();
            const expected = sliced ? [[-1, -1], [-1, -1], [0, 255], [0, 255], [1, 254], [1, 254]]
                : [[-1, -1], [0, 255], [1, 254], [2, 253], [3, 252], [4, 251]];
            assert.deepEqual(running.logs, expected, "the last complete shared packet is independent of callback order");
            running.setTick(40);
            running.step();
            assert.deepEqual(running.logs.at(-1), [-1, -1], "the reader ignores stale frames after a tick discontinuity");
        }
        const irPath = path.join(scratch, name + ".ir.json");
        const checked = run("check", source, "--emit-ir", irPath);
        assert.equal(checked.status, 0, checked.stderr);
        const ir = JSON.parse(readFileSync(irPath, "utf8"));
        assert.ok(ir.bindings.some(binding => binding.published && binding.backend === "Script"));
    }
    diagnostic("published-bad-type", `map "Bad published type" { publish text string = "hello" }`, /requires a bit, bits<N>, or a fixed array/);
    diagnostic("published-forced-circuit", `map "Bad published backend" { circuit { publish packet bit = true } }`, /requires the script backend/);

    const dualClock = writeSource("host-clock", `
func clock() (int, int) { return currentTick(), hostTimeMillis() }
map "Host clock" {
    screen at (0, 0) size (1, 1) with { style = "solid", slice = true }
    register frames int = 0
    register notes int = 0
    publish scene bits<8> = bits<8>(frames)
    publish host packet [2]bits<8> = [2]bits<8>{bits<8>(notes), bits<8>(frames)}
    place scriptSource at (10, 1) with { code = ${JSON.stringify(publishedReader)} }
    tick {
        start := notes
        for range 8200 {}
        next frames = frames + 1
        log("game", currentTick(), start, notes)
    }
    host tick {
        for range 5000 {}
        sampled, wall := clock()
        log("host", sampled, wall, notes, frames)
        next notes = notes + 1
    }
}`);
    const hostLayout = build("host-clock", dualClock);
    for (const controllerLast of [false, true]) {
        const running = simulator(hostLayout.data, controllerLast, undefined, tick => 200 + tick * 10);
        for (let tick = 0; tick < 6; tick++) running.step();
        assert.deepEqual(running.logs.filter(([tag]) => tag === "host"), [
            ["host", 0, 200, 0, 0], ["host", 1, 210, 1, 0], ["host", 2, 220, 2, 1],
            ["host", 3, 230, 3, 1], ["host", 4, 240, 4, 1], ["host", 5, 250, 5, 2],
        ], "the host handler sees each host tick and the latest logical commit");
        assert.deepEqual(running.logs.filter(([tag]) => tag === "game"), [["game", 0, 0, 0], ["game", 1, 3, 3]],
            "a suspended logical tick retains its register snapshot and logical time");
        assert.deepEqual(running.logs.filter(([tag]) => typeof tag === "number"), [[-1, -1], [0, 0], [1, 0], [2, 1], [3, 1], [4, 1]],
            "the host publishes during renderer yields without callback-order dependence");
    }
    const hostIr = path.join(scratch, "host-clock.ir.json");
    assert.equal(run("check", dualClock, "--emit-ir", hostIr).status, 0);
    const hostProgram = JSON.parse(readFileSync(hostIr, "utf8"));
    assert.ok(hostProgram.hostTick && hostProgram.bindings.some(binding => binding.hostPublished));
    diagnostic("unsliced-host-tick", `map "Unsliced" { host tick {} }`, /require a sliced solid screen/);
    diagnostic("double-register-writer", `map "Two writers" {
    screen at (0, 0) size (1, 1) with { style = "solid", slice = true }
    register count int = 0
    tick { next count = 1 }
    host tick { next count = 2 }
}`, /cannot be written by both tick and host tick/);
    diagnostic("host-drawing", `func draw() { pixel(0, 0, true) }
map "Host drawing" {
    screen at (0, 0) size (1, 1) with { style = "solid", slice = true }
    host tick { draw() }
}`, /cannot use the screen or pointer/);

    for (const [style, width, height, tileType] of [["solid", 320, 240, 25], ["lamp", 80, 60, 27]]) {
        const name = `large-${style}-screen`;
        const layout = build(name, writeSource(name, `map "Large screen" {
    screen at (-3, -2) size (${width}, ${height}) with { style = "${style}" }
    place source at (${width}, ${height})
}`));
        assert.equal(layout.data.length, width * height + 1);
        assert.equal(layout.data.filter(tile => tile.type === tileType).length, width * height);
        assert.ok(layout.data.some(tile => tile.x === width && tile.y === height && tile.type === 2));
    }
    const longRoute = build("long-native-route", writeSource("long-native-route", `map "Long native route" {
    input launch bit at (0, 0)
    circuit { output lit bit at (70000, 16) = launch }
}`));
    assert.deepEqual(port(longRoute.report, "lit"), { x: 70000, y: 16 });
    assert.ok(longRoute.data.every(tile => ![22, 23, 33].includes(tile.type)), "a long route stays native");

    const largerCircuit = build("large-native-elaboration", writeSource("large-native-elaboration", `
func elaborate(a bits<32>, b bits<32>) bit {
    total := a
    for range 80 { total = total + b }
    for range 2200 {}
    return a[0] ^ b[0]
}
map "Large native elaboration" {
    input a bits<32>
    input b bits<32>
    circuit { output lit bit = elaborate(a, b) }
}`));
    assert.match(largerCircuit.report, /1 native gates/);
    assert.ok(largerCircuit.data.every(tile => ![22, 23, 33].includes(tile.type)));

    const openRow = build("placement-after-occupied-rows", writeSource("placement-after-occupied-rows", `
map "Placement after occupied rows" {
    screen at (-16, 0) size (1, 8193) with { style = "solid" }
    script { output lit bit = true }
}`));
    assert.deepEqual(port(openRow.report, "lit"), { x: -16, y: 8193 });

    const arrayMap = build("larger-array", writeSource("larger-array", `
map "Large array" {
    tick {
        var data [8192]int
        offset := 8191 - currentTick()
        data[offset] = 31
        log(data[0], data[offset])
    }
}`));
    const largeArray = simulator(arrayMap.data);
    largeArray.step();
    assert.deepEqual(Array.from(largeArray.logs[0]), [0, 31]);

    const widths = build("numeric-script-widths", writeSource("numeric-script-widths", `
map "Numeric script widths" {
    register shift int = 0
    tick {
        maximum := 2147483647
        minimum := -2147483648
        full := bits<32>(-1)
        narrow := bits<31>(-1)
        values := [2]int{41, 9}
        var flags bits<32>
        flags[31] = true
        values[1] = 7
        log(minimum >> shift, minimum | 1, maximum * 2, maximum + 1, ~maximum,
            full >> shift, full | flags, full & flags, full ^ flags,
            narrow | bits<31>(1), narrow >> shift, bits<3>(-1), bits<3>(narrow) << 2,
            values[shift], values[1], flags[31], flags[shift])
        next shift = shift + 1
    }
}`));
    const widthScript = widths.data.find(tile => tile.type === 33).payload.toString();
    assert.doesNotMatch(widthScript, /__index\(\d+,/, "fixed literal indexes are checked at compile time");
    assert.match(widthScript, />>> __index\([^,]+, 32\)/, "dynamic bit indexes still have a runtime guard");
    const widthSim = simulator(widths.data);
    widthSim.step();
    widthSim.step();
    assert.deepEqual(widthSim.logs.map(row => Array.from(row)), [
        [-2147483648, -2147483647, -2, -2147483648, -2147483648,
            4294967295, 4294967295, 2147483648, 2147483647, 2147483647, 2147483647, 7, 4, 41, 7, true, false],
        [-1073741824, -2147483647, -2, -2147483648, -2147483648,
            2147483647, 4294967295, 2147483648, 2147483647, 2147483647, 1073741823, 7, 4, 7, 7, true, false],
    ]);
    assert.throws(() => widthSim.step(), /index out of bounds: 2/);

    diagnostic("too-many-screen-chunks", `map "Too many chunks" {
    screen at (0, 0) size (4096, 4096) with { style = "solid" }
}`, /v5 limit of 65[.,\s]?535 chunks/);
    diagnostic("too-many-screen-bytes", `map "Too many bytes" {
    screen at (0, 0) size (2200, 2000)
}`, /game allows at most 16 MiB/);

    const largeImport = Buffer.alloc(16 * 1024 * 1024 + 1);
    largeImport[0] = 71;
    largeImport[largeImport.length - 1] = 37;
    writeFileSync(path.join(scratch, "large-compressible.bin"), largeImport);
    const packed = build("large-packed-file", writeSource("large-packed-file", `const File = readFile("large-compressible.bin")
map "Packed file" {
    register offset int = 0
    tick {
        log(len(File), int(File[offset]))
        next offset = len(File) - 1
    }
}`));
    const packedSim = simulator(packed.data);
    packedSim.step();
    packedSim.step();
    assert.deepEqual(packedSim.logs, [[largeImport.length, 71], [largeImport.length, 37]], "the limit applies to packed output bytes");

    const lab = process.env.APPDATA && path.join(process.env.APPDATA, "logic-arrows", "save", "maps", "Logic_Arrows_Component_Lab.json");
    if (lab && process.argv.includes("--lab")) {
        const nativeWrapper = JSON.parse(readFileSync(lab, "utf8"));
        for (const [field, flag] of [["data", []], ["preview_data", ["--preview"]]]) {
            const inspection = run("inspect", lab, ...flag);
            assert.equal(inspection.status, 0, inspection.stderr);
            const expected = decode(nativeWrapper[field])
                .sort((a, b) => a.y - b.y || a.x - b.x)
                .map(({ payload, ...tile }) => payload === undefined ? tile : { ...tile, payload_hex: payload.toString("hex") });
            assert.deepEqual(JSON.parse(inspection.stdout), expected);
        }
        const custom = build("template", path.join(root, "examples", "counter.flt"), lab).wrapper;
        assert.deepEqual(Object.keys(custom), Object.keys(nativeWrapper));
        assert.deepEqual(custom.level_settings, nativeWrapper.level_settings);
    }

    console.log("Fletcher smoke tests passed.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
