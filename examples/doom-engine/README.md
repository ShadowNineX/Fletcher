# Doom engine routines in Fletcher

This example ports engine routines for the single-player campaign from id Software’s Linux Doom 1.10 release at revision `a77dfb96cb91780ca334d0d4cfd86957558007e0`. The adapted source is GPL-2.0-only. The raster sample uses procedural colors and the arctangent table comes from the engine’s C code. [Upstream source](https://github.com/id-Software/DOOM/tree/a77dfb96cb91780ca334d0d4cfd86957558007e0/linuxdoom-1.10) · [GPL v2 license](LICENSE.txt)

The [port checklist](PORTING.md) tracks the remaining engine systems and how to verify each milestone.

| Upstream code | Fletcher port |
| --- | --- |
| `m_swap.c`, `m_fixed.c`, `tables.c` | 16-bit and 32-bit byte swaps, 16.16 multiply and saturating divide, and `SlopeDiv`. |
| `m_bbox.c`, `r_main.c` | Bounds updates, BSP partition and segment side tests, subsector traversal, and binary angles using the original `tantoangle` table. |
| `r_main.c`, `r_bsp.c` | Forward and inverse screen projection, angular clipping, solid-column coverage, bounding-box culling, and near-first rendering traversal. |
| `r_main.c`, `r_segs.c` | Wall distance, scale and texture projection, clipped wall tiers, masked middle textures, pegging, and per-column lighting. |
| `r_plane.c`, `r_main.c` | Visplane allocation and merging, horizontal spans, fixed-point flat sampling, and distance and scale colormap selection. |
| `r_plane.c`, `r_segs.c`, `g_game.c` | Full-bright sky columns, shared-sky boundaries, and sky selection by map name. |
| `r_draw.c` | Column and span texture sampling, all three player color ramps, and the indexed framebuffer fuzz used by Spectres and invisible players. |
| `r_data.c` | Texture definitions, direct and composited columns, 64-by-64 flats, palettes, and colormaps. |
| `p_setup.c`, `p_maputl.c`, `doomdata.h` | Classic WAD geometry and player starts, sector line grouping, collision line sides and openings, BLOCKMAP, and REJECT. |
| `p_map.c` | Terrain movement checks, destination floor and ceiling heights, ordered special-line crossings, and wall sliding. |
| `p_mobj.c`, `p_user.c` | Horizontal momentum and friction, vertical movement, landings, floating and missile impact decisions, tic-command thrust, and player view height. |
| `p_user.c`, `p_mobj.c`, `g_game.c` | Death camera and attacker tracking, corpse state advancement, and single-player respawn by restarting the current WAD level. |
| `g_game.c`, `p_mobj.c`, `p_enemy.c` | Nightmare respawn timing and blocked-spawn checks, replacement monsters with both teleport-fog actors, fast demon states, and faster imp, cacodemon, and baron fireballs. |
| `p_inter.c`, `p_mobj.c` | Damage, knockback, armor, pain and death transitions, kill and frag accounting, dropped items, and missile explosions. Non-player actor ticks apply missile and skull contacts before finishing terrain and state updates. |
| `p_sight.c`, `p_map.c`, `p_enemy.c` | Directional REJECT and BSP sight checks through live openings, BLOCKMAP blast sweeps with falloff, and the `A_Explode` action. |
| `p_map.c`, `p_maputl.c`, `p_mobj.c` | Mixed line and actor intercepts, autoaim through portals, hitscan impacts, animated puff and blood actor initialization, and damage. Line specials can update the opening before the shot resumes. |
| `p_mobj.c`, `p_pspr.c` | Player and monster missile launches with the original aim, random spread, and first half-step checks. Gunshots use Doom's damage and spread rolls. |
| `d_items.c`, `p_pspr.c`, `p_enemy.c` | Weapon and flash state transitions, bob, ammo fallback, firing and refire, muzzle light, reload sounds, and the initial attacks for all nine weapons. |
| `p_enemy.c` | Melee and missile range decisions using actual BSP sight, reaction time, retaliation, monster-specific thresholds, and Doom's gameplay RNG. |
| `p_enemy.c`, `p_maputl.c` | Sector noise propagation through live portal openings, with Doom's one-sound-blocker limit. |
| `p_enemy.c` | Monster hearing and player searches, chase decisions, direction searches, walking and ordinary door use, and common gun, melee, skull-charge, and projectile attacks. |
| `p_enemy.c` | Revenant melee, tracer missiles and smoke, mancubus volley headings, and pain elemental lost soul attacks and death spawns. |
| `p_enemy.c` | Arch-vile flame tracking, line-of-sight damage, vertical thrust, splash, and BLOCKMAP corpse selection and resurrection. |
| `p_enemy.c`, `p_map.c` | Boss death triggers, Icon of Sin spawn cubes and explosion states, and BLOCKMAP teleport movement and telefrags. |
| `p_telept.c`, `p_spec.c` | Walkover teleporters 39, 97, 125, and 126, including destination order, fog, telefrags, and the player's post-teleport movement delay. |
| `r_things.c` | Sprite frame metadata, mirrored rotations, projection, wall silhouettes, shaded patch posts, and depth ordering with masked walls. |
| `r_things.c`, `p_pspr.c` | First-person weapon and flash patches, indexed WAD lookup, muzzle light, BFG spray, and the invisibility blink for both overlays. |
| `p_spec.c` | Built-in texture and flat animation ranges, game-tic translation, and line special 48 wall scrolling. |
| `p_lights.c`, `p_spec.c`, `p_switch.c` | Sector-start lighting thinkers, tagged walkover lighting, and reusable light buttons. |
| `p_user.c`, `p_spec.c`, `p_inter.c` | Floor contact damage, radiation-suit protection and leaks, secret sectors, and the low-health exit. Live player power, damage, and bonus counters advance after weapon sprites. |
| `r_main.c`, `r_plane.c`, `r_segs.c`, `r_things.c` | Invulnerability and infrared COLORMAP rows for walls, flats, masked textures, sprites, and weapons. The sky uses its full-bright row. |
| `p_doors.c`, `p_floor.c`, `p_map.c`, `p_spec.c`, `p_switch.c` | Front-side use tracing, manual and tagged doors with optional key locks, walkover and timed doors, and switch textures with button timers. BSP rendering and terrain collision read the same moving sector ceiling. |
| `g_game.c`, `p_spec.c`, `p_switch.c` | Switch and walkover exit requests, including the secret-exit fallback when a commercial WAD lacks MAP31. |
| `g_game.c`, `wi_stuff.c`, `f_finale.c` | Normal and secret campaign routing, single-player statistics, carried inventory, animated intermissions, episode ending art, and the Doom II cast. The preview loads flats, glyphs, and patches from the supplied WAD. |
| `st_stuff.c`, `st_lib.c` | Single-player status bar, animated face, and damage, pickup, berserk, and radiation palette shifts. The preview reads `STBAR`, the widget patches, and `PLAYPAL` from the supplied WAD. |
| `am_map.c`, `r_segs.c` | Single-player automap, discovered linedefs, computer map power, blockmap grid, panning, zoom, player arrow, and WAD-backed numbered marks. |
| `hu_stuff.c`, `hu_lib.c` | Single-line gameplay messages with native priority, timeout, and refresh behavior. The preview draws them using the supplied WAD's `STCFN` patches. |
| `s_sound.c`, `sounds.c`, `i_sound.c` | WAD sound lookup, alias and priority tables, pitch variation, positional stereo, eight-channel 16-bit PCM mixing, and level and intermission track selection. |
| `p_floor.c`, `p_spec.c`, `p_switch.c` | Tagged floor movers, floor material transfer, shared plane stepping, stair builders, and donut transfers. |
| `p_ceilng.c`, `p_spec.c`, `p_switch.c` | Ceiling lowering and raising, the three cycling crushers, and stop and resume triggers. |
| `p_map.c`, `p_floor.c` | Actor clipping when a door, floor, lift, or crusher moves. Sector checks can block movement, carry actors, crush corpses, remove dropped items, and apply damage and blood effects. |
| `p_plats.c`, `p_spec.c`, `p_switch.c` | Normal and blazing lifts, perpetual platforms, floor raises that change flats, and platform stop and resume triggers. |
| `w_wad.c`, `w_wad.h` | Runtime IWAD, PWAD, and loose-lump mounts with last-match lookup across external imports. |
| `m_random.c` | Deterministic menu and gameplay random streams with separate indices and reset. |
| `p_tick.c` | Bounded thinker list with insertion order and lazy removal. |

`node tests/doom-sprite-effects.mjs --upstream artifacts/doom-upstream` compares the fuzz framebuffer, phase, and every player-ramp mapping with pinned `r_draw.c`. The preview keeps WAD indices during a frame and projects the resulting indices to Logic Arrows colors. It applies fuzz to shadow actors and to the weapon and muzzle flash during Doom's invisibility blink. Rooms drawn with the untextured fallback use index zero where a fuzz sample has no WAD index. `node tests/doom-preview-sprite-effects.mjs` checks the Spectre, a pickup that grants invisibility, and weapon blinking in a synthetic WAD.

## Run the sample

From the repository root, build the sample to a Logic Arrows Level file.

```powershell
dotnet run --project src/Fletcher.Cli -- build examples/doom-engine/main.flt -o artifacts/doom-engine/raster.json
```

The sample exercises the column and span loops and draws a 24×12 frame. Follow the [Logic Arrows map instructions](../../docs/logic-arrows.md) to open the output in the game. Run `node tests/doom-engine.mjs` after building Fletcher to verify the generated code, fixed-point arithmetic, BSP, binary angles, raster output, and synthetic WAD handling.

Run `dotnet run --project src/Fletcher.Cli -- test examples/doom-engine` for the Fletcher movement and combat tests. These cover gravity, landings, missile and skull impacts, player thrust, view bob, and state action resumption using synthetic data.

## Inspect your WAD

```powershell
node examples/doom-engine/inspect-wad.mjs 'C:\path\to\your.wad'
node examples/doom-engine/inspect-wad.mjs 'C:\path\to\your.wad' NODES
```

The inspector reads the header and directory and reports validated offsets and sizes. To use a WAD from Fletcher, build the header probe using `readFile()` and point `--asset-root` at the directory containing `DOOM.WAD`.

```powershell
dotnet run --project src/Fletcher.Cli -- build examples/doom-engine/wad-probe/main.flt --asset-root "$env:USERPROFILE\Downloads" -o artifacts/doom-engine/wad-header.json
```

The probe logs the WAD signature, size, lump count, and directory offset on its first tick. Its file reads all fold to constants, so the map contains only the header values it uses.

For a layered project, use `wad.OpenArchive(readFile("BASE.WAD"))`, then `wad.AddArchive(mounts, readFile("ADDON.WAD"))`. Later sources override earlier lump names. `wad.LoadMountedTextureSet(mounts)` can read texture definitions and patches from different sources. `wad.LoadMountedLevel(mounts, name)` selects the winning map marker and reads its geometry from that archive. Put both files under `--asset-root`. The generated map includes the imports in its compressed payload.

The BSP preview builds the WAD directory and texture name indexes in batches of up to 1,024 entries. Other callers can stage `mounts.BuildIndex(batch)` across ticks. `Find` scans the directory in reverse during indexing and uses the completed index when `IndexReady()` is true. Paged collision chains grow with the archive and preserve the last matching lump.

Run `node tests/doom-wad-mounts.mjs`, `node tests/doom-wad-index.mjs`, `node tests/doom-textures.mjs`, and `node tests/doom-flats.mjs` for layered resource and map tests. `node tests/doom-random.mjs` tests the independent random streams.

## Preview an original level

The wireframe sample reads the first classic Doom-format level in an original `LEVEL.WAD` PWAD. It uses `LINEDEFS` and `VERTEXES` to draw a top-down view. White lines are one-sided and blue lines are two-sided. The archive stays at `--asset-root` and the generated Level file embeds it in the zlib-compressed map data. The preview has a 256-linedef limit and checks the raster work before drawing a frame.

```powershell
dotnet run --project src/Fletcher.Cli -- build examples/doom-engine/wad-view/main.flt --package-root examples/doom-engine --asset-root 'C:\path\to\your\original-wad-folder' -o "$env:TEMP\wad-wireframe.json"
```

After building Fletcher, `node tests/wad-view.mjs --output artifacts/doom-engine/original-wad-wireframe.json` builds and verifies the demo with a synthetic level. The test creates the input WAD in a temporary directory and removes it when it finishes.

## Draw walls, floors, and ceilings from a first-person view

The BSP sample reads an external `LEVEL.WAD` and draws the level from its player-one start. An IWAD opens at E1M1 or MAP01 when that opening map is available. A standalone PWAD or an IWAD without its opening map uses the first classic level in directory order. It validates up to 65,536 segment records and 32,767 BSP nodes with bitsets. It indexes both texture directories in batches, preserving the first matching texture across `TEXTURE1` and `TEXTURE2`. The solid screen uses `slice = true` so a large frame can finish across several game ticks. Hold movement keys through a frame to reach the next input sample.

Near walls and openings clip farther surfaces. Compatible plane columns merge before sampling. Floors and ceilings use named WAD flats and distance lighting. Walls use named sidedef textures, scale lighting, pegging, and offsets. Middle textures on two-sided walls preserve their transparent gaps and draw in depth order with sprites. `F_SKY1` uses the map’s sky texture at full brightness. The sample projects the first `PLAYPAL` palette to eight Logic Arrows colors. Missing wall and plane materials use preview colors or checker patterns.

The preview allocates actors from `THINGS` in map order at the selected skill and stores their records and links in pages. It uses Doom's actor metadata for the starting state, sprite rotation, fullbright flag, and floor or ceiling placement. It reads sprite patches from the external WAD. Passive actors advance through action-free sprite states at their original tic durations, including the randomized first duration. The port checklist tracks the remaining work on the shared actor scheduler.

Actors are linked by sector and by BLOCKMAP cell when a valid BLOCKMAP is present. The renderer submits each sector's sprites once when the BSP walk reaches it. Player movement updates both lists after relocation, and a passive actor reaching the null state is unlinked.

The walking preview checks actors before lines on each move attempt, including slide retries. Solid actors block movement and eligible pickups update the player's inventory immediately. A collected item's sprite disappears even when a later line blocks the attempted move.

`node tests/doom-actor-spawn.mjs` checks actor startup against a pinned C trace. Pass `--upstream artifacts/doom-upstream` to rebuild the trace with GCC from `p_setup.c`, `p_mobj.c`, `p_mobj.h`, `info.c`, `info.h`, `sounds.h`, and `m_random.c` saved as `light-m_random.c`. The fixture provides its own `THINGS` and sector geometry. [Pinned Doom source](https://github.com/id-Software/DOOM/tree/a77dfb96cb91780ca334d0d4cfd86957558007e0/linuxdoom-1.10)

`node tests/doom-actor-state.mjs` checks state entry, action dispatch and resumption, terminal frames, and the Nightmare respawn request against a pinned C trace. Pass `--upstream artifacts/doom-upstream` to rebuild that trace with GCC from `p_mobj.c` and `light-m_random.c`. The fixture supplies synthetic action effects so it can check how each effect changes the state machine.

`node tests/doom-actor-links.mjs` checks sector and BLOCKMAP list order, moves and removals, flag exclusions, and iterator early exit against a pinned C trace. Pass `--upstream artifacts/doom-upstream` to rebuild the trace with GCC using `p_maputl.c` saved as `movement-p_maputl.c`. The fixture supplies a synthetic partition and BLOCKMAP dimensions.

`node tests/doom-thing-contacts.mjs` and `node tests/doom-inventory.mjs` check contact order and pickup state against pinned C traces. Pass `--upstream artifacts/doom-upstream` to rebuild the traces with GCC. The contact oracle uses `movement-p_map.c`, `movement-p_maputl.c`, and `light-m_random.c`. The inventory oracle uses `p_inter.c`, `p_mobj.h`, `info.h`, and `sounds.h`.

`node tests/doom-damage.mjs` checks 47 combat and moving-actor traces produced by a compiled Logic Arrows map. Pass `--upstream artifacts/doom-upstream` to rebuild the comparison with GCC from `p_inter.c`, `p_mobj.c`, `movement-p_map.c`, `movement-p_maputl.c`, `p_mobj.h`, `info.c`, `info.h`, `sounds.h`, `r_main.c`, `tables.c`, `m_fixed.c`, and `light-m_random.c`. State action stubs draw from Doom's RNG in selected cases to check impact and callback order, and the geometry fixture provides a single sector with empty line lists.

`node tests/doom-sight.mjs` checks sight, blast damage, and monster attack range using synthetic geometry in a compiled Logic Arrows map. Pass `--upstream artifacts/doom-upstream` to rebuild the comparison with GCC from `p_sight.c`, `p_enemy.c`, `movement-p_map.c`, `movement-p_maputl.c`, `m_fixed.c`, and `light-m_random.c`. The C fixture records the damage calls in blast order. The Fletcher fixture executes them and follows a falling rocket through its blast and death state.

`node tests/doom-hitscan.mjs` checks aiming and shooting through the mixed BLOCKMAP path. It compares intercept fractions and tie order, special-line events, wall and actor impacts, puff and blood spawn state, damage requests, shotgun spread, and punch and chainsaw behavior. The compiled Fletcher fixture applies the requests to its world and starts a tagged door through the normal impact dispatcher. Pass `--upstream artifacts/doom-upstream` to rebuild the C comparison with GCC using `movement-p_map.c`, `movement-p_maputl.c`, `p_mobj.c`, `p_mobj.h`, `p_pspr.c`, `r_main.c`, `m_fixed.c`, `tables.c`, `info.c`, `info.h`, `sounds.h`, and `light-m_random.c`.

`node tests/doom-projectiles.mjs` checks monster and player launch routines. It compares autoaim, shadow-target spread, launch sound order, first-step actor and wall collision, and immediate explosions. Pass `--upstream artifacts/doom-upstream` to rebuild against the same pinned sources as the hitscan and damage fixtures.

`node tests/doom-weapons.mjs` checks weapon and muzzle-flash states tic by tic across all nine weapons. The scenarios cover ammo thresholds, held fire, switching, bob, reload, and death. Pass `--upstream artifacts/doom-upstream` to compare with the pinned C using `p_pspr.c`, `p_enemy.c`, `d_items.c`, `doomdef.h`, `info.c`, `info.h`, `sounds.h`, `tables.c`, `m_fixed.c`, and `light-m_random.c`. The hitscan and projectile suites also drive the player tick with actual combat state on synthetic maps. `node tests/doom-preview-weapons.mjs` verifies repeated fire, sprite transitions, weapon cycling, rocket movement, barrel explosion damage, and effect expiry through the preview's native keyboard tiles in the simulator.

`node tests/doom-noise.mjs` checks sector sound transmission through opened doors, fallback paths, and sound blockers. Pass `--upstream artifacts/doom-upstream` to compare against `p_enemy.c` and `movement-p_maputl.c`. Weapon alerts now feed the preview's monster hearing. `node tests/doom-monsters.mjs` checks target selection, chase decisions and RNG, and direction-search order. With `--upstream artifacts/doom-upstream`, it runs pinned `p_enemy.c` with the cached random table, angle helpers, and sound definitions. `node tests/doom-monster-move.mjs` checks live terrain and actor collision, floating steps, and monster door use. The preview weapon suite verifies that a rear-facing imp hears a shot, pursues, and launches a fireball.

`node tests/doom-heavy-actions.mjs` checks revenant melee, launch and homing, the mancubus volleys, and pain elemental lost soul spawning, including the cap and blocked-spawn damage. Pass `--upstream artifacts/doom-upstream` to match the traces against the corresponding `p_enemy.c` actions and `p_mobj.c` missile routines compiled with the pinned actor metadata and math tables. The preview weapon suite follows a revenant missile across two visible frames in a synthetic MAP01 room.

`node tests/doom-vile.mjs` checks arch-vile attacks and resurrection in Logic Arrows. Pass `--upstream artifacts/doom-upstream` to compile the pinned `p_enemy.c` actions with the actor spawn and state routines from `p_mobj.c`. The C probe supplies sight, collision, and damage callbacks for the synthetic scene. Fletcher performs the corresponding sight and collision checks and applies both direct and splash damage.

`node tests/doom-boss-deaths.mjs` checks episode and map gates, living-player and boss checks, and the tagged movers and exit requests. `node tests/doom-brain.mjs` checks cube targeting and flight, all monster outcomes, spawn effects, telefrag order, and the 65-rocket death sweep. Both support `--upstream artifacts/doom-upstream`. The preview logs whether the exit is normal or secret and starts the next campaign phase for a classic Doom map name.

During the intermission, press **F** or **R** to finish counting the stats. Release and press again to continue. Episode maps show the next location before loading it. If a Doom II route crosses a story stage, use either key to advance after its opening delay. Health, armor, weapons, and ammo carry over. Each level starts with fresh map statistics, keys, and timed powers.

`node tests/doom-campaign.mjs --upstream artifacts/doom-upstream` checks campaign routes and level-finish state against pinned `g_game.c`. `node tests/doom-intermission.mjs --upstream artifacts/doom-upstream` checks the intermission ticker against pinned `wi_stuff.c`. `node tests/doom-preview-campaign.mjs` exercises the actual preview with a synthetic multi-map WAD.

Episode finales start on the tic after the exit and leave the story on screen for Doom's original interval before showing the ending art. After MAP30, press **F** or **R** to start the cast after the story delay. Holding that button restarts the cast and its wipe. Release it, then press a fresh gameplay key to start the current cast member's death animation. **P** also acts as a cast key. A gameplay key tapped during the cast wipe is carried into the first cast tic. The next cast member appears automatically. Finale tracks and cues go through the Music Arrows.

To supply finale text, put plain ASCII files such as `E1TEXT.txt` beside your WAD in the directory passed to `--asset-root`. `E1TEXT.txt` through `E4TEXT.txt` supply the episode endings. `C1TEXT.txt` through `C6TEXT.txt` supply the aftermath of MAP06, MAP11, MAP20, MAP30, the MAP15 secret exit, and the MAP31 secret exit, respectively. `FCAST00.txt` through `FCAST16.txt` label the cast in display order. Use LF line endings. Each nonempty file overrides the WAD lump of the same base name, and text stops at a NUL byte or 4,096 bytes. The compiler reads the files into the compressed map without editing your WAD.

Vanilla IWADs supply the font and graphics. Their story and cast text lived in the original executable. A supplied episode story sets the reveal and wait interval from its length. With no text source, the preview presents the backdrop for the original interval before advancing to the ending art.

Run `node tests/doom-finale.mjs --upstream artifacts/doom-upstream` and `node tests/doom-finale-cast.mjs --upstream artifacts/doom-upstream` to compare the ticker, scroll, cast animation, and audio events with pinned `f_finale.c` and the original actor tables. Omitting `--upstream` checks the same traces against saved hashes. `node tests/doom-preview-finale.mjs` drives both paths through keyboard tiles and checks the synthetic WAD's visible text, ending art, and cast sprites.

`node tests/doom-player-sectors.mjs --upstream artifacts/doom-upstream` checks damage timing, suit protection, secret clearing, and the low-health exit. `node tests/doom-preview-player-sectors.mjs` drives these effects through the preview's walking controls and verifies live health and secret counts.

`node tests/doom-player-counters.mjs --upstream artifacts/doom-upstream` compares the live counter updates with pinned `p_user.c`. Invulnerability and infrared use the supplied WAD's fixed COLORMAP rows, including Doom's blink near expiration.

The status bar shows current weapon ammo, health, armor, weapons, keys, and ammo reserves when the WAD supplies `STBAR`. Press **H** to switch between the status bar and the full-height view. Damage, pickups, berserk, and the radiation suit select classic `PLAYPAL` rows in both views. Run `node tests/doom-status-palette.mjs --upstream artifacts/doom-upstream`, `node tests/doom-status-face.mjs --upstream artifacts/doom-upstream`, and `node tests/doom-preview-status.mjs` to check the selection logic, face animation, and compiled preview.

Press **M** to open or close the automap. **G** toggles the grid, **U** toggles player follow, **Z** and **C** zoom, and **B** switches between the full-level scale and the previous view. Use **W/A/S/D** to pan with follow off. **N** places a numbered mark at the center and **V** clears all marks. The preview reads mark art from the supplied WAD's `AMMNUM0` through `AMMNUM9` lumps.

The automap shows walls discovered by the first-person renderer and lines marked visible by the WAD. A computer map pickup reveals eligible unexplored lines. With the automap open, press **I**, **D**, **D**, **T** in sequence, releasing each key before the next. The first sequence reveals every linedef, including hidden lines. The second adds directional actor markers. The third restores normal visibility. Opening the automap leaves gameplay running. Press **P** to freeze gameplay while keeping the map controls available.

The level title uses the WAD's title patch or displays its map marker with the WAD's font. Run `node tests/doom-preview-automap.mjs` to verify controls, reveal modes, and title placement on a synthetic WAD. Run `node tests/doom-automap-reveal.mjs --upstream artifacts/doom-upstream` to compare the key sequence against pinned `am_map.c`, `m_cheat.c`, and `m_cheat.h`. Pass `--upstream artifacts/doom-upstream` to `node tests/doom-automap-view.mjs` to compare camera movement with id's `AM_Ticker` routines.

Pickups, locked doors, and automap settings display a short message in the upper-left corner. Each message lasts 140 game tics. Press **J** to recall the last message or **K** to toggle messages. The preview reads the font from the supplied WAD. Run `node tests/doom-hud-messages.mjs --upstream artifacts/doom-upstream` for the native timing and priority comparison or `node tests/doom-preview-hud-messages.mjs` to check display, recall, and expiration in the simulator.

Press **T** after a level loads to open the single-player campaign menu. Use **W/S** to move, **F** to confirm, and **T** to go back. Doom offers the episode starts available in your WAD, and Doom II goes straight to difficulty. Nightmare asks you to confirm **Start**. The menu holds gameplay while you choose. Intermissions and endings continue behind it, including scene wipes and the handoff to the next level. Closing the menu reveals the current scene. A new campaign starts with fresh inventory at the chosen difficulty. [Upstream campaign menu flow](https://github.com/id-Software/DOOM/blob/master/linuxdoom-1.10/m_menu.c) · [Upstream display loop](https://github.com/id-Software/DOOM/blob/a77dfb96cb91780ca334d0d4cfd86957558007e0/linuxdoom-1.10/d_main.c)

To change the initial difficulty on map import, set `previewCombatSkill` in `wad-bsp/combat-preview.flt` and rebuild. `previewFastMonsters` and `previewRespawnMonsters` are independent switches.

Press **P** to pause or resume. In a level, the level clock and soundtrack hold their positions, and the preview overlays the supplied WAD's `M_PAUSE` graphic. The status face and HUD message timer keep ticking during pause and behind the campaign menu. During intermissions and story endings, **P** pauses or resumes the current track while the stage clock keeps running. An intermission treats the pause command as an attack press, which can advance the score screen. Run `node tests/doom-preview-campaign-controls.mjs` to verify level pause and resume through the compiled map.

Press **Y** while alive in a level to quicksave and **L** to load the latest checkpoint. The slot restores the saved level, inventory, moving sectors, enemies, clocks, view, and soundtrack position, including when you load from a later level. You can save while paused. The slot lasts for the current Logic Arrows simulation and is cleared when you reopen the map. [Logic Arrows script state](https://steamcommunity.com/sharedfiles/filedetails/?id=3838543996)

### Sound engine

The Logic Arrows preview powers native Music Arrows for weapon fire, pickups, actor pain and death, hard landings, doors, lifts, crushers, switches, explosions, teleports, stage changes, and denied use. Pressing **F** against an ordinary wall or closed portal plays the denied-use cue. Positional cues use Doom's distance cutoff, including the map-eight exception. Doors, lifts, and crushers use the center of their sector's linedef bounds. Simultaneous audible mechanism sounds share one synthesized pulse. Press **O** to mute or unmute the cues. Run `node tests/doom-preview-music-arrows.mjs` to verify gameplay-to-arrow signals and mute control. Add `--upstream artifacts/doom-upstream` to compare actor sound IDs, sound origins, and gameplay RNG with pinned C. `node tests/doom-preview-mover-audio.mjs` verifies timed-door audibility and checkpoint replay.

Actor cues and each teleport fog use Doom's distance and map-eight audibility rules before triggering a Music Arrow. Player and global sounds, including the Cyberdemon and Spider Mastermind wake-up roars, keep their original global or local origin. The native positional cases run with `node tests/doom-preview-spatial-cues.mjs --upstream artifacts/doom-upstream`.

The preview sequences the supplied WAD's MUS soundtrack through sixteen Music Arrow voices. Each voice alternates between two physical arrows so repeated notes can trigger on consecutive host ticks. The score advances in four-clock intervals at 140 Hz. If a host update is late, it uses open voices for overdue notes and queues any overflow in score order. A checkpoint saves the score cursor and queued notes. Music continues behind the campaign menu, pauses with **P**, and starts the intermission track as the wipe begins. The arrows use their own instruments and note lengths. **O** mutes the soundtrack and gameplay cues together.

The `audio` package reads the WAD's `DS*` sound lumps and mixes stereo samples at Doom's Linux output rate of 11,025 Hz. It uses the original pitch increments, stereo gains, sample padding, and signed clipping. Sample-accurate live playback requires a PCM host sink.

Run `node tests/doom-audio-pcm.mjs`, `node tests/doom-audio-spatial.mjs`, and `node tests/doom-audio-effects.mjs` with the pinned Doom sources in `artifacts/doom-upstream`. These tests compare compiled Fletcher output with the original mixer, positioning and priority routines, sound and music tables, and level track selector.

### Display resolution

The preview defaults to 128×96 for faster testing. Set `Width = 320` and `Height = 200` in `wad-bsp/display.flt` to build at Doom's original resolution. Controls and camera framing follow the framebuffer size. Both sizes use ordered dithering to preserve neutral grays, dark texture detail, and warm colors within Logic Arrows' eight solid colors. Set `DitherColors = false` to use the flat palette projection in comparison builds.

Press **T** to open the campaign menu, then **G** to switch between high and low detail. Low detail samples the 3D view once for each pair of horizontal pixels. At 320×200 the renderer projects 160 columns for a full-width view. The HUD, automap, menus, and intermissions draw at display width. Each pair shares a WAD palette index and picks its two dither swatches at their final positions. `LowDetail` in `wad-bsp/display.flt` sets the starting mode. [id Software's view setup](https://github.com/id-Software/DOOM/blob/a77dfb96cb91780ca334d0d4cfd86957558007e0/linuxdoom-1.10/r_main.c#L669-L760) [id Software's raster routines](https://github.com/id-Software/DOOM/blob/a77dfb96cb91780ca334d0d4cfd86957558007e0/linuxdoom-1.10/r_draw.c)

Press **J** in the campaign menu to cycle through Doom's five gamma levels. The preview applies Doom's table to the displayed WAD palette before mapping colors to Logic Arrows tiles. The setting travels with an in-session checkpoint. [id Software's gamma tables](https://github.com/id-Software/DOOM/blob/a77dfb96cb91780ca334d0d4cfd86957558007e0/linuxdoom-1.10/v_video.c#L51-L137)

Press **T** during play and use **A/D** in the campaign menu to shrink or enlarge the 3D view. The slider ranges from 3 blocks up to full screen at 11. Press **H** during play to toggle between full screen and your last size with the HUD. `ViewBlocks` in `wad-bsp/display.flt` sets the starting size and defaults to 10. At 320×200, seven blocks give a 224×112 view above the full-width HUD. The border uses the mounted WAD, and the same physical lighting arrows supply every viewport size. [id Software's screen-size controls](https://github.com/id-Software/DOOM/blob/a77dfb96cb91780ca334d0d4cfd86957558007e0/linuxdoom-1.10/m_menu.c#L1078-L1100) [id Software's viewport setup](https://github.com/id-Software/DOOM/blob/a77dfb96cb91780ca334d0d4cfd86957558007e0/linuxdoom-1.10/r_main.c#L669-L760) [id Software's border renderer](https://github.com/id-Software/DOOM/blob/a77dfb96cb91780ca334d0d4cfd86957558007e0/linuxdoom-1.10/r_draw.c#L695-L866)

The lighting circuit starts 52 tiles below the screen at its left edge. Pan down and left in Logic Arrows to inspect its eight banks of arrows. The circuit computes the COLORMAP light rows at startup. The renderer uses those rows to shade walls, floors, and ceilings during play.

Press **F** after dying to restart the current level with Doom's starter inventory. `node tests/doom-player-death.mjs --upstream artifacts/doom-upstream` compares the death camera and rebirth input with pinned `p_user.c`. `node tests/doom-preview-player-restart.mjs` verifies the reload and clock continuity through the preview's controls.

`node tests/doom-teleport-lines.mjs` checks tagged destinations, front and back crossings, one-shot and repeatable triggers, player and monster restrictions, and the two fog spawns. Pass `--upstream artifacts/doom-upstream` to compile the pinned `p_telept.c`, the teleport and stomp routines from `movement-p_map.c`, and `P_CrossSpecialLine` from `animated-p_spec.c`. The C probe records telefrag requests and their death-tic RNG draw. Fletcher applies the damage and verifies the resulting deaths.

```powershell
dotnet run --project src/Fletcher.Cli -- build examples/doom-engine/wad-bsp/main.flt --package-root examples/doom-engine --asset-root 'C:\path\to\your\original-wad-folder' -o "$env:TEMP\wad-bsp.json"
```

For maps with a valid `BLOCKMAP`, enable the game's Key mode. **W/S** walk forward or back, **A/D** turn, and **Q/E** strafe. Hold **I** with any of these keys for Doom's running speed. A held turn accelerates on the sixth gameplay tic. **F** uses doors and switches and **R** fires. Press **1–8** for Doom's numbered weapon slots, including **1** for fist or chainsaw and **3** for shotgun or super shotgun. **X** cycles owned weapons. A key pulse is sampled at the start of a logical tic, which can span multiple host ticks. Doom's friction slows the player on subsequent tics. Weapon and flash patches come from the external WAD. Maps missing a valid `BLOCKMAP` keep the camera at the player start. `node tests/wad-view.mjs --walkingOutput artifacts/doom-engine/original-wad-walking.json` builds a synthetic walking demo and checks its rendered response to the keys in the Logic Arrows simulator.

Press **9** to toggle mouse movement. Horizontal motion turns, and vertical motion walks forward or back. Hold **0** to strafe with horizontal mouse motion or **A/D**. Press **T** and use **Q/E** to adjust mouse sensitivity from 0 to 9. The default is 5. Logic Arrows supplies absolute window positions, so press **9** to suspend mouse input while you reposition the pointer. Pointer movement over the automap, while paused, or in menus does not carry into gameplay. **F** and **R** remain the use and fire controls.

`node tests/wad-view.mjs --animatedOutput artifacts/doom-engine/original-wad-animated.json` builds a synthetic scene with an animated floor and wall. The preview resolves Doom's built-in frame ranges from the WAD and advances them every eight game tics, including while the camera is stationary. The test compares the rendered material choices with pinned Doom C.

`node tests/wad-view.mjs --scrollOutput artifacts/doom-engine/original-wad-scrolling.json` builds a synthetic wall with line special 48. Each tic advances its first sidedef by one texture column. The fixture checks the rendered offsets and verifies that the texture wraps.

`node tests/wad-view.mjs --lightOutput artifacts/doom-engine/original-wad-sector-lights.json` builds a synthetic room with a fast synchronized strobe. Its lighting applies to walls, planes, and sprites. The preview holds up to 64 lighting records, shared between thinkers and direct sector overrides. `node tests/doom-sector-lights.mjs` checks the eight sector-start specials against pinned C, including sectors with no darker neighbor.

`node tests/wad-view.mjs --taggedLightOutput artifacts/doom-engine/original-wad-tagged-light.json` builds a synthetic corridor. Walk forward with **W** in Key mode to brighten the room beyond the portal. Walkover triggers cover minimum and maximum neighbor light, fixed levels 35 and 255, and a slow strobe. Buttons 138 and 139 set levels 255 and 35. Their texture resets on tic 35 while the new sector light stays in effect.

Run `node tests/doom-tagged-lights.mjs` to check the pinned native trace. To rebuild the C reference with `gcc`, append the Fletcher CLI assembly path and local paths to the pinned `p_lights.c`, `p_spec.c`, and `m_random.c` files in that order.

`node tests/wad-view.mjs --doorOutput artifacts/doom-engine/original-wad-door.json` builds a synthetic passage with a shut vertical door. Face it and press **F** to raise it. The preview supports unlocked manual specials 1, 31, 117, and 118 and reverses eligible closing doors when the player blocks the opening. `node tests/doom-doors.mjs` compares the door thinker traces with pinned C.

`node tests/wad-view.mjs --taggedDoorOutput artifacts/doom-engine/original-wad-tagged-door.json` builds a passage with a walkover trigger. Use **W** in Key mode to cross the trigger and open the tagged door. The preview also schedules sector specials 10 and 14 at their original 1,050- and 10,500-tic delays. For special 10, Fletcher uses the initial ceiling and normal wait time if an obstruction makes the door reopen. The upstream spawner leaves those reopening fields unset.

`node tests/wad-view.mjs --switchOutput artifacts/doom-engine/original-wad-door-switch.json` builds a synthetic passage with a reusable door button. Press **F** in Key mode to use it from the front. Successful activation flips a compatible texture on the front sidedef. A one-shot switch keeps the new texture, and a reusable button restores its original texture on the 35th update, counting the activation tic. The preview infers Doom's switch table edition from map markers. Partial WADs need both textures in a pair to display the change.

Run `node tests/doom-switches.mjs` for the switch table and button regressions. To compare with pinned C, append the Fletcher CLI assembly path and local paths to the upstream `p_switch.c` and `p_spec.c` files in that order. The comparison compiles a small harness with `gcc` and runs the original switch and button routines.

Pick up a card or skull in the matching color, then press **F** from the front of a keyed door or switch. The preview reports the required color on a failed attempt. Release **F** before pressing again. `node tests/doom-keyed-doors.mjs` verifies keyed doors and exit triggers. Pass `--upstream artifacts/doom-upstream` to compare with the pinned `door-p_doors.c`, `switch-p_switch.c`, `animated-p_spec.c`, `g_game.c`, and `sounds.h`. `node tests/doom-preview-keyed-door.mjs` tests pickups, use, traversal, and exits in the Logic Arrows simulator.

`node tests/wad-view.mjs --floorOutput artifacts/doom-engine/original-wad-moving-floor.json` builds a synthetic passage with a floor switch. Press **F** in Key mode to raise the floor beyond the portal by 16 map units. The preview keeps up to 48 floor records. Floor and door movers share sector occupancy. Texture-height raises require a valid lower texture. A lower-and-change action with no matching neighbor keeps the original flat and sector special. Floor crushing uses the original plane movement rules with the preview player's terrain clearance. Actor damage and sound events are pending.

Run `node tests/doom-floors.mjs` for the floor and plane-step traces. Append the Fletcher CLI assembly path and a local copy of the pinned `p_floor.c` to compile the original routines with `gcc` and compare the results directly.

`node tests/wad-view.mjs --stairsOutput artifacts/doom-engine/original-wad-stairs.json --donutOutput artifacts/doom-engine/original-wad-donut.json` builds two synthetic use-switch scenes. Press **F** in Key mode to raise a staircase or move a donut's ring and center to its model sector's height. The ring takes the model flat when it finishes. Stair specials 7 and 8 build 8-unit steps at a quarter unit per tic. Specials 100 and 127 build 16-unit steps at four units per tic. Special 9 moves both donut floors at half a unit per tic.

The preview initializes stair crushing to false and leaves the flat unchanged. The pinned stair allocator leaves its crush and floor type fields unset. A donut with an invalid first connection or a missing selected back sector leaves the switch available.

Run `node tests/doom-stairs-donuts.mjs` to check the stair setup and donut thinker traces. Append the Fletcher CLI assembly path and local copies of the pinned `p_floor.c` and `p_spec.c` in that order to rebuild the C reference with `gcc`.

`node tests/wad-view.mjs --ceilingOutput artifacts/doom-engine/original-wad-ceiling.json` builds a synthetic passage with a lowering ceiling. Press **F** in Key mode to use the switch. Ceiling specials keep their place in thinker order when stopped, and dormant ceilings still occupy their sector. Special 40 starts the ceiling before trying the floor, so the ceiling's claim normally prevents the floor from moving. The preview preserves Doom's 30-entry active ceiling registry within its 48 retained ceiling records. Crush damage to actors and sound events are pending.

Run `node tests/doom-ceilings.mjs` to check the ceiling movement and registry traces. Append the Fletcher CLI assembly path and local copies of the pinned `p_ceilng.c` and `p_floor.c` in that order to rebuild the C reference with `gcc`.

`node tests/wad-view.mjs --platformOutput artifacts/doom-engine/original-wad-platform.json` writes a synthetic lift scene. Press **F** in Key mode to lower the lift by 16 map units. It waits 105 tics and returns to its starting height. Platforms share the preview's 48 retained floor records and Doom's 30-platform active limit. A stopped platform retains its active slot and sector, and a perpetual trigger can resume it without drawing another random number. The three impact line actions are available through `ShootLevelSpecial` for callers that have already resolved the hit linedef.

Run `node tests/doom-platforms.mjs` for platform movement, linedef activation, and the active platform limit. Append the Fletcher CLI assembly path, the pinned `p_plats.c` path, and the pinned `p_floor.c` path in that order to rebuild the reference with `gcc`. The fixture reads `p_spec.c`, `p_switch.c`, and `sounds.h` from the same directory as `p_plats.c`.

Run `node tests/wad-view.mjs --portalOutput artifacts/doom-engine/original-wad-portals.json` to build the sample with a synthetic level containing two adjacent openings. The fixture uses separate WAD, lookup-table, and code Script Blocks. It checks the whole frame against the pinned upstream wall and plane loops with the same procedural palette. `node tests/doom-projection.mjs` checks projection, wall scale, plane sampling, and span generation against the pinned upstream C.

`node tests/wad-view.mjs --mergedOutput artifacts/doom-engine/original-wad-merged.json` also writes a scene with two adjacent walls sharing the same floor and ceiling. Its frame matches merged visplane output from the pinned C. Run `node tests/doom-visplanes.mjs` for allocator checks and `node tests/doom-textures.mjs` for resource-decoding checks.

`node tests/wad-view.mjs --texturedOutput artifacts/doom-engine/original-wad-textured.json` writes a scene that includes original synthetic flats and palette data. The test compares two camera headings and light levels with the upstream C sampler using the same eight-color projection.

`node tests/wad-view.mjs --wallOutput artifacts/doom-engine/original-wad-walls.json` also writes a WAD-textured wall scene. The C comparisons include opaque middle walls, both portal tiers, and a rotated camera. The input WADs are generated temporarily from original synthetic data.

`node tests/wad-view.mjs --skyOutput artifacts/doom-engine/original-wad-sky.json` writes the sky comparison scene. Two camera headings exercise sky sampling and the transition between outdoor sectors with different ceiling heights.

`node tests/wad-view.mjs --spriteOutput artifacts/doom-engine/original-wad-sprites.json` writes a scene with an original synthetic sprite behind a portal. The fixture also checks transparency and complete concealment behind a nearer opaque wall.

`node tests/wad-view.mjs --maskedOutput artifacts/doom-engine/original-wad-masked.json` writes a scene with a sprite visible through a synthetic fence. The fixture checks the sprite on both sides of the fence and compares single-patch masked raster output with the pinned C for both pegging modes. Overlapping patches use Fletcher’s bounded transparent texture composite.

`node tests/doom-movement.mjs` runs terrain movement in a generated Logic Arrows map. `node tests/doom-horizontal.mjs` checks fixed-point momentum and wall slides, including diagonal walls and sky-backed missile impacts. Both use synthetic WADs. The renderer and movement routines share BSP sector lookup.

## Regenerate the translated routines

Run `node examples/doom-engine/generate-actor-tables.mjs artifacts/doom-upstream` to regenerate the actor kinds, state records, sprite names, and weapon metadata. The generator reads `info.c`, `info.h`, `p_mobj.h`, `sounds.h`, and `d_items.c` from the pinned Doom source. The state data uses two immutable scalar arrays to stay within Fletcher's 4,096-element array limit.

`source/portable-engine.c` adapts the upstream C to Fletcher’s integer calling convention. It uses 32-bit halves for fixed-point multiplication, integer division for the fractional part, and scalar parameters in place of C pointers. Fixed-point division and angle calculations use unsigned magnitudes for `INT_MIN`. Other geometry and draw loops in `engine/` were ported by hand. The constant array in `engine/slope-table.flt` contains the 2,049 upstream `tantoangle` values and is shared between angle lookups.

```powershell
$port = 'examples/doom-engine'
$temp = 'artifacts/doom-engine/portable.flt'
dotnet run --project src/Fletcher.Cli -- transpile-c "$port/source/portable-engine.c" -o $temp
if ($LASTEXITCODE -ne 0) { throw 'C translation failed' }
$notice = (Get-Content "$port/numeric/portable.flt" -TotalCount 3) -join "`n"
$generated = (Get-Content $temp -Raw).Replace("`r`n", "`n")
Set-Content "$port/numeric/portable.flt" -Value ($notice + "`n" + $generated) -NoNewline
```
