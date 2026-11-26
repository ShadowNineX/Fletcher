// SPDX-License-Identifier: GPL-2.0-only
/* Headless driver for pinned Linux Doom. Gameplay and S_ sound scheduling
 * come from the original sources. I_ output callbacks are inert. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "doomstat.h"
#include "g_game.h"
#include "i_net.h"
#include "i_sound.h"
#include "i_video.h"
#include "m_argv.h"
#include "p_local.h"
#include "r_main.h"
#include "s_sound.h"
#include "st_stuff.h"
#include "v_video.h"
#include "w_wad.h"
#include "z_zone.h"

extern int prndindex;
extern int ticdup;
extern int numChannels;
extern void HU_Init(void);
char *sndserver_filename;

void I_InitNetwork(void) {}
void I_NetCmd(void) {}
void I_InitGraphics(void) {}
void I_ShutdownGraphics(void) {}
void I_SetPalette(byte *palette) {}
void I_UpdateNoBlit(void) {}
void I_FinishUpdate(void) {}
void I_ReadScreen(byte *out) { memcpy(out, screens[0], SCREENWIDTH * SCREENHEIGHT); }
void I_StartFrame(void) {}
void I_StartTic(void) {}
void I_InitSound(void) {}
void I_UpdateSound(void) {}
void I_SubmitSound(void) {}
void I_ShutdownSound(void) {}
void I_SetChannels(void) {}
int I_GetSfxLumpNum(sfxinfo_t *effect) {
    char name[9];
    snprintf(name, sizeof(name), "ds%s", effect->name);
    return W_CheckNumForName(name);
}
int I_StartSound(int id, int volume, int separation, int pitch, int priority) { return 0; }
void I_StopSound(int handle) {}
int I_SoundIsPlaying(int handle) { return 0; }
void I_UpdateSoundParams(int handle, int volume, int separation, int pitch) {}
void I_InitMusic(void) {}
void I_ShutdownMusic(void) {}
void I_SetMusicVolume(int volume) {}
void I_PauseSong(int handle) {}
void I_ResumeSong(int handle) {}
int I_RegisterSong(void *data) { return 0; }
void I_PlaySong(int handle, int looping) {}
void I_StopSong(int handle) {}
void I_UnRegisterSong(int handle) {}

int main(int argc, char **argv) {
    char *files[2];
    byte *demo;
    int demoLump, size, at;
    if (argc != 3) {
        fprintf(stderr, "usage: %s IWAD DEMO\n", argv[0]);
        return 2;
    }
    setvbuf(stdout, NULL, _IOLBF, 0);
    myargc = 1;
    myargv = argv;
    files[0] = argv[1];
    files[1] = NULL;
    gamemode = retail;
    ticdup = 1;
    numChannels = 3;
    V_Init();
    Z_Init();
    W_InitMultipleFiles(files);
    R_Init();
    P_Init();
    S_Init(64, 64);
    HU_Init();
    ST_Init();
    demoLump = W_GetNumForName(argv[2]);
    size = W_LumpLength(demoLump);
    demo = W_CacheLumpNum(demoLump, PU_STATIC);
    if (size < 14 || demo[0] != 109 || demo[8] != 0 ||
        demo[9] != 1 || demo[10] || demo[11] || demo[12]) {
        fprintf(stderr, "expected a version 109 single-player demo\n");
        return 2;
    }
    // Linux 1.10 checks its own version byte. The stored 1.9 command
    // layout is the same. Adapt the private cache copy before that check.
    demo[0] = VERSION;
    G_DeferedPlayDemo(argv[2]);
    for (at = 13; at < size && demo[at] != 0x80; at += 4) {
        const player_t *player;
        const mobj_t *body;
        if (size - at < 4) return 2;
        G_Ticker();
        player = &players[consoleplayer];
        body = player->mo;
        if (!body || !demoplayback) return 3;
        printf("\nDEMO-TIC %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d\n",
            gametic, body->x, body->y, body->z, (int)body->angle,
            body->momx, body->momy, body->momz, player->viewz, player->viewheight, player->deltaviewheight,
            player->health, player->armorpoints, player->ammo[am_clip], player->ammo[am_shell],
            player->killcount, player->itemcount, player->secretcount, prndindex,
            player->readyweapon, player->damagecount);
        if ((gametic & 15) == 0) {
            thinker_t *thinker;
            for (thinker = thinkercap.next; thinker != &thinkercap; thinker = thinker->next) {
                const mobj_t *m;
                if (thinker->function.acp1 != (actionf_p1)P_MobjThinker) continue;
                m = (const mobj_t *)thinker;
                printf("DEMO-ACTOR %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d %d\n",
                    gametic, m->type, m->x, m->y, m->z, (int)m->angle, m->momx, m->momy, m->momz,
                    (int)m->flags, m->health, (int)(m->state - states), m->tics, m->sprite, m->frame,
                    m->floorz, m->ceilingz, m->radius, m->height);
            }
        }
        gametic++;
    }
    if (at >= size) return 2;
    return 0;
}
