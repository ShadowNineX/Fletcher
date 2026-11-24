import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "src", "Fletcher.Cli", "bin", "Debug", "net11.0", "fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-reload-"));
const { values } = parseArgs({ options: { upstream: { type: "string" } } });

function wad(lumps) {
    const directory = 12 + lumps.reduce((sum, [, data]) => sum + data.length, 0);
    const file = Buffer.alloc(directory + lumps.length * 16);
    file.write("PWAD"); file.writeInt32LE(lumps.length, 4); file.writeInt32LE(directory, 8);
    let offset = 12;
    lumps.forEach(([name, data], index) => {
        const entry = directory + index * 16;
        file.writeInt32LE(data.length === 0 ? 0 : offset, entry); file.writeInt32LE(data.length, entry + 4); file.write(name, entry + 8);
        data.copy(file, offset); offset += data.length;
    });
    return file;
}

function key(name) {
    const bytes = Buffer.alloc(8); bytes.write(name);
    return `wad.LumpName{Low: ${bytes.readInt32LE(0)}, High: ${bytes.readInt32LE(4)}}`;
}

// Independent binary oracle for the valid same-layout path in W_Reload.
// The native routine retains each existing logical index/name and swaps the
// replacement directory's positions and sizes into those entries.
function vanillaReloadByte(file, localIndex) {
    const count = file.readInt32LE(4), directory = file.readInt32LE(8);
    assert.ok(localIndex >= 0 && localIndex < count);
    return file[file.readInt32LE(directory + localIndex * 16)];
}

