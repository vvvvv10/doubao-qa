import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!

    // 与安卓/iOS 壳一致：加载线上页面（百度语音识别 + VAD 连续对话）
    static let APP_URL = "https://wiki-qa-bot-06186.app.workbuddy.host/?sharecode=<YOUR_SHARECODE>"

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self

        // 手机版竖屏比例窗口，贴合移动端 UI
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "维基问答"
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("WikiQAMainWindow")
        window.minSize = NSSize(width: 340, height: 560)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if let url = URL(string: Self.APP_URL) {
            webView.load(URLRequest(url: url))
        }
    }

    // WKWebView 内 getUserMedia（百度语音识别录音）自动授权麦克风
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // 加载失败显示重试页
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let html = """
        <html><body style="font-family:-apple-system;display:flex;align-items:center;justify-content:center;height:90vh;text-align:center;background:#f5f6fa;">
        <div><h2>😭 网络连接失败</h2><p style="color:#888;">\(error.localizedDescription)</p>
        <button onclick="location.reload()" style="padding:12px 32px;border-radius:24px;border:none;background:#4f6ef7;color:#fff;font-size:16px;">重新加载</button></div>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
