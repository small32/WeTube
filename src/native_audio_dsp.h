// No allocation, locks or system calls on the audio render thread.
#pragma once
#include <math.h>
#include <stdint.h>

static inline float wetube_audio_sample(float value, float gain) {
    if (!isfinite(value)) return 0;
    return fmaxf(-1, fminf(1, value * gain));
}

static inline float wetube_audio_db_gain(double db) {
    if (!isfinite(db)) db = 5;
    return powf(10, (float)fmax(0, fmin(20, db)) / 20);
}
