import AuthenticationServices
import AVFoundation
import Capacitor
import LocalAuthentication
import Security
import Speech
import UIKit
import WebKit

/// Root view controller: registers the app's own plugin with the bridge.
class YoursBridgeViewController: CAPBridgeViewController {
    private var bridgeGate: MainFrameBridgeGate?

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(YoursNativePlugin())
        bridge?.registerPluginInstance(PasskeysPlugin())
        installBridgeGate()
    }

    /// b-Aware row 56. WKScriptMessageHandlers are visible to every frame, and Capacitor's iOS
    /// bridge (8.5.2) neither checks the frame nor escapes the callbackId it splices into the
    /// main-frame reply. So a framed bApp or video embed could run JavaScript as the wallet.
    /// Swap Capacitor's "bridge" handler for a gate that only forwards main-frame messages from the
    /// app's own origin whose callbackId is a plain number (what native-bridge.js generates).
    private func installBridgeGate() {
        guard let capBridge = bridge as? CapacitorBridge,
              let controller = webView?.configuration.userContentController else { return }
        let gate = MainFrameBridgeGate(
            inner: capBridge.webViewDelegationHandler, appURL: capBridge.config.localURL)
        controller.removeScriptMessageHandler(forName: MainFrameBridgeGate.handlerName)
        controller.add(gate, name: MainFrameBridgeGate.handlerName)
        bridgeGate = gate
    }

    /// Live Spaces (src/mobile/spaces/background.ts) float the active speaker's <video> as
    /// picture-in-picture when the app goes to the background. WebKit's default is already true on
    /// iPhone; set explicitly so a future Capacitor default can't turn it off.
    override open func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.allowsPictureInPictureMediaPlayback = true
        return config
    }
}

/// Forwards a bridge message to Capacitor only when it comes from the wallet itself.
/// Checked statically by src/mobile/iosBridgeGate.test.ts.
final class MainFrameBridgeGate: NSObject, WKScriptMessageHandler {
    static let handlerName = "bridge"
    private weak var inner: WKScriptMessageHandler?
    private let appScheme: String
    private let appHost: String
    private let appPort: Int

    init(inner: WKScriptMessageHandler, appURL: URL) {
        self.inner = inner
        appScheme = (appURL.scheme ?? "").lowercased()
        appHost = (appURL.host ?? "").lowercased()
        appPort = appURL.port ?? 0
    }

    static func isSafeCallbackId(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 20 else { return false }
        let digits = id.hasPrefix("-") ? String(id.dropFirst()) : id
        return !digits.isEmpty && digits.allSatisfy { $0 >= "0" && $0 <= "9" }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        let origin = message.frameInfo.securityOrigin
        guard origin.protocol.lowercased() == appScheme, origin.host.lowercased() == appHost,
              origin.port == appPort else { return }
        if let dict = message.body as? [String: Any], (dict["type"] as? String) == "message" {
            guard let id = dict["callbackId"] as? String, Self.isSafeCallbackId(id) else { return }
        }
        inner?.userContentController(controller, didReceive: message)
    }
}

