// macOS process tap + physical output in one private aggregate device.
// Control work runs on a serial queue; IOProc only touches C data and atomics.
#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <objc/message.h>
#include <stdatomic.h>
#include <unistd.h>
#include "native_audio_dsp.h"

typedef void (*WTNotify)(void *, const char *);
typedef struct {
    _Atomic(float) gain;
    _Atomic(bool) armed;
    _Atomic(bool) samples;
    _Atomic(uint64_t) callbacks;
    _Atomic(bool) badLayout;
    _Atomic(float) inputPeak, outputPeak;
    // 这三个由 IO 线程（renderAudio）和串行队列（start）同时读写，
    // 必须是原子的：靠 AudioDeviceStop/Start 的先后顺序"碰巧没问题"不算数，
    // 按 C11 内存模型就是数据竞争（TSan 会报）。
    _Atomic(float) rampGain;
    _Atomic(UInt32) tapBuffers;
    _Atomic(double) sampleRate;
} WTRender;

static AudioObjectPropertyAddress address(AudioObjectPropertySelector selector, AudioObjectPropertyScope scope) {
    return (AudioObjectPropertyAddress){selector, scope, kAudioObjectPropertyElementMain};
}
static OSStatus readProperty(AudioObjectID object, AudioObjectPropertySelector selector, AudioObjectPropertyScope scope, void *value, UInt32 size) {
    AudioObjectPropertyAddress a = address(selector, scope);
    return AudioObjectGetPropertyData(object, &a, 0, NULL, &size, value);
}
static UInt32 streamCount(AudioObjectID object, AudioObjectPropertyScope scope) {
    AudioObjectPropertyAddress a = address(kAudioDevicePropertyStreams, scope);
    UInt32 size = 0;
    return AudioObjectGetPropertyDataSize(object, &a, 0, NULL, &size) == noErr ? size / sizeof(AudioStreamID) : 0;
}
static AudioObjectID processObject(pid_t pid) {
    AudioObjectPropertyAddress a = address(kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyScopeGlobal);
    AudioObjectID result = 0; UInt32 size = sizeof(result);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, sizeof(pid), &pid, &size, &result) != noErr) return 0;
    return result;
}

