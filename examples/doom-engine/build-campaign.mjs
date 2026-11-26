import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { nativeColormap } from "./native-colormap.mjs";

const { values } = parseArgs({ options: {
    wad: { type: "string" }, output: { type: "string" }, cli: { type: "string" }, muted: { type: "boolean" },
    resolution: { type: "string", default: "160x120" }, "arrow-colormap": { type: "boolean" },
} });
assert.ok(values.wad, "Pass --wad PATH to the supplied Doom IWAD");
assert.ok(["160x120", "320x200"].includes(values.resolution), "--resolution must be 160x120 or 320x200");
const [width, height] = values.resolution.split("x").map(Number);
const wad = realpathSync(values.wad);
assert.ok(statSync(wad).isFile(), "--wad must point to a file");

const engine = import.meta.dirname;
const repo = resolve(engine, "../..");
const cli = resolve(values.cli ?? join(repo, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll"));
const highResolution = width === 320;
const mapName = `Doom Campaign${highResolution ? " 320x200" : ""}${values["arrow-colormap"] ? " Arrow COLORMAP" : ""}`;
const filename = mapName.toLowerCase().replaceAll(" ", "-") + ".json";
const output = resolve(values.output ?? join(repo, "artifacts/doom-engine", filename));
const scratch = mkdtempSync(join(tmpdir(), "fletcher-doom-campaign-"));

function edit(file, changes) {
    let source = readFileSync(file, "utf8");
    for (const [anchor, replacement] of changes) {
        assert.equal([...source.matchAll(anchor)].length, 1, `Expected one ${anchor} in ${basename(file)}`);
        source = source.replace(anchor, () => replacement);
    }
    writeFileSync(file, source);
}

try {
    const project = join(scratch, "campaign");
    cpSync(join(engine, "wad-bsp"), project, { recursive: true });
    const main = join(project, "main.flt");
    const profile = {
        Width: width, Height: height, DisplayScale: 2, DisplayStyle: "rgb", DisplayZoom: "2", DisplayGamma: 4,
        DisplaySliceWork: highResolution ? 131072 : 65536,
        ClassicMenu: true, LowDetail: false, DitherColors: false, CleanStatusBar: false, ViewBlocks: 10,
    };
    edit(join(project, "display.flt"), Object.entries(profile).map(([name, value]) =>
        [new RegExp(`^const ${name} = .*\r?$`, "gm"), `const ${name} = ${JSON.stringify(value)}`]));
    edit(main, [
        [/^const Archive = readFile\("LEVEL\.WAD"\)\r?$/gm, `const Archive = readFile(${JSON.stringify(basename(wad))})`],
        [/^map "Original WAD BSP View" \{\r?$/gm, `map ${JSON.stringify(mapName)} {`],
        [/^    register soundMuted bit = false\r?$/gm, `    register soundMuted bit = ${Boolean(values.muted)}`],
    ]);
    if (values["arrow-colormap"]) {
        const { layout, offset, size } = nativeColormap(readFileSync(wad));
        edit(main, [
            [/^    expand DoomMapSigns\(\)\r?$/gm, `    expand DoomMapSigns()\n${layout}`],
            [/^    materials\.Shade = display\.Shade\.WithFixedColormap\(display\.Inventory\.FixedColormap\)\r?$/gm,
                `    materials.Shade = display.Shade.WithFixedColormap(display.Inventory.FixedColormap)
    if sameFile(materials.Shade.ColorMaps.File, Archive) && materials.Shade.ColorMaps.Offset == ${offset} &&
        materials.Shade.ColorMaps.Size == ${size} {
        maps := sharedBytes("doomNativeColorMaps")
        if len(maps) == ${size} { materials.Shade.ColorMaps.File, materials.Shade.ColorMaps.Offset = maps, 0 }
    }`],
        ]);
    }
    mkdirSync(dirname(output), { recursive: true });
    const built = spawnSync("dotnet", [cli, "build", main, "--package-root", engine, "--asset-root", dirname(wad), "-o", output],
        { stdio: "inherit" });
    if (built.error) throw built.error;
    process.exitCode = built.status ?? 1;
    if (built.status === 0) console.log(output);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