/// Native side of src/mobile/native.ts.
///
/// - secure*:    Keychain, AfterFirstUnlockThisDeviceOnly (never in iCloud or device backups).
/// - biometric*: Keychain item gated by `.biometryCurrentSet`; re-enrolling Face ID makes it unreadable.
/// - browser*:   full-screen WKWebView for dApps. The provider script is injected at document
///               start in the main frame; each message's origin comes from WebKit's frame info.
@objc(YoursNativePlugin)
public class YoursNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "YoursNativePlugin"
    public let jsName = "YoursNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceOwnerAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browserOpen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browserClose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browserSetHidden", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browserRespond", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browserEmit", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "audioSetSpeaker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushEnv", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretCopy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretClear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mediaAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speechAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speechStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speechStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speechCancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "haptic", returnType: CAPPluginReturnPromise)
    ]

    private let storageService = "com.bitcoincorp.yourswalletmobile.storage"
    private let biometricService = "com.bitcoincorp.yourswalletmobile.biometric"
    private let installMarker = "com.bitcoincorp.yourswalletmobile.installed"

    override public func load() {
        // Keychain items outlive an uninstall; UserDefaults do not. A fresh install
        // must start empty rather than inherit a previous install's keystore.
        if !UserDefaults.standard.bool(forKey: installMarker) {
            SecItemDelete(query(storageService, nil) as CFDictionary)
            SecItemDelete(query(biometricService, nil) as CFDictionary)
            UserDefaults.standard.set(true, forKey: installMarker)
        }
    }

    // MARK: - Keychain

    private func query(_ service: String, _ key: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]
        if let key = key { q[kSecAttrAccount as String] = key }
        return q
    }

    @objc func secureGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("Must provide key") }
        var q = query(storageService, key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return call.resolve(["value": NSNull()]) }
        guard status == errSecSuccess, let data = out as? Data, let value = String(data: data, encoding: .utf8) else {
            return call.reject("Secure read failed (\(status))")
        }
        call.resolve(["value": value])
    }

    @objc func secureSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            return call.reject("Must provide key and value")
        }
        let data = Data(value.utf8)
        let q = query(storageService, key)
        var status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = q
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        status == errSecSuccess ? call.resolve() : call.reject("Secure write failed (\(status))")
    }

    @objc func secureRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("Must provide key") }
        SecItemDelete(query(storageService, key) as CFDictionary)
        call.resolve()
    }

    @objc func secureKeys(_ call: CAPPluginCall) {
        var q = query(storageService, nil)
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return call.resolve(["keys": []]) }
        guard status == errSecSuccess, let items = out as? [[String: Any]] else {
            return call.reject("Secure list failed (\(status))")
        }
        call.resolve(["keys": items.compactMap { $0[kSecAttrAccount as String] as? String }])
    }

    // MARK: - Biometrics

    private func biometryType() -> String {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return "none" }
        switch context.biometryType {
        case .faceID: return "faceId"
        case .touchID: return "touchId"
        default:
            if #available(iOS 17.0, *), context.biometryType == .opticID { return "opticId" }
            return "none"
        }
    }

    /// APNs gateway this build's token belongs to: Debug builds (Xcode Run, INSTALL=1) get sandbox tokens.
    @objc func pushEnv(_ call: CAPPluginCall) {
        #if DEBUG
        call.resolve(["env": "sandbox"])
        #else
        call.resolve(["env": "production"])
        #endif
    }

    // MARK: - Secret clipboard (src/mobile/secretClipboard.ts)

    /// Recovery phrase / key copies: local-only (no Universal Clipboard) and expiring. The token is the
    /// pasteboard changeCount after our write, so secretClear never has to read the text (no paste banner).
    @objc func secretCopy(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        let seconds = max(5, min(600, call.getDouble("seconds") ?? 60))
        DispatchQueue.main.async {
            let board = UIPasteboard.general
            board.setItems([["public.utf8-plain-text": text]], options: [
                .localOnly: true,
                .expirationDate: Date().addingTimeInterval(seconds),
            ])
            call.resolve(["token": String(board.changeCount)])
        }
    }

    @objc func secretClear(_ call: CAPPluginCall) {
        let token = call.getString("token") ?? ""
        DispatchQueue.main.async {
            let board = UIPasteboard.general
            if !token.isEmpty && String(board.changeCount) == token {
                board.items = []
            }
            call.resolve()
        }
    }

    /// Open this app's page in iPhone Settings (microphone / camera switches live there).
    @objc func openAppSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("Settings unavailable")
                return
            }
            UIApplication.shared.open(url) { ok in ok ? call.resolve() : call.reject("Could not open Settings") }
        }
    }

    /// Ask iOS for the microphone or camera before the web view opens it. This shows the system
    /// prompt (and creates the switch in Settings › Apps › bWallet) instead of relying on WebKit.
    // MARK: - Speech (hold the dock's b to talk to b)

    private var speechEngine: AVAudioEngine?
    private var speechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var speechTask: SFSpeechRecognitionTask?
    private var speechText = ""
    private var speechLastLevel = Date.distantPast

    @objc func speechAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": SFSpeechRecognizer()?.isAvailable ?? false])
    }

    @objc func haptic(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            call.resolve()
        }
    }

    /// Asks for speech recognition, then the mic (the first time), then listens. Resolves once listening:
    /// { started: true } or { started: false, reason: 'denied' | 'unavailable' | 'error' }.
    /// Events: speechPartial { text }, speechLevel { level 0..1 }.
    @objc func speechStart(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { auth in
            guard auth == .authorized else { return call.resolve(["started": false, "reason": "denied"]) }
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                guard ok else { return call.resolve(["started": false, "reason": "denied"]) }
                DispatchQueue.main.async { self.beginSpeech(call) }
            }
        }
    }

    private func beginSpeech(_ call: CAPPluginCall) {
        endSpeech()
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            return call.resolve(["started": false, "reason": "unavailable"])
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            // On the phone where the device can: the audio never leaves it.
            if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                request.append(buffer)
                self?.reportLevel(buffer)
            }
            speechText = ""
            speechTask = recognizer.recognitionTask(with: request) { [weak self] result, _ in
                guard let self = self, let result = result else { return }
                self.speechText = result.bestTranscription.formattedString
                self.notifyListeners("speechPartial", data: ["text": self.speechText])
            }
            engine.prepare()
            try engine.start()
            speechEngine = engine
            speechRequest = request
            call.resolve(["started": true])
        } catch {
            endSpeech()
            call.resolve(["started": false, "reason": "error"])
        }
    }

    private func reportLevel(_ buffer: AVAudioPCMBuffer) {
        guard Date().timeIntervalSince(speechLastLevel) > 0.08, let data = buffer.floatChannelData?[0] else { return }
        speechLastLevel = Date()
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }
        var sum: Float = 0
        for i in 0..<n { sum += data[i] * data[i] }
        let rms = sqrt(sum / Float(n))
        notifyListeners("speechLevel", data: ["level": min(1, Double(rms) * 4)])
    }

    private func endSpeech() {
        speechEngine?.inputNode.removeTap(onBus: 0)
        speechEngine?.stop()
        speechRequest?.endAudio()
        speechEngine = nil
        speechRequest = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Stops listening and resolves with the final text (a short wait lets the last words land).
    @objc func speechStop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.endSpeech()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.speechTask?.finish()
                self.speechTask = nil
                call.resolve(["text": self.speechText])
            }
        }
    }

    @objc func speechCancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.endSpeech()
            self.speechTask?.cancel()
            self.speechTask = nil
            self.speechText = ""
            call.resolve()
        }
    }

    @objc func mediaAccess(_ call: CAPPluginCall) {
        let type: AVMediaType = call.getString("kind") == "camera" ? .video : .audio
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized:
            call.resolve(["granted": true])
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: type) { ok in call.resolve(["granted": ok]) }
        default:
            call.resolve(["granted": false])
        }
    }

    @objc func biometricStatus(_ call: CAPPluginCall) {
        let type = biometryType()
        call.resolve(["available": type != "none", "biometryType": type])
    }

    @objc func biometricSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            return call.reject("Must provide key and value")
        }
        guard biometryType() != "none" else { return call.reject("Biometrics unavailable", "unavailable") }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &error
        ) else {
            return call.reject("Biometric setup failed", "failed")
        }
        SecItemDelete(query(biometricService, key) as CFDictionary)
        var add = query(biometricService, key)
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessControl as String] = access
        let status = SecItemAdd(add as CFDictionary, nil)
        status == errSecSuccess ? call.resolve() : call.reject("Biometric setup failed (\(status))", "failed")
    }

    @objc func biometricGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("Must provide key") }
        let context = LAContext()
        context.localizedReason = call.getString("reason") ?? "Unlock your wallet"
        context.localizedCancelTitle = "Use password"
        var q = query(biometricService, key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        q[kSecUseAuthenticationContext as String] = context
        // Blocks while Face ID runs; Capacitor calls plugin methods off the main thread.
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let data = out as? Data, let value = String(data: data, encoding: .utf8) else {
                return call.reject("Biometric unlock failed", "failed")
            }
            call.resolve(["value": value])
        case errSecItemNotFound:
            // Never enrolled, or Face ID re-enrolled since (biometryCurrentSet).
            call.resolve(["value": NSNull()])
        case errSecUserCanceled:
            call.reject("Cancelled", "cancelled")
        default:
            call.reject("Biometric unlock failed (\(status))", "failed")
        }
    }

    /// Face ID / Touch ID OR the phone's passcode (LAPolicy.deviceOwnerAuthentication). Used to confirm the owner
    /// when the wallet password is forgotten (Change password). Resolves { ok }; a cancel resolves ok: false.
    @objc func deviceOwnerAuth(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return call.resolve(["ok": false])
        }
        let reason = call.getString("reason") ?? "Confirm it's you"
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            call.resolve(["ok": ok])
        }
    }

    @objc func biometricRemove(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        SecItemDelete(query(biometricService, key.isEmpty ? nil : key) as CFDictionary)
        call.resolve()
    }

    // MARK: - dApp browser

    private var browser: DappBrowserViewController?
    private var browserHidden = false

    @objc func browserOpen(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              let provider = call.getString("provider") else {
            return call.reject("Must provide an http(s) url and provider script")
        }
        DispatchQueue.main.async {
            if let browser = self.browser {
                browser.load(url)
                self.browserHidden = false
                self.present(browser)
                return call.resolve()
            }
            let browser = DappBrowserViewController(provider: provider)
            browser.onRequest = { [weak self] event in self?.notifyListeners("browserRequest", data: event) }
            browser.onClose = { [weak self] in self?.closeBrowser() }
            self.browser = browser
            self.browserHidden = false
            self.present(browser)
            browser.load(url)
            call.resolve()
        }
    }

    private func present(_ browser: DappBrowserViewController) {
        guard browser.presentingViewController == nil, let host = bridge?.viewController else { return }
        browser.modalPresentationStyle = .fullScreen
        host.present(browser, animated: true)
    }

    private func closeBrowser() {
        DispatchQueue.main.async {
            guard let browser = self.browser else { return }
            browser.teardown()
            browser.presentingViewController?.dismiss(animated: true)
            self.browser = nil
            self.notifyListeners("browserClosed", data: [:])
        }
    }

    @objc func browserClose(_ call: CAPPluginCall) {
        closeBrowser()
        call.resolve()
    }

    @objc func browserSetHidden(_ call: CAPPluginCall) {
        let hidden = call.getBool("hidden") ?? false
        DispatchQueue.main.async {
            guard let browser = self.browser, hidden != self.browserHidden else { return call.resolve() }
            self.browserHidden = hidden
            // Approval prompts render in the wallet WebView underneath: step aside for them.
            if hidden { browser.presentingViewController?.dismiss(animated: false) } else { self.present(browser) }
            call.resolve()
        }
    }

    @objc func browserRespond(_ call: CAPPluginCall) {
        let requestId = call.getString("requestId") ?? ""
        let response = call.getString("response") ?? "null"
        DispatchQueue.main.async {
            self.browser?.respond(requestId: requestId, response: response)
            call.resolve()
        }
    }

    @objc func browserEmit(_ call: CAPPluginCall) {
        let event = call.getString("event") ?? ""
        let detail = call.getString("detail") ?? "null"
        DispatchQueue.main.async {
            self.browser?.emit(event: event, detail: detail)
            call.resolve()
        }
    }

    // MARK: - Call audio (bWallet calls, src/mobile/calls/media.ts)

    /// Route call audio to the loudspeaker (on) or back to the receiver (off). WebRTC in
    /// WKWebView uses the shared AVAudioSession, so overriding its output port is enough.
    @objc func audioSetSpeaker(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                if on {
                    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
                }
                try session.overrideOutputAudioPort(on ? .speaker : .none)
                call.resolve()
            } catch {
                call.reject("Could not change the audio route: \(error.localizedDescription)")
            }
        }
    }
}