static OSStatus renderAudio(AudioObjectID device, const AudioTimeStamp *now,
                           const AudioBufferList *input, const AudioTimeStamp *inputTime,
                           AudioBufferList *output, const AudioTimeStamp *outputTime, void *context) {
    (void)device; (void)now; (void)inputTime; (void)outputTime;
    WTRender *r = context;
    if (!output) return noErr;
    // 这三个字段由串行队列（start）写、IO 线程（本回调）读：各取一次到本地，
    // 既省掉重复原子读，也保证一整帧里看到的是同一份配置。
    UInt32 tapBuffers = atomic_load_explicit(&r->tapBuffers, memory_order_relaxed);
    double sampleRate = atomic_load_explicit(&r->sampleRate, memory_order_relaxed);
    float rampGain = atomic_load_explicit(&r->rampGain, memory_order_relaxed);
    atomic_fetch_add_explicit(&r->callbacks, 1, memory_order_relaxed);
    for (UInt32 b = 0; b < output->mNumberBuffers; b++)
        if (output->mBuffers[b].mData) memset(output->mBuffers[b].mData, 0, output->mBuffers[b].mDataByteSize);
    if (!input || input->mNumberBuffers < tapBuffers || !output->mNumberBuffers) return noErr;
    // Duplex devices donate hardware input streams ahead of the tap; never read those.
    UInt32 first = input->mNumberBuffers - tapBuffers;
    const AudioBuffer *left = &input->mBuffers[first];
    const AudioBuffer *right = tapBuffers == 2 ? &input->mBuffers[first + 1] : left;
    if (!left->mData || !right->mData) return noErr;
    if ((tapBuffers == 1 && left->mNumberChannels != 2)
        || (tapBuffers == 2 && (left->mNumberChannels != 1 || right->mNumberChannels != 1))) {
        atomic_store_explicit(&r->badLayout, true, memory_order_relaxed); return noErr;
    }
    UInt32 frames = left->mDataByteSize / (sizeof(float) * left->mNumberChannels);
    if (tapBuffers == 2) frames = MIN(frames, right->mDataByteSize / sizeof(float));
    bool armed = atomic_load_explicit(&r->armed, memory_order_relaxed), received = false;
    float gain = atomic_load_explicit(&r->gain, memory_order_relaxed);
    float inputPeak = 0, outputPeak = 0;
    float step = (gain - rampGain) / fmaxf(1, (float)(sampleRate * 0.01));
    for (UInt32 frame = 0; frame < frames; frame++) {
        float l = ((float *)left->mData)[frame * left->mNumberChannels];
        float rr = ((float *)right->mData)[frame * right->mNumberChannels + (tapBuffers == 1 ? 1 : 0)];
        if ((isfinite(l) && fabsf(l) > 1e-7f) || (isfinite(rr) && fabsf(rr) > 1e-7f)) received = true;
        if (isfinite(l)) inputPeak = fmaxf(inputPeak, fabsf(l));
        if (isfinite(rr)) inputPeak = fmaxf(inputPeak, fabsf(rr));
        if (!armed) continue; // Probe while original output remains audible.
        if ((step >= 0 && rampGain < gain) || (step < 0 && rampGain > gain)) {
            rampGain += step;
            if ((step > 0 && rampGain > gain) || (step < 0 && rampGain < gain)) rampGain = gain;
        }
        UInt32 channel = 0;
        for (UInt32 b = 0; b < output->mNumberBuffers; b++) {
            AudioBuffer *out = &output->mBuffers[b];
            UInt32 available = out->mDataByteSize / (sizeof(float) * MAX(1, out->mNumberChannels));
            for (UInt32 c = 0; c < out->mNumberChannels; c++, channel++) {
                if (!out->mData || frame >= available || channel > 1) continue;
                float value = channel == 0 ? l : rr;
                if (output->mNumberBuffers == 1 && out->mNumberChannels == 1) value = (l + rr) * .5f;
                float amplified = wetube_audio_sample(value, rampGain);
                ((float *)out->mData)[frame * out->mNumberChannels + c] = amplified;
                outputPeak = fmaxf(outputPeak, fabsf(amplified));
            }
        }
    }
    atomic_store_explicit(&r->rampGain, rampGain, memory_order_relaxed);
    if (received) atomic_store_explicit(&r->samples, true, memory_order_relaxed);
    atomic_store_explicit(&r->inputPeak, inputPeak, memory_order_relaxed);
    atomic_store_explicit(&r->outputPeak, outputPeak, memory_order_relaxed);
    return noErr;
}

@interface WTNativeAudio : NSObject {
    __weak WKWebView *_web;
    dispatch_queue_t _queue;
    dispatch_source_t _timer;
    WTNotify _notify; void *_context;
    bool _wanted, _shutdown; double _db; NSString *_request;
    _Atomic(uint64_t) _revision;
    AudioObjectID _tap, _aggregate, _output;
    AudioDeviceIOProcID _io;
    NSObject *_description; // Only cast to CATapDescription inside the 14.2 guard.
    NSArray<NSNumber *> *_targets;
    NSString *_lastState, *_failedRequest;
    // 失败节流用：同一个 request 失败后隔一会儿允许再试，避免永久锁死。
    NSDate *_failedAt;
    NSUInteger _failCount;
    WTRender _render;
    NSDate *_started;
    uint64_t _lastCallbacks;
    NSUInteger _stalled, _silentTicks;
    double _deviceRate;
}
- (instancetype)initWithWebView:(WKWebView *)web notify:(WTNotify)notify context:(void *)context;
- (void)update:(bool)enabled db:(double)db request:(NSString *)request;
- (void)refresh;
- (void)stop;
- (void)shutdown;
- (void)metrics:(float *)values;
@end

