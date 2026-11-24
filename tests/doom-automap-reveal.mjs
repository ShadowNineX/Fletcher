// Compare every prefix of an automap input stream with id's C cheat matcher.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const upstream = path.resolve(root, values.upstream ?? "artifacts/doom-upstream");
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-automap-reveal-"));

function run(command, args) {
    const result = spawnSync(command, args, { cwd: scratch, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
}

try {
    // Exercise successful cycles and failures at each position. The restart
    // cases include a mismatching I that the original matcher does not reuse.
    const inputs = "iddtiddtiddtxiddtxid4dtiddxtiiddtiddiddtidddtiddtidIdtiddtodd".repeat(12);
    const am = readFileSync(path.join(upstream, "am_map.c"), "utf8");
    const sequence = am.match(/^static unsigned char cheat_amap_seq\[\][^\r\n]+/m)?.[0];
    const advance = am.match(/cheating\s*=\s*\(cheating\+1\) % 3;/)?.[0];
    assert.ok(sequence && advance, "find the original automap sequence and cycle in am_map.c");
    const c = path.join(scratch, "trace.c");
    const exe = path.join(scratch, "trace.exe");
    writeFileSync(c, `#include <stdio.h>
#include "m_cheat.h"
${sequence}
static cheatseq_t cheat_amap = { cheat_amap_seq, 0 };
int main(void) {
    int cheating = 0;
    const char *keys = ${JSON.stringify(inputs)};
    for (; *keys; keys++) {
        if (cht_CheckCheat(&cheat_amap, *keys)) { ${advance} }
        printf("%d\\n", cheating);
    }
    return 0;
}
`);
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", "-I", upstream, c, path.join(upstream, "m_cheat.c"), "-o", exe]);
    const modes = run(exe, []).trim().split(/\r?\n/).map(Number);
    assert.equal(modes.length, inputs.length);
    assert.deepEqual([...new Set(modes)].sort(), [0, 1, 2]);
    writeFileSync(path.join(scratch, "trace.bin"), Buffer.from(modes.flatMap((mode, i) => [inputs.charCodeAt(i), mode])));

    const source = path.join(scratch, "reveal_test.flt");
    writeFileSync(source, `import "automap"
const Trace = readFile("trace.bin")
test "native automap reveal sequence" {
    var state automap.RevealState
    for i := range len(Trace) / 2 {
        state = automap.RespondReveal(state, int(Trace[i * 2]))
        assertEqual(state.Mode, int(Trace[i * 2 + 1]))
    }
}
`);
    run("dotnet", [cli, "test", source, "--package-root", path.join(root, "examples/doom-engine")]);
    console.log(`Automap reveal matched ${modes.length} key events from pinned Doom C.`);
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-automap-reveal-[^/\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