/// WebKit retains script message handlers strongly; this breaks the cycle.
private final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WKScriptMessageHandlerWithReply?
    init(_ target: WKScriptMessageHandlerWithReply) { self.target = target }
    func userContentController(
        _ controller: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let target = target else { return replyHandler(nil, "Wallet unavailable") }
        target.userContentController(controller, didReceive: message, replyHandler: replyHandler)
    }
}

final class DappBrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    var onRequest: (([String: Any]) -> Void)?
    var onClose: (() -> Void)?

    private let provider: String
    private var webView: WKWebView!
    private let titleButton = UIButton(type: .system)
    private let backButton = UIButton(type: .system)
    private var observingBack = false
    private var pending: [String: (generation: Int, reply: (Any?, String?) -> Void)] = [:]
    /// Bumped on every main-frame navigation; replies meant for an older page are refused.
    private var generation = 0

    init(provider: String) {
        self.provider = provider
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 1 / 255, green: 1 / 255, blue: 1 / 255, alpha: 1)

        let config = WKWebViewConfiguration()
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: provider, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        content.addScriptMessageHandler(WeakReplyHandler(self), contentWorld: .page, name: "yours")
        config.userContentController = content
        config.websiteDataStore = .default()
        // bApps (bmovies.app feeds) play video inline with playsInline, and muted autoplay works.
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // Lets sites tell they're inside the wallet (and can connect via window.CWI without a wallet chooser).
        // bWalletChannel: ios-store or ios-private (Info.plist BWalletChannel, set by scripts/channel-build.sh).
        let channel = Bundle.main.object(forInfoDictionaryKey: "BWalletChannel") as? String ?? "ios-store"
        config.applicationNameForUserAgent = "Mobile/15E148 bWallet/1 YoursWalletMobile/1 bWalletChannel/\(channel) bWalletInset/48"
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // Off: edge swipes clash with bApp feed swipes. Back lives on the bar's back button.
        webView.allowsBackForwardNavigationGestures = false
        webView.addObserver(self, forKeyPath: "canGoBack", options: [.new], context: nil)
        observingBack = true
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        let gray = UIColor(red: 156 / 255, green: 163 / 255, blue: 175 / 255, alpha: 1)
        let back = backButton
        back.setImage(UIImage(systemName: "chevron.left"), for: .normal)
        back.accessibilityLabel = "Close"
        back.tintColor = gray
        back.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        let close = UIButton(type: .system)
        close.setImage(UIImage(systemName: "xmark"), for: .normal)
        close.tintColor = gray
        close.accessibilityLabel = "Close"
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        titleButton.setTitleColor(gray, for: .normal)
        titleButton.titleLabel?.font = .systemFont(ofSize: 13)
        titleButton.titleLabel?.lineBreakMode = .byTruncatingMiddle
        titleButton.addTarget(self, action: #selector(promptForUrl), for: .touchUpInside)

        let bar = UIStackView(arrangedSubviews: [back, titleButton, close])
        bar.axis = .horizontal
        bar.alignment = .center
        bar.distribution = .fill
        titleButton.setContentHuggingPriority(.defaultLow, for: .horizontal)
        [bar, webView].forEach {
            $0!.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview($0!)
        }
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: guide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 4),
            bar.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -4),
            bar.heightAnchor.constraint(equalToConstant: 48),
            back.widthAnchor.constraint(equalToConstant: 48),
            close.widthAnchor.constraint(equalToConstant: 48),
            webView.topAnchor.constraint(equalTo: bar.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    func load(_ url: URL) {
        loadViewIfNeeded()
        webView.load(URLRequest(url: url))
    }

    func teardown() {
        failPending("Browser closed")
        webView?.configuration.userContentController.removeAllScriptMessageHandlers()
        webView?.stopLoading()
        if observingBack { webView?.removeObserver(self, forKeyPath: "canGoBack"); observingBack = false }
    }

    func respond(requestId: String, response: String) {
        guard let entry = pending.removeValue(forKey: requestId) else { return }
        if entry.generation == generation { entry.reply(response, nil) } else { entry.reply(nil, "Page changed") }
    }

    func emit(event: String, detail: String) {
        guard let eventJSON = try? JSONSerialization.data(withJSONObject: [event, detail], options: .fragmentsAllowed),
              let args = String(data: eventJSON, encoding: .utf8) else { return }
        webView.evaluateJavaScript("(function(a){window.dispatchEvent(new CustomEvent(a[0],{detail:JSON.parse(a[1])}))})(\(args))", in: nil, in: .page)
    }

    /// WebKit requires every reply handler to be called exactly once.
    private func failPending(_ reason: String) {
        let stale = pending
        pending.removeAll()
        stale.values.forEach { $0.reply(nil, reason) }
    }

    // MARK: WKScriptMessageHandlerWithReply

    func userContentController(
        _ controller: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let origin = message.frameInfo.securityOrigin
        let scheme = origin.protocol.lowercased()
        // Only the page the user sees may talk to the wallet; subframes (ads, embeds) may not.
        guard message.frameInfo.isMainFrame, scheme == "https" || scheme == "http",
              let payload = message.body as? String else {
            return replyHandler(nil, "Not allowed")
        }
        let defaultPort = scheme == "https" ? 443 : 80
        let port = origin.port == 0 || origin.port == defaultPort ? "" : ":\(origin.port)"
        let requestId = UUID().uuidString
        pending[requestId] = (generation, replyHandler)
        onRequest?([
            "requestId": requestId,
            "origin": "\(scheme)://\(origin.host)\(port)",
            "url": webView.url?.absoluteString ?? "",
            "payload": payload
        ])
    }

    // MARK: WKNavigationDelegate / WKUIDelegate

    func webView(
        _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let scheme = action.request.url?.scheme?.lowercased() ?? ""
        let allowed = ["https", "http", "about", "blob", "data"].contains(scheme)
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        generation += 1
        failPending("Page changed")
        titleButton.setTitle(webView.url?.host ?? "", for: .normal)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        titleButton.setTitle(webView.url?.host ?? "", for: .normal)
    }

    /// target=_blank / window.open: same site loads in this view; another site opens in Safari.
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard action.targetFrame == nil, let url = action.request.url else { return nil }
        let scheme = url.scheme?.lowercased() ?? ""
        if ["https", "http"].contains(scheme), !Self.sameSite(url.host, webView.url?.host) {
            UIApplication.shared.open(url)
        } else {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    /// Hosts match, ignoring a leading "www.".
    static func sameSite(_ a: String?, _ b: String?) -> Bool {
        func bare(_ h: String?) -> String {
            let h = (h ?? "").lowercased()
            return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
        }
        return !bare(a).isEmpty && bare(a) == bare(b)
    }

    /// Bar back: native history, else the page's own history (single-page apps), else close the
    /// browser and return to the wallet (same as ×).
    @objc private func goBack() {
        if webView.canGoBack {
            webView.goBack()
            return
        }
        let before = webView.url
        webView.evaluateJavaScript("history.length > 1 ? (history.back(), true) : false") { [weak self] result, _ in
            guard let self = self else { return }
            guard (result as? Bool) == true else {
                self.onClose?()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self = self else { return }
                if self.webView.url == before { self.onClose?() }
            }
        }
    }

    /// "Back" vs "Close" for VoiceOver, kept in step with the history.
    private func updateBackLabel() {
        backButton.accessibilityLabel = webView.canGoBack ? "Back" : "Close"
    }

    override func observeValue(
        forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey: Any]?,
        context: UnsafeMutableRawPointer?
    ) {
        if keyPath == "canGoBack" { updateBackLabel() } else {
            super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
        }
    }

    @objc private func closeTapped() { onClose?() }

    @objc private func promptForUrl() {
        let alert = UIAlertController(title: "Go to", message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = self.webView.url?.absoluteString
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Go", style: .default) { _ in
            let typed = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespaces) ?? ""
            guard !typed.isEmpty else { return }
            let text = typed.contains("://") ? typed : "https://\(typed)"
            if let url = URL(string: text), ["https", "http"].contains(url.scheme?.lowercased() ?? "") { self.load(url) }
        })
        present(alert, animated: true)
    }
}

