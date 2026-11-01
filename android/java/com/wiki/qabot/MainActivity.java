package com.wiki.qabot;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Locale;

public class MainActivity extends Activity {

    // WebView 加载已发布的站点完整分享链接（云服务要求 Origin 精确匹配 + 平台要求 sharecode）
    private static final String APP_URL = "https://wiki-qa-bot-06186.app.workbuddy.host/?sharecode=<YOUR_SHARECODE>";
    private static final int REQ_MIC = 1001;

    private WebView web;
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private volatile boolean asrRecording = false;
    private volatile String asrStatus = "idle";   // idle|recording|captured|error
    private volatile String asrAudio = null;      // WAV base64
    private volatile String asrErrMsg = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        WebView.setWebContentsDebuggingEnabled(true); // 便于 chrome://inspect 远程调试
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override public void run() { request.grant(request.getResources()); }
                });
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidVoice");
        setContentView(web);

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }

        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
            @Override public void onInit(int status) {
                if (status == TextToSpeech.SUCCESS) {
                    tts.setLanguage(Locale.CHINA);
                    ttsReady = true;
                    tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                        @Override public void onStart(String utteranceId) {}
                        @Override public void onDone(String utteranceId) {
                            if ("wiki-qa-answer".equals(utteranceId)) jsEval("onTtsDone()");
                        }
                        @Override public void onError(String utteranceId) {
                            if ("wiki-qa-answer".equals(utteranceId)) jsEval("onTtsDone()");
                        }
                    });
                }
            }
        });

        web.loadUrl(APP_URL);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (recognizer != null) { recognizer.destroy(); recognizer = null; }
        if (tts != null) { tts.stop(); tts.shutdown(); }
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private boolean hasMicPermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void jsEval(String snippet) {
        web.post(new Runnable() {
            @Override public void run() {
                web.evaluateJavascript(snippet, null);
            }
        });
    }

    private void startNativeListening() {
        if (!hasMicPermission()) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            jsEval("onNativeVoiceError('9')");
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            jsEval("onNativeVoiceError('1')");
            return;
        }
        if (recognizer == null) recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.destroy();
        recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { jsEval("onNativeVoiceStart()"); }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() {}
            @Override public void onPartialResults(Bundle partialResults) {}
            @Override public void onEvent(int eventType, Bundle params) {}

            @Override public void onResults(Bundle results) {
                ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                String text = (list != null && !list.isEmpty()) ? list.get(0) : "";
                jsEval("onNativeVoiceResult(" + JSONObject.quote(text) + ")");
                jsEval("onNativeVoiceEnd()");
            }

            @Override public void onError(int error) {
                jsEval("onNativeVoiceError(" + error + ")");
                jsEval("onNativeVoiceEnd()");
            }
        });

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
        recognizer.startListening(intent);
    }

    private class Bridge {
        @JavascriptInterface
        public boolean canListen() {
            return SpeechRecognizer.isRecognitionAvailable(getApplicationContext());
        }

        // 原生 ASR：不走 WebView 音频栈，直接 AudioRecord 录音 + 上传服务端识别
        // 状态通过 getAsrStatus() 由 JS 轮询获取（比 Java→JS 回调更可靠）
        @JavascriptInterface
        public boolean hasNativeAsr() { return true; }

        @JavascriptInterface
        public void startAsr() {
            if (asrRecording || asrStatus.equals("processing")) return;
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                asrStatus = "error";
                asrErrMsg = "需要麦克风权限，请授权后重试";
                return;
            }
            asrRecording = true;
            asrStatus = "recording";
            asrAudio = null;
            asrErrMsg = null;
            new Thread(new Runnable() {
                @Override public void run() {
                try {
                    final int rate = 16000;
                    int minBuf = android.media.AudioRecord.getMinBufferSize(rate,
                            android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT);
                    android.media.AudioRecord ar = new android.media.AudioRecord(android.media.MediaRecorder.AudioSource.MIC,
                            rate, android.media.AudioFormat.CHANNEL_IN_MONO,
                            android.media.AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuf, rate));
                    if (ar.getState() != android.media.AudioRecord.STATE_INITIALIZED) {
                        throw new Exception("无法初始化麦克风（可能被其他应用占用）");
                    }
                    ar.startRecording();
                    ByteArrayOutputStream pcm = new ByteArrayOutputStream();
                    byte[] buf = new byte[3200]; // 100ms @16k/16bit/mono
                    long start = System.currentTimeMillis();
                    // VAD 自动断句：先测环境噪声，检测到说话后，静音约 0.8s 自动结束
                    double noiseSum = 0; int noiseN = 0; double threshold = -1;
                    boolean speechDetected = false; long speechStartMs = 0; int silenceMs = 0; long totalMs = 0;
                    while (asrRecording && totalMs < 20000) {
                        int n = ar.read(buf, 0, buf.length);
                        if (n <= 0) continue;
                        pcm.write(buf, 0, n);
                        totalMs += n / 32; // 32 bytes per ms @16k/16bit/mono
                        long sum = 0; int samples = n / 2;
                        for (int i = 0; i + 1 < n; i += 2) {
                            short v = (short) (((buf[i] & 0xFF)) | (buf[i + 1] << 8));
                            sum += (long) v * v;
                        }
                        double rms = samples > 0 ? Math.sqrt((double) sum / samples) : 0;
                        if (threshold < 0) {
                            if (totalMs <= 400) { noiseSum += rms; noiseN++; }
                            else { threshold = (noiseN > 0 ? noiseSum / noiseN : 300) * 2 + 600; }
                        } else if (!speechDetected) {
                            if (rms > threshold) { speechDetected = true; speechStartMs = totalMs; silenceMs = 0; }
                            else if (totalMs > 8000) break; // 8 秒没说话自动取消
                        } else {
                            if (rms > threshold) silenceMs = 0; else silenceMs += n / 32;
                            if (silenceMs >= 750 && (totalMs - speechStartMs) >= 300) break; // 说完自动结束
                        }
                        Thread.sleep(5);
                    }
                    boolean userCancelled = !asrRecording && !speechDetected; // 手动停止且没说过话
                    asrRecording = false;
                    ar.stop();
                    ar.release();
                    if (userCancelled) {
                        asrStatus = "idle"; // 静默取消，不报错
                        return;
                    }
                    if (!speechDetected) {
                        asrErrMsg = "没有听到声音，请靠近麦克风再说一次";
                        asrStatus = "error";
                        return;
                    }
                    if (pcm.size() < rate * 2 * 0.4) {
                        asrErrMsg = "录音太短，请说完一句话";
                        asrStatus = "error";
                        return;
                    }
                    asrStatus = "processing";
                    byte[] wav = wavBytes(pcm.toByteArray(), rate);
                    // 上传由页面 fetch 完成（原生层 DNS 在部分机型不可用），这里只回传音频
                    asrAudio = android.util.Base64.encodeToString(wav, android.util.Base64.NO_WRAP);
                    asrStatus = "captured";
                } catch (Exception e) {
                    asrErrMsg = String.valueOf(e.getMessage());
                    asrStatus = "error";
                }
                }
            }, "native-asr").start();
        }

        @JavascriptInterface
        public void stopAsr() { asrRecording = false; }

        @JavascriptInterface
        public String getAsrStatus() {
            JSONObject j = new JSONObject();
            try {
                j.put("status", asrStatus);
                j.put("error", asrErrMsg == null ? "" : asrErrMsg);
            } catch (Exception e) { /* JSON 构造不会失败 */ }
            return j.toString();
        }

        @JavascriptInterface
        public String getAsrAudio() { return asrAudio; }

        @JavascriptInterface
        public void asrReset() {
            asrStatus = "idle";
            asrAudio = null;
            asrErrMsg = null;
        }

        @JavascriptInterface
        public void startListening() {
            runOnUiThread(new Runnable() {
                @Override public void run() { startNativeListening(); }
            });
        }

        @JavascriptInterface
        public void stopListening() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (recognizer != null) recognizer.stopListening();
                }
            });
        }

        @JavascriptInterface
        public void speak(final String text) {
            if (!ttsReady || text == null || text.isEmpty()) return;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    tts.setLanguage(Locale.CHINA);
                    tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "wiki-qa-answer");
                }
            });
        }

        @JavascriptInterface
        public void stopSpeak() {
            runOnUiThread(new Runnable() {
                @Override public void run() { if (ttsReady) tts.stop(); }
            });
        }
    }

    // PCM16 → WAV 封装
    private byte[] wavBytes(byte[] pcm, int rate) {
        int dataLen = pcm.length;
        byte[] out = new byte[44 + dataLen];
        out[0] = 'R'; out[1] = 'I'; out[2] = 'F'; out[3] = 'F';
        writeInt(out, 4, 36 + dataLen);
        out[8] = 'W'; out[9] = 'A'; out[10] = 'V'; out[11] = 'E';
        out[12] = 'f'; out[13] = 'm'; out[14] = 't'; out[15] = ' ';
        writeInt(out, 16, 16);
        out[20] = 1; out[21] = 0;          // PCM
        out[22] = 1; out[23] = 0;          // mono
        writeInt(out, 24, rate);
        writeInt(out, 28, rate * 2);
        out[32] = 2; out[33] = 0;
        out[34] = 16; out[35] = 0;
        out[36] = 'd'; out[37] = 'a'; out[38] = 't'; out[39] = 'a';
        writeInt(out, 40, dataLen);
        System.arraycopy(pcm, 0, out, 44, dataLen);
        return out;
    }

    private void writeInt(byte[] b, int off, int v) {
        b[off] = (byte) v; b[off + 1] = (byte) (v >> 8);
        b[off + 2] = (byte) (v >> 16); b[off + 3] = (byte) (v >> 24);
    }
}
