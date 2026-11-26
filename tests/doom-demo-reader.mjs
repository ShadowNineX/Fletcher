import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-demo-"));
const header = [109, 3, 2, 5, 0, 0, 0, 0, 0, 1, 0, 0, 0];
const marker = 0x80;
const done = [true, true, 0, 0, 0, 0];
const invalid = [false, false, 0, 0, 0, 0];
const signed = value => value < 128 ? value : value - 256;
const sample = ([forward, side, turn, buttons]) => [true, false, signed(forward), signed(side), signed(turn) * 256, buttons];
// Forward byte 0x80 ends a demo. All 256 byte values still appear in the other lanes.
const records = Array.from({ length: 256 }, (_, value) => [value === marker ? 0 : value, 255 - value, value, (17 + value * 73) & 255]);
const stream = [...records.flat(), marker];
const scenarios = [];

function scenario(name, data, reads, { offset, size, valid = true, opened = true } = {}) {
    const open = opened ? [true, data[2], data[3], data[1], Boolean(data[5]), Boolean(data[6]), Boolean(data[7])]
        : [false, 0, 0, 0, false, false, false];
    scenarios.push({ name, data, open, reads, offset, size, valid });
}

scenario("signed lanes and all button values", [...header, ...stream], [...records.map(sample), done, done]);
scenario("empty demo", [...header, marker], [done]);
scenario("terminator before a padded trailer", [...header, marker, 1, 2, 3, 4], [done, done]);
scenario("record can use 0x80 outside its forward byte", [...header, 4, marker, marker, marker, marker],
    [sample([4, marker, marker, marker]), done]);
scenario("nonzero booleans and commercial map 32", [109, 4, 1, 32, 0, 1, 2, 255, 0, 1, 0, 0, 0, marker], [done]);
scenario("complete record missing its terminator", [...header, 1, 2, 3, 4], [sample([1, 2, 3, 4]), invalid, invalid]);
for (let bytes = 1; bytes <= 3; bytes++)
    scenario(`short ${bytes}-byte command`, [...header, ...[1, 2, 3].slice(0, bytes)], [invalid, invalid]);
scenario("declared lump excludes the terminator", [...header, 1, 2, 3, 4, marker], [sample([1, 2, 3, 4]), invalid],
    { size: header.length + 4 });
scenario("header with no payload", header, [invalid], { opened: false });
scenario("negative offset", [...header, marker], [invalid], { offset: -1, opened: false });
scenario("negative size", [...header, marker], [invalid], { size: -1, opened: false });
scenario("offset outside the archive", [...header, marker], [invalid], { offset: 2147483647, opened: false });
scenario("declared size outside the archive", [...header, marker], [invalid], { size: 2147483647, opened: false });
scenario("invalid lump reference", [...header, marker], [invalid], { valid: false, opened: false });
for (const [name, field, value] of [
    ["wrong version", 0, 108], ["invalid skill", 1, 5], ["episode zero", 2, 0], ["episode five", 2, 5],
    ["map zero", 3, 0], ["map 33", 3, 33], ["deathmatch", 4, 1], ["nonzero console player", 8, 1],
    ["missing player one", 9, 0], ["noncanonical player one flag", 9, 2], ["player two", 10, 1],
    ["player three", 11, 1], ["player four", 12, 1],
]) {
    const data = [...header, marker];
    data[field] = value;
    scenario(name, data, [invalid], { opened: false });
}

function run(exe, args) {
    const result = spawnSync(exe, args, { cwd: root, encoding: "utf8", timeout: 60_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function fletcherRows() {
    // Adjacent guard bytes make an out-of-lump read observable.
    const data = [0xff];
    const cases = scenarios.map(({ data: lump, offset = data.length, size = lump.length, reads, valid }) => {
        data.push(...lump, 0x80, 0x55, 0xaa, 0xcc);
        return `[4]int{${offset}, ${size}, ${reads.length}, ${Number(valid)}}`;
    });
    const source = path.join(scratch, "main.flt");
    const output = path.join(scratch, "map.json");
    writeFileSync(path.join(scratch, "DEMO.bin"), Buffer.from(data));
    writeFileSync(source, `package main
import "play"
import "wad"
const Data = readFile("DEMO.bin")
const Cases = [${cases.length}][4]int{${cases.join(", ")}}
map "Doom demo reader" {
    screen at (0, 0) size (1, 1) with { style = "solid", hold = true, slice = true }
    register index int = 0
    tick {
        if index < ${cases.length} {
            row := Cases[index]
            cursor := play.OpenDoomDemo(wad.LumpRef{File: Data, Offset: row[0], Size: row[1], Valid: row[3] != 0})
            log("open", index, cursor.Valid, cursor.Episode, cursor.Map, cursor.Skill, cursor.Respawn, cursor.Fast, cursor.NoMonsters)
            for range row[2] {
                read := cursor.Read()
                log("read", index, read.Valid, read.Done, read.Command.Forward, read.Command.Side, read.Command.Turn, read.Buttons)
                cursor = read.Demo
            }
            next index = index + 1
        }
    }
}`);
    run("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output]);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    const expectedCount = scenarios.reduce((total, row) => total + row.reads.length + 1, 0);
    for (let tick = 0; tick < cases.length * 8 && sim.logs.length < expectedCount; tick++) sim.step();
    assert.equal(sim.logs.length, expectedCount);
    let index = 0;
    for (const [caseId, row] of scenarios.entries()) {
        assert.deepEqual(sim.logs[index++], ["open", caseId, ...row.open], row.name);
        for (const [record, expected] of row.reads.entries())
            assert.deepEqual(sim.logs[index++], ["read", caseId, ...expected], `${row.name}, read ${record}`);
    }
    return sim.logs.filter(row => row[0] === "read" && row[1] === 0 && row[2] && !row[3]).map(row => row.slice(4));
}

function nativeRows(upstream) {
    const game = readFileSync(path.join(upstream, "g_game.c"), "utf8").replaceAll("\r\n", "\n");
    const source = path.join(scratch, "demo-commands.c");
    const exe = path.join(scratch, process.platform === "win32" ? "demo-commands.exe" : "demo-commands");
    writeFileSync(source, `#include <stdio.h>
#include <stdint.h>
#define DEMOMARKER 0x80
typedef struct {
    int8_t forwardmove, sidemove;
    int16_t angleturn;
    uint8_t buttons;
} ticcmd_t;
static unsigned char stream[] = {${stream.join(",")}};
static unsigned char *demo_p = stream;
static int ends;
static int G_CheckDemoStatus(void) { ends++; return 1; }
${extractFunction(game, "void", "G_ReadDemoTiccmd")}
int main(void) {
    ticcmd_t command = {0};
    for (int i = 0; i < ${records.length}; ++i) {
        G_ReadDemoTiccmd(&command);
        printf("%d,%d,%d,%u\\n", command.forwardmove, command.sidemove, command.angleturn, (unsigned)command.buttons);
    }
    G_ReadDemoTiccmd(&command);
    return ends != 1 || demo_p != stream + sizeof(stream) - 1;
}`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-fwrapv", source, "-o", exe]);
    return run(exe, []).trim().split(/\r?\n/).map(row => row.split(",").map(Number));
}

try {
    const rows = fletcherRows();
    console.log(`Verified ${scenarios.length} Doom demo scenarios and ${rows.length} signed command records.`);
    if (values.upstream) {
        assert.deepEqual(rows, nativeRows(path.resolve(root, values.upstream)));
        console.log(`Matched all ${rows.length} records with pinned G_ReadDemoTiccmd.`);
    }
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-demo-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
