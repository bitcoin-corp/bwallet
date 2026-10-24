import AuthenticationServices
import Capacitor
import CryptoKit
import UIKit

/// Native side of src/mobile/passkey/nativePasskeys.ts: platform passkeys for rpId web.bwalletx.com with the WebAuthn
/// PRF extension, so the app and web.bwalletx.com share one passkey and derive the same backup key.
///
/// Needs `webcredentials:web.bwalletx.com` in App.entitlements and https://web.bwalletx.com/.well-known/apple-app-site-association
/// listing ZQ4NX9NJ89.<bundle id>. PRF needs iOS 18+; older iOS reports UNSUPPORTED and the UI keeps the 12 words.
/// The salt is passed as the WebAuthn PRF input (AuthenticationServices applies the same WebAuthn hashing as Safari).
/// Binary values cross the bridge as base64url.
@objc(PasskeysPlugin)
public class PasskeysPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "PasskeysPlugin"
    public let jsName = "Passkeys"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
    ]

    private var pending: CAPPluginCall?
    private var controller: ASAuthorizationController?

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 18.0, *) {
            call.resolve(["available": true, "prf": true])
        } else {
            call.resolve(["available": false, "prf": false, "reason": "Passkey backup needs iOS 18 or later."])
        }
    }

    @objc func create(_ call: CAPPluginCall) {
        guard #available(iOS 18.0, *) else { return call.reject("Passkey backup needs iOS 18 or later.", "UNSUPPORTED") }
        guard let rpId = call.getString("rpId"), let userName = call.getString("userName"),
            let userId = PasskeysPlugin.fromB64url(call.getString("userId")),
            let challenge = PasskeysPlugin.fromB64url(call.getString("challenge")),
            let salt = PasskeysPlugin.fromB64url(call.getString("prfSalt"))
        else { return call.reject("Missing or bad arguments.", "BAD_ARGS") }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let req = provider.createCredentialRegistrationRequest(challenge: challenge, name: userName, userID: userId)
        req.userVerificationPreference = .required
        req.prf = .inputValues(.saltInput1(salt))
        perform(req, call)
    }

    @objc func get(_ call: CAPPluginCall) {
        guard #available(iOS 18.0, *) else { return call.reject("Passkey backup needs iOS 18 or later.", "UNSUPPORTED") }
        guard let rpId = call.getString("rpId"),
            let challenge = PasskeysPlugin.fromB64url(call.getString("challenge")),
            let salt = PasskeysPlugin.fromB64url(call.getString("prfSalt"))
        else { return call.reject("Missing or bad arguments.", "BAD_ARGS") }
        let allow = (call.getArray("allowCredentials", String.self) ?? []).compactMap { PasskeysPlugin.fromB64url($0) }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let req = provider.createCredentialAssertionRequest(challenge: challenge)
        req.userVerificationPreference = .required
        if !allow.isEmpty {
            req.allowedCredentials = allow.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        }
        req.prf = .inputValues(.saltInput1(salt))
        perform(req, call)
    }

    private func perform(_ req: ASAuthorizationRequest, _ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let old = self.pending { old.reject("Another passkey request started.", "CANCELLED") }
            self.pending = call
            let c = ASAuthorizationController(authorizationRequests: [req])
            c.delegate = self
            c.presentationContextProvider = self
            self.controller = c
            c.performRequests()
        }
    }

    private func finish() -> CAPPluginCall? {
        let c = pending
        pending = nil
        controller = nil
        return c
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        bridge?.webView?.window ?? ASPresentationAnchor()
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = finish() else { return }
        guard #available(iOS 18.0, *) else { return call.reject("Passkey backup needs iOS 18 or later.", "UNSUPPORTED") }
        if let reg = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            var out: [String: Any] = ["credentialId": PasskeysPlugin.b64url(reg.credentialID)]
            if let prf = reg.prf {
                out["prfEnabled"] = prf.isSupported
                if let first = prf.first { out["prf"] = PasskeysPlugin.b64url(first) }
            }
            return call.resolve(out)
        }
        if let a = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            var out: [String: Any] = ["credentialId": PasskeysPlugin.b64url(a.credentialID)]
            if let prf = a.prf { out["prf"] = PasskeysPlugin.b64url(prf.first) }
            return call.resolve(out)
        }
        call.reject("Unexpected credential type.", "ERROR")
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = finish() else { return }
        let code = (error as? ASAuthorizationError)?.code
        if code == .canceled { return call.reject("No passkey was chosen.", "CANCELLED") }
        call.reject(error.localizedDescription, "ERROR", error)
    }

    // MARK: base64url

    static func b64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func b64url(_ k: SymmetricKey) -> String { b64url(k.withUnsafeBytes { Data($0) }) }

    static func fromB64url(_ s: String?) -> Data? {
        guard var t = s?.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") else {
            return nil
        }
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
}
