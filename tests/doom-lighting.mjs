import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, simulator } from "./logic-arrows-simulator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(artifacts, "doom-lighting-"));

function build(entry) {
    const output = path.join(scratch, "output.json");
    const result = spawnSync("dotnet", [cli, "build", entry, "--package-root", port, "-o", output], {
        encoding: "utf8", cwd: root, timeout: 15_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return decode(JSON.parse(readFileSync(output, "utf8")).data);
}

try {
    const entry = path.join(scratch, "main.flt");
    writeFileSync(entry, `package main
import "engine"

const Unit = engine.FracUnit
const PlaneCases = [12][3]int{
    [3]int{0,0,0}, [3]int{255,0,0}, [3]int{128,0,Unit}, [3]int{128,0,Unit * 16},
    [3]int{128,0,Unit * 128}, [3]int{128,2,Unit * 128}, [3]int{0,-8,Unit * 8},
    [3]int{255,8,Unit * 128}, [3]int{128,0,-1}, [3]int{128,0,2147483647},
    [3]int{-1,0,Unit * 3}, [3]int{999,0,Unit * 3},
}
const WallCases = [11][5]int{
    [5]int{128,0,0,320,0}, [5]int{128,0,Unit,320,0}, [5]int{128,0,Unit * 16,320,0},
    [5]int{128,0,Unit * 47,320,0}, [5]int{128,0,Unit * 48,320,0}, [5]int{128,0,-1,320,0},
    [5]int{0,-8,Unit * 12,160,0}, [5]int{255,8,Unit * 12,160,1}, [5]int{255,0,Unit * 47,95,0},
    [5]int{128,0,Unit * 12,0,0}, [5]int{-1,0,Unit * 3,320,0},
}

map "Doom lighting parity" {
    tick {
        for _, item := range PlaneCases {
            log(engine.LightBand(item[0], item[1]), engine.PlaneDistanceIndex(item[2]), engine.PlaneLightRow(item[0], item[1], item[2]))
        }
        for _, item := range WallCases {
            log(engine.WallScaleIndex(item[2]), engine.WallLightRow(item[0], item[1], item[2], item[3], item[4]))
        }
    }
}
`);
    const sim = simulator(build(entry));
    sim.step();
    // Frozen vectors independently calculated from Linux Doom 1.10's
    // R_InitLightTables, R_ExecuteSetViewSize, R_MapPlane, and R_DrawPlanes.
    assert.deepEqual(JSON.parse(JSON.stringify(sim.logs)), [
        [0, 0, 0], [15, 0, 0], [8, 0, 0], [8, 1, 0], [8, 8, 20], [10, 8, 12],
        [0, 0, 0], [15, 8, 0], [8, 127, 28], [8, 127, 28], [0, 0, 0], [15, 0, 0],
        [0, 28], [16, 20], [47, 5], [47, 5], [47, 5], [47, 5], [47, 13], [47, 0],
        [47, 0], [47, 0], [47, 31],
    ]);
    console.log("Doom plane and wall lighting table parity checks passed.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
