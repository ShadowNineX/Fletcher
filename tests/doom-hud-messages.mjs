// Compare the single-player HUD message state against the pinned HU_Ticker.
// The messages are synthetic test labels and no WAD data is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, simulator } from "./logic-arrows-simulator.mjs";
import { extractFunction } from "./doom-native-actor-oracle.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: "string" }, cli: { type: "string" } } });
const cli = path.resolve(root, values.cli ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const port = path.join(root, "examples", "doom-engine");
const upstream = path.resolve(root, values.upstream ?? "artifacts/doom-upstream");
const temp = realpathSync(os.tmpdir());
const scratch = mkdtempSync(path.join(temp, "fletcher-doom-hud-messages-"));
const tics = 156;

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function fletcherSource() {
    return [
        "package main",
        "import \"play\"",
        "",
        "func code(value string) int {",
        "    if value == \"one\" { return 1 }",
        "    if value == \"two\" { return 2 }",
        "    if value == \"forced\" { return 3 }",
        "    if value == \"after-force\" { return 7 }",
        "    if value == \"late\" { return 4 }",
        "    if value == \"override\" { return 5 }",
        "    if value == \"muted\" { return 6 }",
        "    return 0",
        "}",
        "",
        "map \"Doom HUD messages\" {",
        "    screen at (0, 0) size (1, 1) with { style = \"solid\", hold = true, slice = true }",
        "    register messages play.HudMessages = play.HudMessages{}",
        "    tick {",
        "        state := messages",
        "        enabled := true",
        "        switch currentTick() {",
        "        case 0: state = play.QueueHudMessage(state, \"one\", false)",
        "        case 1: state = play.QueueHudMessage(state, \"two\", false)",
        "        case 2: state = play.QueueHudMessage(state, \"forced\", true); state = play.QueueHudMessage(state, \"after-force\", false)",
        "        case 3: state = play.QueueHudMessage(state, \"late\", false)",
        "        case 5: state = play.QueueHudMessage(state, \"override\", true)",
        "        case 6: state = play.QueueHudMessage(state, \"muted\", false); enabled = false",
        "        case 7: enabled = false",
        "        }",
        "        refresh := currentTick() == 150",
        "        state = play.TickHudMessages(state, enabled, refresh)",
        "        log(code(state.Current), code(state.Pending), state.Tics, state.Visible, state.Protected, state.Force)",
        "        next messages = state",
        "    }",
        "}",
        ""
    ].join("\n");
}

function fletcher() {
    const input = path.join(scratch, "hud-messages.flt");
    const output = path.join(scratch, "hud-messages.json");
    writeFileSync(input, fletcherSource());
    run("dotnet", [cli, "build", input, "--package-root", port, "-o", output]);
    const encoded = JSON.parse(readFileSync(output, "utf8")).data;
    const sim = simulator(decode(encoded), true);
    const observed = [];
    for (let index = 0; index < tics; index++) {
        for (let host = 0; host < 16 && sim.logs.length <= index; host++) sim.step();
        assert.equal(sim.logs.length, index + 1, "Fletcher tic " + index);
        observed.push(Array.from(sim.logs[index], Number));
    }
    return observed;
}

function nativeSource(ticker) {
    return [
        "#include <stdio.h>",
        "#include <string.h>",
        "#define HU_MSGTIMEOUT (4*35)",
        "typedef int boolean;",
        "enum { false, true, MAXPLAYERS = 4, HU_BROADCAST = 5, KEY_ENTER = 13, commercial = 1, sfx_radio = 1, sfx_tink = 2 };",
        "typedef struct { char chatchar; } ticcmd_t;",
        "typedef struct { ticcmd_t cmd; char *message; } player_t;",
        "typedef struct { struct { int len; char l[81]; } l; } input_t;",
        "static player_t players[MAXPLAYERS], *plr = &players[0];",
        "static int playeringame[MAXPLAYERS], consoleplayer, netgame, showMessages, message_dontfuckwithme, message_nottobefuckedwith;",
        "static int message_on, message_counter, chat_dest[MAXPLAYERS], shiftxform[256], gamemode;",
        "static input_t w_inputbuffer[MAXPLAYERS];",
        "static int w_message; static char *current;",
        "static char *player_names[MAXPLAYERS];",
        "static void HUlib_addMessageToSText(int *widget, char *prefix, char *message) { (void)widget; (void)prefix; current = message; }",
        "static int HUlib_keyInIText(input_t *input, char value) { (void)input; (void)value; return 0; }",
        "static void HUlib_resetIText(input_t *input) { (void)input; }",
        "static void S_StartSound(int origin, int sound) { (void)origin; (void)sound; }",
        ticker,
        "static int code(char *value) {",
        "    if (!value) return 0;",
        "    if (!strcmp(value, \"one\")) return 1; if (!strcmp(value, \"two\")) return 2;",
        "    if (!strcmp(value, \"forced\")) return 3; if (!strcmp(value, \"after-force\")) return 7; if (!strcmp(value, \"late\")) return 4;",
        "    if (!strcmp(value, \"override\")) return 5; if (!strcmp(value, \"muted\")) return 6; return -1;",
        "}",
        "static void queue(int tick) {",
        "    char *message = 0; int forced = 0;",
        "    switch (tick) { case 0: message = \"one\"; break; case 1: message = \"two\"; break;",
        "    case 2: plr->message = \"forced\"; message_dontfuckwithme = 1; plr->message = \"after-force\"; return; case 3: message = \"late\"; break;",
        "    case 5: message = \"override\"; forced = 1; break; case 6: message = \"muted\"; break; }",
        "    if (message) { plr->message = message; message_dontfuckwithme = forced; }",
        "}",
        "int main(void) {",
        "    for (int tick = 0; tick < " + tics + "; tick++) {",
        "        showMessages = tick != 6 && tick != 7; queue(tick);",
        "        if (tick == 150) { message_on = true; message_counter = 140; }",
        "        HU_Ticker();",
        "        printf(\"%d,%d,%d,%d,%d,%d\", code(current), code(plr->message), message_counter, message_on,",
        "            message_nottobefuckedwith, message_dontfuckwithme);",
        "        putchar(10);",
        "    } return 0;",
        "}",
        ""
    ].join("\n");
}

function native() {
    const source = readFileSync(path.join(upstream, "hu_stuff.c"), "utf8").replaceAll("\r\n", "\n");
    const ticker = extractFunction(source, "void", "HU_Ticker");
    const input = path.join(scratch, "hud-messages.c");
    const output = path.join(scratch, "hud-messages.exe");
    writeFileSync(input, nativeSource(ticker));
    run(process.env.CC ?? "gcc", ["-std=c11", "-O2", input, "-o", output]);
    return run(output, []).trim().split(/\r?\n/).map(row => row.split(",").map(Number));
}

try {
    const observed = fletcher();
    const expected = native();
    assert.deepEqual(observed, expected);
    console.log("Matched " + tics + " HUD message tics against pinned HU_Ticker, including priority, timeout, disabled messages, and refresh.");
} finally {
    assert.match(path.relative(temp, realpathSync(scratch)), /^fletcher-doom-hud-messages-[^/\\\\]+$/);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
