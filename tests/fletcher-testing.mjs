import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.resolve(root, process.argv[2] ?? "src/Fletcher.Cli/bin/Debug/net11.0/fletcher.dll");
const scratch = mkdtempSync(path.join(os.tmpdir(), "fletcher-test-command-"));

function put(name, data) {
    const destination = path.join(scratch, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, data);
    return destination;
}

function invoke(...args) {
    const result = spawnSync("dotnet", [cli, ...args], { cwd: scratch, encoding: "utf8", timeout: 15_000 });
    if (result.error) throw result.error;
    return result;
}

try {
    put("named/lib.flt", `package math
type Score struct { Values [2]int }
func result(a int) Score { return Score{Values: [2]int{a, a + 1}} }
func test() int { return 8 }
`);
    put("named/data_a.bin", Uint8Array.of(1, 33, 249));
    put("named/data_b.bin", Uint8Array.of(1, 33, 249));
    const named = put("named/arrays_test.flt", `package math
const Left = readFile("data_a.bin")
const Right = readFile("data_b.bin")
type Reader interface { First() int }
type Cell struct { __proto__ [2]int }
func (cell Cell) First() int { return cell.__proto__[0] }
type Grid struct { Rows [2][2]Cell; Views [2]Reader }
test "array and struct equality" {
    assertEqual(result(5), Score{Values: [2]int{5, 6}})
    var original Grid
    original.Rows[0][0].__proto__[0] = 3
    original.Views[1] = original.Rows[0][0]
    copied := original
    copied.Rows[0][0].__proto__[0] = 7
    assertEqual(original.Rows[0][0].First(), 3)
    original.Rows[0][0].__proto__[0] = 9
    assertEqual(copied.Rows[0][0].First(), 7)
    assertEqual(copied.Views[1].First(), 3)
}
test "byte equality across imports" {
    assertEqual(Left, Right)
    assertEqual(len(Left), 3)
}
`);
    put("named/siblings_test.flt", `package math
test "contextual keyword stays an identifier" {
    assertEqual(test(), 8)
}
`);
    put("single/a_test.flt", `test "intentional failure" {
    assertEqual(7, 8, "numeric mismatch")
}
test "later test still executes" { assert(true) }
`);
    put("single/b_test.flt", `test "second independent source" { assertEqual("f" + "lt", "flt") }
`);
    put("artifacts/ignored_test.flt", "invalid Fletcher syntax");

    const discovered = invoke("test");
    assert.equal(discovered.status, 1, discovered.stderr);
    assert.match(discovered.stderr, /FAIL intentional failure/);
    assert.match(discovered.stderr, /a_test\.flt:2:5: numeric mismatch: expected 8, got 7/);
    assert.match(discovered.stdout, /PASS later test still executes/);
    assert.match(discovered.stdout, /PASS second independent source/);
    assert.match(discovered.stdout, /6 test\(s\) across 3 package\(s\)/);
    assert.equal(discovered.stdout.match(/PASS array and struct equality/g)?.length, 1);

    const one = invoke("test", named, "--filter", "BYTE EQUALITY");
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /PASS byte equality across imports/);
    assert.doesNotMatch(one.stdout, /PASS array|PASS contextual/);

    const noMatch = invoke("test", named, "--filter", "banana");
    assert.equal(noMatch.status, 1);
    assert.match(noMatch.stderr, /no tests matched/);

    const typed = put("typecheck/case.flt", `test "typed assertions" {
    assert(123)
}
`);
    const invalid = invoke("test", typed);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /case\.flt\(2,12\): error:/);

    const main = put("production/main.flt", `package main
map "Normal build" { tick { log("ready") } }
`);
    put("production/broken_test.flt", "invalid Fletcher syntax");
    const normal = invoke("check", main);
    assert.equal(normal.status, 0, normal.stderr);
    const broken = invoke("test", path.join(scratch, "production"));
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /broken_test\.flt\(1,1\): error:/);
    console.log("Fletcher test CLI passed discovery, filtering, assertion values and locations, and build isolation checks.");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
