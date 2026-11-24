import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractFunction } from "./doom-native-actor-oracle.mjs";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const temporaryRoot = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temporaryRoot, "fletcher-doom-sprite-effects-"));
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const width = 8, height = 64;
const framebufferRows = width * height + 1;
const translationRows = 4 * 256;

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function wad(lumps) {
    const directory = 12 + lumps.reduce((size, [, bytes]) => size + bytes.length, 0);
    const archive = Buffer.alloc(directory + lumps.length * 16);
    archive.write("PWAD"); archive.writeUInt32LE(lumps.length, 4); archive.writeUInt32LE(directory, 8);
    let offset = 12;
    lumps.forEach(([name, bytes], index) => {
        const entry = directory + index * 16;
        archive.writeUInt32LE(offset, entry); archive.writeUInt32LE(bytes.length, entry + 4); archive.write(name, entry + 8);
        bytes.copy(archive, offset); offset += bytes.length;
    });
    return archive;
}

function colorMaps() {
    return Buffer.from(Array.from({ length: 32 * 256 }, (_, position) => {
        const row = Math.trunc(position / 256), index = position & 255;
        return row === 6 ? (index * 17 + 11) & 255 : index;
    }));
}

function fletcher() {
    const source = path.join(scratch, "sprite-effects.flt"), output = path.join(scratch, "sprite-effects.json");
    writeFileSync(path.join(scratch, "EFFECTS.WAD"), wad([["COLORMAP", colorMaps()]]));
    writeFileSync(source, `package main
import "wad"
import "walls"

const Archive = readFile("EFFECTS.WAD")
const Width = ${width}
const Height = ${height}

func initialIndex(x int, y int) int { return (y * 19 + x * 37 + 1) & 255 }

map "Doom sprite effects" {
    screen at (0, 0) size (Width, Height) with { style = "solid", hold = true }
    tick {
        if currentTick() == 0 {
            maps := wad.OpenArchive(Archive).Find(wad.LumpName{Low: 0x4f4c4f43, High: 0x50414d52})
            shade := walls.WadShading{ColorMaps: maps, Palette: [256]color{}, Valid: true}
            for y := range Height {
                for x := range Width { pixel(x, y, true, color.Black, initialIndex(x, y)) }
            }
            phase := walls.DrawFuzzColumn(3, 0, Height, Height, 48, shade)
            phase = walls.DrawFuzzColumn(3, 2, 5, Height, phase, shade)
            phase = walls.DrawFuzzColumn(1, 0, 1, Height, phase, shade)
            for y := range Height {
                for x := range Width { log(pixelIndexAt(x, y)) }
            }
            log(phase)
        }
        profile, index := currentTick() / 256, currentTick() & 255
        log(walls.TranslateSpriteIndex(index, profile))
    }
}
`);
    run("dotnet", [cli, "build", source, "--package-root", path.join(root, "examples/doom-engine"), "--asset-root", scratch, "-o", output]);
    const data = JSON.parse(readFileSync(output, "utf8")).data;
    assert.equal(Buffer.from(data, "base64")[2], 1);
    const session = simulator(decode(data), true);
    for (let host = 0; host < translationRows; host++) session.step();
    assert.equal(session.logs.length, framebufferRows + translationRows);
    const rows = session.logs.map(row => Number(row[0]));
    return { fuzz: rows.slice(0, framebufferRows), translations: rows.slice(framebufferRows) };
}

function native(upstream) {
    const source = readFileSync(path.resolve(root, upstream, "r_draw.c"), "utf8").replaceAll("\r\n", "\n");
    const fuzzOffsets = source.match(/int\s+fuzzoffset\[FUZZTABLE\]\s*=\s*\{[\s\S]+?\};/)[0];
    const fuzz = extractFunction(source, "void", "R_DrawFuzzColumn");
    const translations = extractFunction(source, "void", "R_InitTranslationTables")
        .replace("( (int)translationtables + 255 )", "( (uintptr_t)translationtables + 255 )");
    const input = path.join(scratch, "sprite-effects.c"), executable = path.join(scratch, "sprite-effects.exe");
    writeFileSync(input, `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef unsigned char byte;
typedef int fixed_t;
enum { SCREENWIDTH=${width}, SCREENHEIGHT=${height}, FUZZTABLE=50, FUZZOFF=SCREENWIDTH, PU_STATIC=1 };
${fuzzOffsets}
int fuzzpos;
static byte frame[SCREENWIDTH * SCREENHEIGHT];
static byte maps[32 * 256];
byte *colormaps=maps, *ylookup[SCREENHEIGHT];
int columnofs[SCREENWIDTH];
static int dc_yl, dc_yh, dc_x, viewheight=SCREENHEIGHT, dc_iscale, dc_texturemid, centery;
static void *Z_Malloc(int count, int tag, void *user) { (void)tag; (void)user; return calloc(1, count); }
${fuzz}
byte *translationtables;
${translations}

static int initialIndex(int x, int y) { return (y * 19 + x * 37 + 1) & 255; }
static void fuzz(int x, int first, int end, int phase) {
    dc_x=x; dc_yl=first; dc_yh=end-1; fuzzpos=phase;
    R_DrawFuzzColumn();
}
int main(void) {
    for (int row=0; row<32; row++) for (int index=0; index<256; index++)
        maps[row*256+index]=row==6 ? (index*17+11)&255 : index;
    for (int y=0; y<SCREENHEIGHT; y++) ylookup[y]=frame+y*SCREENWIDTH;
    for (int x=0; x<SCREENWIDTH; x++) columnofs[x]=x;
    for (int y=0; y<SCREENHEIGHT; y++) for (int x=0; x<SCREENWIDTH; x++) frame[y*SCREENWIDTH+x]=initialIndex(x,y);
    fuzz(3,0,SCREENHEIGHT,48); fuzz(3,2,5,fuzzpos); fuzz(1,0,1,fuzzpos);
    for (int index=0; index<SCREENWIDTH*SCREENHEIGHT; index++) printf("%d,", frame[index]);
    printf("%d\\n",fuzzpos);
    R_InitTranslationTables();
    for (int profile=0; profile<4; profile++) for (int index=0; index<256; index++) {
        int value=index;
        if (profile) value=translationtables[(profile-1)*256+index];
        printf("%d\\n",value);
    }
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", executable]);
    const lines = run(executable, []).trim().split(/\r?\n/);
    const fuzzRow = lines.shift().split(",").filter(Boolean).map(Number);
    return { fuzz: fuzzRow, translations: lines.map(Number) };
}

try {
    const observed = fletcher();
    const digest = createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    if (values.upstream) {
        const expected = native(values.upstream);
        assert.deepEqual(observed, expected);
        console.log(`Matched ${observed.fuzz.length - 1} indexed fuzz pixels and ${observed.translations.length} translation values with pinned C. SHA-256 ${digest}.`);
    } else {
        assert.equal(digest, "b3c663c31aec066460e38974f04cd5cc8ba81a210cc456930d01743639b0d162");
        console.log(`Verified indexed fuzz and translated sprite tables against the pinned snapshot.`);
    }
} finally {
    assert.match(path.relative(temporaryRoot, realpathSync(scratch)), /^fletcher-doom-sprite-effects-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
