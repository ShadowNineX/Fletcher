import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
    wad: { type: "string" }, output: { type: "string" }, cli: { type: "string" }, muted: { type: "boolean" },
} });
assert.ok(values.wad, "Pass --wad PATH to the supplied Doom IWAD");
const wad = realpathSync(values.wad);
assert.ok(statSync(wad).isFile(), "--wad must point to a file");

const engine = import.meta.dirname;
const repo = resolve(engine, "../..");
const cli = resolve(values.cli ?? join(repo, "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll"));
const output = resolve(values.output ?? join(repo, "artifacts/doom-engine/doom-campaign.json"));
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
        Width: 160, Height: 120, DisplayScale: 2, DisplayStyle: "rgb", DisplayZoom: "2", DisplayGamma: 4,
        DisplaySliceWork: 65536, ClassicMenu: true, LowDetail: false, DitherColors: false, CleanStatusBar: false, ViewBlocks: 10,
    };
    edit(join(project, "display.flt"), Object.entries(profile).map(([name, value]) =>
        [new RegExp(`^const ${name} = .*\r?$`, "gm"), `const ${name} = ${JSON.stringify(value)}`]));
    edit(main, [
        [/^const Archive = readFile\("LEVEL\.WAD"\)\r?$/gm, `const Archive = readFile(${JSON.stringify(basename(wad))})`],
        [/^map "Original WAD BSP View" \{\r?$/gm, 'map "Doom Campaign" {'],
        [/^    register soundMuted bit = false\r?$/gm, `    register soundMuted bit = ${Boolean(values.muted)}`],
    ]);
    mkdirSync(dirname(output), { recursive: true });
    const built = spawnSync("dotnet", [cli, "build", main, "--package-root", engine, "--asset-root", dirname(wad), "-o", output],
        { stdio: "inherit" });
    if (built.error) throw built.error;
    process.exitCode = built.status ?? 1;
    if (built.status === 0) console.log(output);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