@implementation WTNativeAudio
- (instancetype)initWithWebView:(WKWebView *)web notify:(WTNotify)notify context:(void *)context {
    if ((self = [super init])) {
        _web = web; _notify = notify; _context = context;
        _queue = dispatch_queue_create("com.wecode.wetube.audio", DISPATCH_QUEUE_SERIAL);
        _timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        __weak WTNativeAudio *weak = self;
        dispatch_source_set_event_handler(_timer, ^{ [weak refresh]; });
        dispatch_source_set_timer(_timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), NSEC_PER_SEC / 4, NSEC_PER_MSEC * 25);
        dispatch_resume(_timer);
    }
    return self;
}
- (void)publish:(NSString *)state request:(NSString *)request error:(NSString *)error {
    NSDictionary *data = @{ @"request": request ?: @"", @"state": state,
                           @"error": error ?: @"", @"backend": @"coreaudio" };
    NSData *json = [NSJSONSerialization dataWithJSONObject:data options:0 error:nil];
    NSString *encoded = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    if (![encoded isEqual:_lastState]) {
        _lastState = encoded;
        if (_notify) _notify(_context, encoded.UTF8String);
    }
}
- (void)stop {
    atomic_store(&_render.armed, false);
    if (@available(macOS 14.2, *)) {
        if (_tap && _description) {
            CATapDescription *description = (CATapDescription *)_description;
            description.muteBehavior = CATapUnmuted;
            AudioObjectPropertyAddress a = address(kAudioTapPropertyDescription, kAudioObjectPropertyScopeGlobal);
            AudioObjectSetPropertyData(_tap, &a, 0, NULL, sizeof(description), &description);
        }
        if (_io) { AudioDeviceStop(_aggregate, _io); AudioDeviceDestroyIOProcID(_aggregate, _io); _io = NULL; }
        if (_aggregate) { AudioHardwareDestroyAggregateDevice(_aggregate); _aggregate = 0; }
        if (_tap) { AudioHardwareDestroyProcessTap(_tap); _tap = 0; }
    }
    _description = nil; _targets = nil; _started = nil; _output = 0;
}
- (void)fail:(NSString *)error request:(NSString *)request {
    [self stop];
    _failedRequest = request; _failedAt = NSDate.date; _failCount++;
    [self publish:@"error" request:request error:error];
}
- (OSStatus)start:(NSArray<NSNumber *> *)targets output:(AudioObjectID)output {
    if (@available(macOS 14.2, *)) {
        CFStringRef uid = NULL;
        OSStatus result = readProperty(output, kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, &uid, sizeof(uid));
        if (result != noErr || !uid) return result ?: kAudioHardwareBadDeviceError;
        NSString *outputUID = CFBridgingRelease(uid);
        CATapDescription *description = [[CATapDescription alloc] initStereoMixdownOfProcesses:targets];
        _description = description;
        description.name = @"WeTube Volume Boost"; description.privateTap = YES;
        description.muteBehavior = CATapUnmuted;
        result = AudioHardwareCreateProcessTap(description, &_tap);
        if (result != noErr) return result;
        AudioStreamBasicDescription format = {0};
        result = readProperty(_tap, kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, &format, sizeof(format));
        if (result != noErr) return result;
        if (format.mFormatID != kAudioFormatLinearPCM || !(format.mFormatFlags & kAudioFormatFlagIsFloat)
            || format.mBitsPerChannel != 32 || format.mChannelsPerFrame != 2) return kAudioHardwareUnsupportedOperationError;
        _render.tapBuffers = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) ? 2 : 1;
        _render.sampleRate = format.mSampleRate; _render.rampGain = 1;
        atomic_store(&_render.samples, false); atomic_store(&_render.callbacks, 0);
        atomic_store(&_render.badLayout, false); atomic_store(&_render.armed, false);
        NSDictionary *aggregate = @{
            @kAudioAggregateDeviceNameKey: @"WeTube Volume Boost",
            @kAudioAggregateDeviceUIDKey: [@"com.wecode.wetube.audio." stringByAppendingString:NSUUID.UUID.UUIDString],
            @kAudioAggregateDeviceIsPrivateKey: @YES,
            @kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            @kAudioAggregateDeviceSubDeviceListKey: @[@{@kAudioSubDeviceUIDKey: outputUID}],
            @kAudioAggregateDeviceTapListKey: @[@{@kAudioSubTapUIDKey: description.UUID.UUIDString,
                                               @kAudioSubTapDriftCompensationKey: @YES}],
            @kAudioAggregateDeviceTapAutoStartKey: @YES
        };
        result = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregate, &_aggregate);
        if (result != noErr) return result;
        UInt32 alive = 0;
        for (int i = 0; i < 30; i++) {
            result = readProperty(_aggregate, kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal, &alive, sizeof(alive));
            if (result == noErr && alive) break;
            [NSThread sleepForTimeInterval:0.05];
        }
        if (!alive) return kAudioHardwareNotRunningError;
        // Verify output is Float32 too; never interpret an integer device buffer as float.
        AudioObjectPropertyAddress a = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput);
        UInt32 size = 0; result = AudioObjectGetPropertyDataSize(_aggregate, &a, 0, NULL, &size);
        if (result != noErr || !size) return result ?: kAudioHardwareBadDeviceError;
        NSMutableData *streams = [NSMutableData dataWithLength:size];
        result = AudioObjectGetPropertyData(_aggregate, &a, 0, NULL, &size, streams.mutableBytes);
        if (result != noErr) return result;
        for (UInt32 i = 0; i < size / sizeof(AudioStreamID); i++) {
            AudioStreamBasicDescription out = {0};
            result = readProperty(((AudioStreamID *)streams.bytes)[i], kAudioStreamPropertyVirtualFormat, kAudioObjectPropertyScopeGlobal, &out, sizeof(out));
            if (result != noErr || out.mFormatID != kAudioFormatLinearPCM || !(out.mFormatFlags & kAudioFormatFlagIsFloat) || out.mBitsPerChannel != 32)
                return result ?: kAudioHardwareUnsupportedOperationError;
        }
        result = AudioDeviceCreateIOProcID(_aggregate, renderAudio, &_render, &_io);
        if (result != noErr) return result;
        UInt32 count = streamCount(_aggregate, kAudioObjectPropertyScopeInput);
        UInt32 hardware = streamCount(output, kAudioObjectPropertyScopeInput);
        if (hardware) {
            if (count <= hardware) return kAudioHardwareBadDeviceError;
            size = (UInt32)(offsetof(AudioHardwareIOProcStreamUsage, mStreamIsOn) + count * sizeof(UInt32));
            NSMutableData *usageData = [NSMutableData dataWithLength:size];
            AudioHardwareIOProcStreamUsage *usage = usageData.mutableBytes;
            usage->mIOProc = _io; usage->mNumberStreams = count;
            for (UInt32 i = hardware; i < count; i++) usage->mStreamIsOn[i] = 1;
            a = address(kAudioDevicePropertyIOProcStreamUsage, kAudioObjectPropertyScopeInput);
            result = AudioObjectSetPropertyData(_aggregate, &a, 0, NULL, size, usage);
            if (result != noErr) return result;
        }
        result = AudioDeviceStart(_aggregate, _io);
        if (result == noErr) { _output = output; _targets = targets; _started = NSDate.date; _lastCallbacks = 0; _stalled = 0; _silentTicks = 0; }
        return result;
    }
    return kAudioHardwareUnsupportedOperationError;
}
- (void)update:(bool)enabled db:(double)db request:(NSString *)request {
    if (_shutdown) return;
    atomic_fetch_add(&_revision, 1);
    _wanted = enabled; _db = db; _request = request;
    [self refresh];
}
- (void)refresh {
    if (_shutdown) return;
    uint64_t revision = atomic_load(&_revision);
    bool wanted = _wanted; double db = _db; NSString *request = _request ?: @"";
    NSMutableArray<NSNumber *> *pids = [NSMutableArray array];
    // WKWebView has no public helper PID accessor. Capability-check the two WebKit SPI
    // selectors; never guess by process name, bundle name, or capture all system audio.
    for (NSString *name in @[@"_webProcessIdentifier", @"_gpuProcessIdentifier"]) {
        SEL selector = NSSelectorFromString(name);
        WKWebView *web = _web;
        if (web && [web respondsToSelector:selector]) {
            pid_t pid = ((pid_t (*)(id, SEL))objc_msgSend)(web, selector);
            if (pid > 0 && pid != getpid() && ![pids containsObject:@(pid)]) [pids addObject:@(pid)];
        }
    }
    dispatch_async(_queue, ^{
        @autoreleasepool {
            if (revision != atomic_load(&self->_revision)) return;
            // shutdown 可能在入队之后才发生，块里必须再看一次，
            // 否则会在已经 shutdown 之后重建 tap 和私有聚合设备且永不销毁。
            if (self->_shutdown) return;
            if (!wanted) { [self stop]; self->_failedRequest = nil; self->_failCount = 0; [self publish:@"off" request:request error:nil]; return; }
            if ([self->_failedRequest isEqual:request]) {
                // 同一个请求失败过：节流重试，而不是一次失败就永久锁死。
                // 首次开启时系统往往会弹「允许录制系统音频」，用户还没点允许，
                // 3 秒拿不到数据就判失败并锁死的话，授权之后 UI 也一直停在 error，
                // 必须关掉再点开才恢复。
                NSTimeInterval since = -[self->_failedAt timeIntervalSinceNow];
                if (self->_failedAt && since < 5.0) return;
                if (self->_failCount >= 8) return;
            }
            if (@available(macOS 14.2, *)) {} else { [self fail:@"原生音量增强需要 macOS 14.2 或更新版本" request:request]; return; }
            if (!pids.count) { [self stop]; [self publish:@"waiting" request:request error:@"等待播放器音频进程"]; return; }
            NSMutableArray<NSNumber *> *targets = [NSMutableArray array];
            for (NSNumber *pid in pids) { AudioObjectID process = processObject(pid.intValue); if (process && ![targets containsObject:@(process)]) [targets addObject:@(process)]; }
            if (!targets.count) { [self stop]; [self publish:@"waiting" request:request error:@"请播放视频，等待音频进程启动"]; return; }
            AudioObjectID output = 0;
            OSStatus result = readProperty(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, &output, sizeof(output));
            if (result != noErr || !output) { [self fail:@"无法读取当前音频输出设备" request:request]; return; }
            atomic_store(&self->_render.gain, wetube_audio_db_gain(db));
            double rate = 0;
            result = readProperty(output, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, &rate, sizeof(rate));
            if (result != noErr || rate <= 0) { [self fail:@"无法读取输出设备的音频格式，已恢复原声" request:request]; return; }
            if (!self->_tap || output != self->_output || rate != self->_deviceRate || ![targets isEqual:self->_targets]) {
                [self stop];
                result = [self start:targets output:output];
                self->_deviceRate = rate;
                if (revision != atomic_load(&self->_revision)) { [self stop]; return; }
                if (result != noErr) {
                    [self fail:[NSString stringWithFormat:@"无法启动原生音量增强（%d）；请检查系统音频录制权限及输出设备", (int)result] request:request]; return;
                }
            }
            if (atomic_load(&self->_render.badLayout)) { [self fail:@"当前设备的音频格式不受支持，已恢复原声" request:request]; return; }
            uint64_t callbacks = atomic_load(&self->_render.callbacks);
            if (callbacks == self->_lastCallbacks) self->_stalled++; else self->_stalled = 0;
            self->_lastCallbacks = callbacks;
            if (self->_stalled >= 12) { [self fail:@"音频设备没有提供数据，已恢复原声；请检查系统音频录制权限" request:request]; return; }
            if (atomic_load(&self->_render.armed) && atomic_load(&self->_render.inputPeak) <= 1e-7f) self->_silentTicks++;
            else self->_silentTicks = 0;
            // A revoked permission can yield zero buffers rather than an API error.
            // Unmute the original after a prolonged gap; keep probing and reacquire
            // when samples return. This also handles long silent video segments.
            if (self->_silentTicks >= 20) {
                if (@available(macOS 14.2, *)) {
                    atomic_store(&self->_render.armed, false);
                    atomic_store(&self->_render.samples, false);
                    CATapDescription *description = (CATapDescription *)self->_description;
                    description.muteBehavior = CATapUnmuted;
                    AudioObjectPropertyAddress a = address(kAudioTapPropertyDescription, kAudioObjectPropertyScopeGlobal);
                    result = AudioObjectSetPropertyData(self->_tap, &a, 0, NULL, sizeof(description), &description);
                    if (result != noErr) { [self fail:@"音频信号中断，已恢复原声" request:request]; return; }
                }
            }
            if (atomic_load(&self->_render.samples) && !atomic_load(&self->_render.armed)) {
                if (@available(macOS 14.2, *)) {
                    CATapDescription *description = (CATapDescription *)self->_description;
                    description.muteBehavior = CATapMutedWhenTapped;
                    AudioObjectPropertyAddress a = address(kAudioTapPropertyDescription, kAudioObjectPropertyScopeGlobal);
                    result = AudioObjectSetPropertyData(self->_tap, &a, 0, NULL, sizeof(description), &description);
                    if (result != noErr) { [self fail:@"无法接管原声输出，已恢复原声" request:request]; return; }
                    atomic_store(&self->_render.armed, true);
                }
            }
            bool active = atomic_load(&self->_render.armed);
            if (active) { self->_failedRequest = nil; self->_failedAt = nil; self->_failCount = 0; }
            NSString *hint = [self->_started timeIntervalSinceNow] < -5
                ? @"尚未收到音频；请播放有声音的视频，并检查系统设置中的系统音频录制权限"
                : @"等待音频或系统授权；原声保持播放";
            [self publish:active ? @"active" : @"waiting" request:request error:active ? nil : hint];
        }
    });
}
- (void)shutdown {
    if (_shutdown) return;
    _shutdown = true;
    atomic_fetch_add(&_revision, 1);
    _wanted = false;
    dispatch_source_cancel(_timer); _timer = nil;
    dispatch_sync(_queue, ^{ [self stop]; self->_notify = NULL; });
}
- (void)metrics:(float *)values {
    values[0] = atomic_load(&_render.inputPeak);
    values[1] = atomic_load(&_render.outputPeak);
    values[2] = atomic_load(&_render.armed) ? 1 : 0;
}
// 兜底：万一没走 shutdown 就被释放，也要停掉定时器，
// 别让已经关掉的引擎继续在队列上重建聚合设备。
- (void)dealloc {
    if (_shutdown) return;
    _shutdown = true;
    if (_timer) { dispatch_source_cancel(_timer); _timer = nil; }
}
@end

void *wetube_audio_create(void *web, WTNotify notify, void *context) {
    return (__bridge_retained void *)[[WTNativeAudio alloc] initWithWebView:(__bridge WKWebView *)web notify:notify context:context];
}
void wetube_audio_update(void *engine, bool enabled, double db, const char *request) {
    [(__bridge WTNativeAudio *)engine update:enabled db:db request:[NSString stringWithUTF8String:request]];
}
void wetube_audio_destroy(void *engine) {
    WTNativeAudio *object = CFBridgingRelease(engine);
    [object shutdown];
}
void wetube_audio_shutdown(void *engine) {
    [(__bridge WTNativeAudio *)engine shutdown];
}
void wetube_audio_metrics(void *engine, float *values) {
    [(__bridge WTNativeAudio *)engine metrics:values];
}
