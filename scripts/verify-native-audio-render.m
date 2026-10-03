// Exercise the real IOProc using supplied buffers; no tap or permission required.
// clang -fobjc-arc -fblocks scripts/verify-native-audio-render.m \
//   -framework Foundation -framework CoreAudio -framework WebKit -o /tmp/wetube-render-test
#include "../src/native_audio.m"
#include <assert.h>

int main(void) {
    WTRender r = {0};
    atomic_init(&r.gain, wetube_audio_db_gain(6));
    atomic_init(&r.armed, true);
    r.rampGain = wetube_audio_db_gain(6); r.tapBuffers = 1; r.sampleRate = 48000;
    float samples[] = {.1f, -.2f, .75f, -.75f};
    float result[4] = {0};
    AudioBufferList input = {.mNumberBuffers=1, .mBuffers={{.mNumberChannels=2, .mDataByteSize=sizeof(samples), .mData=samples}}};
    AudioBufferList output = {.mNumberBuffers=1, .mBuffers={{.mNumberChannels=2, .mDataByteSize=sizeof(result), .mData=result}}};
    renderAudio(0, NULL, &input, NULL, &output, NULL, &r);
    assert(fabsf(result[0] - .1f * wetube_audio_db_gain(6)) < 1e-6f);
    assert(result[1] < 0 && result[2] == 1 && result[3] == -1);
    assert(atomic_load(&r.samples) && atomic_load(&r.callbacks) == 1);
    atomic_store(&r.armed, false);
    renderAudio(0, NULL, &input, NULL, &output, NULL, &r);
    for (int i=0; i<4; i++) assert(result[i] == 0); // Preview must not duplicate original.

    // Two planar tap buffers follow a physical hardware input. Its data is ignored.
    float microphone[] = {100, 100}, left[] = {.1f, NAN}, right[] = {-.1f, INFINITY};
    struct { AudioBufferList list; AudioBuffer extra[2]; } planar = {
        .list={.mNumberBuffers=3, .mBuffers={{.mNumberChannels=1,.mDataByteSize=sizeof(microphone),.mData=microphone}}},
        .extra={{.mNumberChannels=1,.mDataByteSize=sizeof(left),.mData=left},
                {.mNumberChannels=1,.mDataByteSize=sizeof(right),.mData=right}}
    };
    r.tapBuffers=2; atomic_store(&r.armed, true);
    renderAudio(0, NULL, &planar.list, NULL, &output, NULL, &r);
    assert(fabsf(result[0] - .1f * wetube_audio_db_gain(6)) < 1e-6f);
    assert(fabsf(result[1] + .1f * wetube_audio_db_gain(6)) < 1e-6f);
    assert(result[2] == 0 && result[3] == 0);
    assert(wetube_audio_db_gain(-5) == 1 && wetube_audio_db_gain(30) == 10);
    assert(isfinite(wetube_audio_db_gain(NAN)));
    puts("通过：原生 IOProc 增益、限幅、静音预检、平面/交错布局、硬件输入隔离及无效样本处理。");
}
