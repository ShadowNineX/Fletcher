/* SPDX-License-Identifier: GPL-2.0-only
 * Copyright (C) 1993-1996 id Software, Inc.
 * Adapted for Fletcher on 2026-11-21 from id Software's Linux Doom 1.10 source,
 * revision a77dfb96cb91780ca334d0d4cfd86957558007e0.
 */

/* m_swap.c: use Fletcher's 32-bit unsigned calling convention. */
unsigned SwapSHORT(unsigned x) {
    x &= 0xffffu;
    return ((x >> 8) | (x << 8)) & 0xffffu;
}

unsigned SwapLONG(unsigned x) {
    return (x >> 24) | ((x >> 8) & 0xff00u) | ((x << 8) & 0xff0000u) | (x << 24);
}

/* m_fixed.c: compute the middle word of the signed product using 16-bit halves. */
int FixedMul(int a, int b) {
    unsigned lo_a = (unsigned)a & 65535u;
    unsigned lo_b = (unsigned)b & 65535u;
    unsigned hi_a = (unsigned)(a >> 16);
    unsigned hi_b = (unsigned)(b >> 16);
    return (int)((hi_a * hi_b << 16) + hi_a * lo_b + hi_b * lo_a + (lo_a * lo_b >> 16));
}

static unsigned magnitude(int value) {
    if (value < 0) return 0u - (unsigned)value;
    return (unsigned)value;
}

/* m_fixed.c: preserve the saturation test and use integer long division for the fraction. */
int FixedDiv(int a, int b) {
    unsigned numerator = magnitude(a);
    unsigned denominator = magnitude(b);
    int negative = (a ^ b) < 0;
    if ((numerator >> 14) >= denominator) {
        if (negative) return -2147483647 - 1;
        return 2147483647;
    }

    unsigned whole = numerator / denominator;
    unsigned remainder = numerator % denominator;
    unsigned fraction = 0;
    for (int bit = 0; bit < 16; bit++) {
        remainder <<= 1;
        fraction <<= 1;
        if (remainder >= denominator) {
            remainder -= denominator;
            fraction |= 1u;
        }
    }
    unsigned quotient = (whole << 16) | fraction;
    if (negative) return -(int)quotient;
    return (int)quotient;
}

/* tables.c: expand SLOPERANGE and lower the conditional expression. */
int SlopeDiv(unsigned num, unsigned den) {
    if (den < 512u) return 2048;
    unsigned slope = (num << 3) / (den >> 8);
    if (slope > 2048u) return 2048;
    return (int)slope;
}

/* r_main.c: pass the BSP node fields as scalar arguments. */
int R_PointOnSide(int x, int y, int node_x, int node_y, int node_dx, int node_dy) {
    if (!node_dx) {
        if (x <= node_x) return node_dy > 0;
        return node_dy < 0;
    }
    if (!node_dy) {
        if (y <= node_y) return node_dx < 0;
        return node_dx > 0;
    }
    int dx = (int)((unsigned)x - (unsigned)node_x);
    int dy = (int)((unsigned)y - (unsigned)node_y);
    if ((node_dy ^ node_dx ^ dx ^ dy) < 0) return (node_dy ^ dx) < 0;
    int left = FixedMul(node_dy >> 16, dx);
    int right = FixedMul(dy, node_dx >> 16);
    return right >= left;
}

/* r_draw.c: isolate the texel addressing from framebuffer and palette access. */
int R_ColumnTexel(int fraction) {
    return (fraction >> 16) & 127;
}

int R_SpanTexel(int x_fraction, int y_fraction) {
    return ((y_fraction >> 10) & 4032) + ((x_fraction >> 16) & 63);
}