// MARK: - Sign-in session (Continue with X / Google, src/mobile/social)

/// ASWebAuthenticationSession: the sign-in runs in Safari's own engine, inside the app, so
/// - x.com is not handed to the X app by its universal link (whose in-app browser shows Google's
///   sign-in as a white page and won't open bwalletx:// links), and Google accepts it (not a web view);
/// - it ends by itself when the return page navigates to `<scheme>://…`, handing back that URL.
extension YoursNativePlugin: ASWebAuthenticationPresentationContextProviding {
    private static var authSession: ASWebAuthenticationSession?

    @objc func authSession(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s), let scheme = call.getString("scheme") else {
            return call.reject("url and scheme are required")
        }
        DispatchQueue.main.async {
            YoursNativePlugin.authSession?.cancel()
            let done: ASWebAuthenticationSession.CompletionHandler = { callback, error in
                YoursNativePlugin.authSession = nil
                if let callback = callback { return call.resolve(["url": callback.absoluteString]) }
                if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    return call.reject("Sign-in cancelled.", "cancelled")
                }
                call.reject(error?.localizedDescription ?? "Sign-in failed")
            }
            // iOS 17.4+: finish on the https return page itself (owner, 6 Oct 2026: the page's bwalletx://
            // hand-off and its "Open bWalletX" link never closed the sheet, so the X sign-in was lost).
            let session: ASWebAuthenticationSession
            if #available(iOS 17.4, *), let host = call.getString("httpsHost"), let path = call.getString("httpsPath") {
                session = ASWebAuthenticationSession(url: url, callback: .https(host: host, path: path), completionHandler: done)
            } else {
                session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme, completionHandler: done)
            }
            session.presentationContextProvider = self
            // Share Safari's cookies, so someone already signed in to X or Google needn't sign in again.
            session.prefersEphemeralWebBrowserSession = false
            YoursNativePlugin.authSession = session
            if !session.start() {
                YoursNativePlugin.authSession = nil
                call.reject("Could not open the sign-in page")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.webView?.window ?? ASPresentationAnchor()
    }
}
