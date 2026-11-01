import UIKit
import WebKit
import AVFoundation

class AppDelegate: UIResponder, UIApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: UIWindow?
    var webView: WKWebView!

    // 与安卓壳一致：加载线上页面（已含百度语音识别 + VAD 连续对话）
    static let APP_URL = "https://wiki-qa-bot-06186.app.workbuddy.host/?sharecode=<YOUR_SHARECODE>"

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 允许扬声器播放（TTS 播报）
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = WKWebsiteDataStore.default()

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        window = UIWindow(frame: UIScreen.main.bounds)
        let vc = UIViewController()
        vc.view = webView
        window?.rootViewController = vc
        window?.makeKeyAndVisible()

        if let url = URL(string: Self.APP_URL) {
            webView.load(URLRequest(url: url))
        }
        return true
    }

    // WKWebView 内 getUserMedia（百度语音识别录音）自动授权麦克风
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // 加载失败重试页
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let html = """
        <html><body style="font-family:-apple-system;display:flex;align-items:center;justify-content:center;height:90vh;text-align:center;background:#f5f6fa;">
        <div><h2>😭 网络连接失败</h2><p style="color:#888;">\(error.localizedDescription)</p>
        <button onclick="location.reload()" style="padding:12px 32px;border-radius:24px;border:none;background:#4f6ef7;color:#fff;font-size:16px;">重新加载</button></div>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }
}
