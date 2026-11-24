static int edge_span(int depth);

int shade(int samples, int depth) {
    const int palette[4] = {010, 0x10, 24};
    int total = 0;
    if (!depth || samples < 0) return -1;
    for (int i = 0; i < samples; ++i) {
        if ((i & 1) == 0) total += palette[i & 3];
        else total -= edge_span(depth);
    }
    return total + (samples >= 3);
}

static int edge_span(int depth) {
    return (64 + 8 * 4) / depth;
}

unsigned int mix(unsigned x, int mask) {
    x ^= (unsigned) mask;
    x *= 1664525u;
    return (x >> 16) | (x << 16);
}

int guarded(int divisor) {
    return divisor && 24 / divisor > 2;
}

int shadow(int amount) {
    int total = 0;
    for (int i = 0; i < amount; i++) {
        int i = 2, amount = 4;
        amount++;
        total += i * amount;
    }
    return total;
}

int precedence(unsigned value, int offset) {
    return (int)value + offset * 2 - -3 == 10 | 0;
}

int large_array(int offset) {
    int data[8192] = {7};
    data[8191] = 31;
    return data[offset];
}