function nativeReload(upstream) {
    const original = readFileSync(path.join(root, upstream, "w_wad.c"), "utf8");
    const reload = original.match(/^void W_Reload \(void\)\s*\{[\s\S]*?^\}/m)?.[0];
    assert.ok(reload, "extract the unmodified W_Reload routine from id Software's source");
    const source = path.join(scratch, "wad-reload-native.c");
    const binary = path.join(scratch, process.platform === "win32" ? "wad-reload-native.exe" : "wad-reload-native");
    writeFileSync(source, `#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#ifndef O_BINARY
#define O_BINARY 0
#endif
#define alloca __builtin_alloca
#define LONG(value) (value)
typedef struct { char identification[4]; int numlumps, infotableofs; } wadinfo_t;
typedef struct { int filepos, size; char name[8]; } filelump_t;
typedef struct { int position, size; char name[8]; } lumpinfo_t;
static lumpinfo_t lumpinfo[4] = {{12, 1, "DUP"}, {13, 1, "BASE"}, {12, 1, "DUP"}, {13, 1, "LIVE"}};
static char cached[4];
static void *lumpcache[] = {&cached[0], &cached[1], &cached[2], &cached[3]};
static char *reloadname;
static int reloadlump = 2, freed;
static void I_Error(const char *message, ...) { exit(2); }
static void Z_Free(void *value) {
    for (int i = 0; i < 4; ++i) if (lumpcache[i] == value) { lumpcache[i] = NULL; ++freed; return; }
    exit(3);
}
${reload}
int main(int argc, char **argv) {
    if (argc != 2) return 4;
    reloadname = argv[1];
    W_Reload();
    printf("%d %d %d %d %d %d %s %s\\n", freed, lumpcache[0] != NULL, lumpinfo[2].position, lumpinfo[2].size,
        lumpinfo[3].position, lumpinfo[3].size, lumpinfo[2].name, lumpinfo[3].name);
    return 0;
}
`);
    const build = spawnSync(process.env.CC ?? "gcc", ["-std=c99", "-O2", source, "-o", binary], { encoding: "utf8", timeout: 30000 });
    if (build.error) throw build.error;
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [path.join(scratch, "NEXT.WAD")], { encoding: "utf8", timeout: 30000 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
}

try {
    const base = wad([["DUP", Buffer.from([10])], ["BASE", Buffer.from([20])]]);
    const old = wad([["DUP", Buffer.from([30])], ["LIVE", Buffer.from([40])]]);
    const next = wad([["DUP", Buffer.from([31, 7, 8])], ["LIVE", Buffer.from([41, 5])]]);
    const nativeReloadValue = vanillaReloadByte(next, 0);
    const malformed = Buffer.from(next);
    malformed.writeInt32LE(malformed.length + 1, malformed.readInt32LE(8));
    writeFileSync(path.join(scratch, "BASE.WAD"), base);
    writeFileSync(path.join(scratch, "OLD.WAD"), old);
    writeFileSync(path.join(scratch, "NEXT.WAD"), next);
    writeFileSync(path.join(scratch, "BRANCH.WAD"), wad([["DUP", Buffer.from([32])], ["LIVE", Buffer.from([42])]]));
    writeFileSync(path.join(scratch, "BAD.WAD"), malformed);
    writeFileSync(path.join(scratch, "COUNT.WAD"), wad([["DUP", Buffer.from([31])]]));
    writeFileSync(path.join(scratch, "NAMES.WAD"), wad([["DUP", Buffer.from([31])], ["OTHER", Buffer.from([41])]]));
    const source = path.join(scratch, "main.flt");
    writeFileSync(source, `package main
import "wad"
const Base = readFile("BASE.WAD")
const Old = readFile("OLD.WAD")
const Next = readFile("NEXT.WAD")
const Branch = readFile("BRANCH.WAD")
const Bad = readFile("BAD.WAD")
const Count = readFile("COUNT.WAD")
const Names = readFile("NAMES.WAD")
map "Reloadable WAD snapshots" {
    tick {
        if currentTick() == 0 {
            mounted := wad.AddReloadableArchive(wad.OpenArchive(Base), Old).BuildIndex(64)
            stale := mounted.Find(${key("DUP")})
            previousLive := mounted.Find(${key("LIVE")})
            malformed := wad.ReloadArchive(mounted, 1, Bad)
            changedNames := wad.ReloadArchive(mounted, 1, Names)
            changedCount := wad.ReloadArchive(mounted, 1, Count)
            updated := wad.ReloadArchive(mounted, 1, Next)
            fresh := updated.Mounts.RefreshLump(stale)
            nextLive := updated.Mounts.RefreshLump(previousLive)
            replay := wad.ReloadArchive(updated.Mounts, 1, Next)
            branch := wad.ReloadArchive(mounted, 1, Branch).Mounts
            log(mounted.Revision, mounted.IndexReady(), stale.Index, stale.File[stale.Offset], stale.ArchiveRevision)
            log(malformed.Applied, changedNames.Applied, changedCount.Applied, malformed.Mounts.Revision,
                malformed.Mounts.Find(${key("DUP")}).File[malformed.Mounts.Find(${key("DUP")}).Offset])
            log(updated.Applied, updated.Mounts.Revision, updated.Mounts.IndexReady(), updated.Mounts.LumpIsCurrent(stale),
                stale.File[stale.Offset], fresh.Index, fresh.File[fresh.Offset], fresh.ArchiveRevision, updated.Mounts.LumpIsCurrent(fresh))
            log(updated.Mounts.SnapshotIsCurrent(mounted), updated.Mounts.SnapshotIsCurrent(updated.Mounts))
            log(previousLive.Index, nextLive.Index, previousLive.Offset, nextLive.Offset,
                previousLive.Size, nextLive.Size, nextLive.File[nextLive.Offset])
            branchLump := branch.RefreshLump(fresh)
            log(branch.Revision == updated.Mounts.Revision, branch.SnapshotIsCurrent(updated.Mounts),
                branch.LumpIsCurrent(fresh), branch.LumpIsCurrent(branchLump), branchLump.File[branchLump.Offset])
            log(replay.Applied, replay.Mounts.Revision, replay.Mounts.RefreshLump(fresh).File[replay.Mounts.RefreshLump(fresh).Offset],
                replay.Mounts.LumpIsCurrent(fresh), replay.Mounts.LumpIsCurrent(replay.Mounts.RefreshLump(fresh)))
        }
    }
}
`);
    const output = path.join(scratch, "reload.json");
    const result = spawnSync("dotnet", [cli, "build", source, "--package-root", port, "--asset-root", scratch, "-o", output],
        { cwd: root, encoding: "utf8", timeout: 30000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sim = simulator(decode(JSON.parse(readFileSync(output, "utf8")).data), true);
    sim.step();
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [2, true, 2, 30, 2],
        [false, false, false, 2, 30],
        [true, 3, true, false, 30, 2, nativeReloadValue, 3, true],
        [false, true],
        [3, 3, 13, 15, 1, 2, vanillaReloadByte(next, 1)],
        [true, false, false, true, 32],
        [true, 4, nativeReloadValue, false, true],
    ]);
    if (values.upstream) assert.equal(nativeReload(values.upstream), "2 1 12 3 15 2 DUP LIVE",
        "pinned Doom C updates the same extents, preserves names, and drops only the replaced source's cached lumps");
    console.log("Reloadable WAD snapshots preserved indices and lookup order, rejected incompatible replacement atomically, and refreshed stale lump references.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-reload-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
