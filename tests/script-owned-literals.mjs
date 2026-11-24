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
const scratch = mkdtempSync(path.join(scratchRoot, "owned-literals-"));

function build(name, source) {
    const input = path.join(scratch, name + ".flt"), output = path.join(scratch, name + ".json");
    writeFileSync(input, source);
    const result = spawnSync("dotnet", [cli, "build", input, "-o", output], { encoding: "utf8", timeout: 15000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return decode(JSON.parse(readFileSync(output, "utf8")).data);
}

try {
    for (const sliced of [false, true]) {
        const screen = `screen at (0, 0) size (1, 1) with { style = "solid", slice = ${sliced} }`;
        const fresh = build(`fresh-${sliced}`, `
type Row struct { Values [2]int }
type Grid struct { Rows [2]Row }
map "Independent rows" {
    ${screen}
    tick {
        grid := Grid{Rows: [2]Row{Row{Values: [2]int{currentTick() + 2, 3}}, Row{}}}
        grid.Rows[1].Values[0] = 7
        log(grid.Rows[0].Values[0], grid.Rows[1].Values[0])
    }
}`);
        const controller = fresh.find(tile => tile.type === 33).payload.toString();
        assert.doesNotMatch(controller, /function __copy\d+\(/, "fully fresh nested literals need no aggregate copier");
        const independent = simulator(fresh);
        independent.step();
        assert.deepEqual([...independent.logs[0]], [2, 7]);

        const aliases = build(`aliases-${sliced}`, `
const Table = [2]int{11, 12}
type Reader interface { Read() int }
type Pair struct { Left [2]int; Right [2]int }
type Outer struct { Rows [2]Pair }
func (pair Pair) Read() int { return pair.Left[0] }
func fromCall(row [2]int) [2]int {
    for range ${sliced ? 4100 : 1} {}
    return row
}
map "Borrowed literal fields" {
    ${screen}
    register saved Pair = Pair{}
    tick {
        source := Table
        var boxed Reader = Pair{Left: source, Right: source}
        outer := Outer{Rows: [2]Pair{Pair{Left: source, Right: fromCall(source)}, Pair{Left: Table}}}
        next saved = Pair{Left: outer.Rows[0].Left, Right: outer.Rows[0].Right}
        source[0] = 22
        outer.Rows[0].Left[0] = 33
        outer.Rows[1].Left[0] = 44
        log(outer.Rows[0].Left[0], outer.Rows[0].Right[0], outer.Rows[1].Left[0], outer.Rows[1].Right[0],
            source[0], Table[0], boxed.Read(), saved.Left[0], saved.Right[0])
    }
}`);
        const snapshots = simulator(aliases);
        snapshots.step();
        if (sliced) assert.equal(snapshots.logs.length, 0, "the borrowed field call suspended before the literal was published");
        for (let tick = 0; snapshots.logs.length < 2 && tick < 5; tick++) snapshots.step();
        assert.deepEqual(snapshots.logs.map(row => [...row]), [
            [33, 11, 44, 0, 22, 11, 11, 0, 0],
            [33, 11, 44, 0, 22, 11, 11, 11, 11],
        ]);
    }
    console.log("Fresh aggregate emission and nested literal snapshots passed in sliced and unsliced controllers.");
} finally {
    const target = realpathSync(scratch);
    assert.equal(path.dirname(target), scratchRoot);
    assert.match(path.basename(target), /^owned-literals-[\w-]+$/);
    rmSync(target, { recursive: true, force: true });
}
