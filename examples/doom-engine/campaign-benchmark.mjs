const timer = `
always(() => {
    const tick = world.getTick() - 1;
    const snapshot = tick % 2 === 0 ? globalState.__fletcherEven : globalState.__fletcherOdd;
    if (snapshot?.t !== tick || state.reported) return;
    const count = snapshot.p?.perfFrames;
    if (count === 1 && state.start === undefined) {
        state.start = Date.now();
        state.startTick = tick;
    }
    if (count !== 121 || state.start === undefined) return;
    state.reported = true;
    const elapsed = Date.now() - state.start;
    const fps = (120000 / elapsed).toFixed(1);
    const result = "Fletcher: " + fps + " campaign FPS, 120 frames, " + (tick - state.startTick) + " host ticks, " + elapsed + " ms";
    if (typeof showText === "function") showText(result);
    log(result);
});`;

export const benchmarkEdits = [
    [/^    register startTick int = 0\r?$/gm, `    place scriptBlock at (-60, ControlRow + 17) with { code = ${JSON.stringify(timer)} }
    register perfRunning bit = false
    register perfFrameCount int = 0
    publish perfFrames bits<8> = bits<8>(perfFrameCount)
    register startTick int = 0`],
    [/^                if playingDemo \{ command = recorded\.Command\r?\n                \} else if \(\(forwardActivity \|\| turnActivity\) && !mapPanning\) \|\| sidestepActivity \|\| dx != 0 \|\| dy != 0 \{\r?$/gm,
        `                if !perfRunning && levelTime >= 320 && !playingDemo && !mapOpen &&
                    base.MapName.Low == 0x314d3145 && base.MapName.High == 0 { next perfRunning = true }
                testing := perfRunning && perfFrameCount < 121
                if playingDemo { command = recorded.Command
                } else if testing || ((forwardActivity || turnActivity) && !mapPanning) || sidestepActivity || dx != 0 || dy != 0 {`],
    [/^                    command, held = play\.BuildPlayerMoveCommandWithTable\(keys, turnHeld, dx, dy, axes, sharedBytes\("doomKeyboardDeltas"\)\)\r?$/gm,
        `                    if testing {
                        phase := perfFrameCount % 48
                        left := (perfFrameCount / 5) % 2 == 0
                        keys = play.PlayerMoveKeys{Forward: phase < 12, Reverse: phase >= 24 && phase < 36,
                            TurnLeft: left, TurnRight: !left}
                        axes = play.PlayerMoveAxes{TurnHeld: true, Turn: true, Forward: keys.Forward || keys.Reverse}
                        dx, dy = 0, 0
                    }
                    command, held = play.BuildPlayerMoveCommandWithTable(keys, turnHeld, dx, dy, axes, sharedBytes("doomKeyboardDeltas"))`],
    [/^                    if rendered\.Valid \{\r?\n                        if rendered\.Columns\.Revision/gm,
        `                    if rendered.Valid {
                        if perfRunning && perfFrameCount < 121 { next perfFrameCount = perfFrameCount + 1 }
                        if rendered.Columns.Revision`],
];
