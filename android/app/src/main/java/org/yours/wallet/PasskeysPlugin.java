package org.yours.wallet;

import android.os.Build;
import android.os.CancellationSignal;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.CreateCredentialCancellationException;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native side of src/mobile/passkey/nativePasskeys.ts: passkeys for rpId web.bwalletx.com through Credential Manager,
 * with the WebAuthn PRF extension in the request JSON, so the app and web.bwalletx.com share one passkey and derive
 * the same backup key. The OS checks https://web.bwalletx.com/.well-known/assetlinks.json (get_login_creds) for this
 * package + signing cert. PRF results come from the provider (Google Password Manager returns them on recent Play
 * services; others may not), so create() may return only prf.enabled and JS follows with one get().
 * Binary values cross the bridge as base64url, the same encoding WebAuthn JSON uses.
 */
@CapacitorPlugin(name = "Passkeys")
public class PasskeysPlugin extends Plugin {

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        boolean ok = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P;
        r.put("available", ok);
        // PRF can only be proven by trying: it depends on the passkey provider, not the OS version.
        r.put("prf", ok ? JSObject.NULL : false);
        if (!ok) r.put("reason", "Passkeys need Android 9 or later.");
        call.resolve(r);
    }

    @PluginMethod
    public void create(PluginCall call) {
        String rpId = call.getString("rpId"), userId = call.getString("userId"), userName = call.getString("userName");
        String challenge = call.getString("challenge"), salt = call.getString("prfSalt");
        if (rpId == null || userId == null || userName == null || challenge == null || salt == null) {
            call.reject("Missing arguments.", "BAD_ARGS");
            return;
        }
        String json;
        try {
            JSONObject o = new JSONObject();
            o.put("challenge", challenge);
            o.put("rp", new JSONObject().put("id", rpId).put("name", call.getString("rpName", "bWalletX")));
            o.put("user", new JSONObject().put("id", userId).put("name", userName).put("displayName", userName));
            o.put("pubKeyCredParams", new JSONArray()
                .put(new JSONObject().put("type", "public-key").put("alg", -7))
                .put(new JSONObject().put("type", "public-key").put("alg", -257)));
            o.put("authenticatorSelection", new JSONObject()
                .put("authenticatorAttachment", "platform")
                .put("residentKey", "required")
                .put("requireResidentKey", true)
                .put("userVerification", "required"));
            o.put("attestation", "none");
            o.put("timeout", 120000);
            o.put("extensions", prfExt(salt));
            json = o.toString();
        } catch (JSONException e) {
            call.reject("Bad request.", "BAD_ARGS", e);
            return;
        }
        CredentialManager cm = CredentialManager.create(getContext());
        cm.createCredentialAsync(getActivity(), new CreatePublicKeyCredentialRequest(json), new CancellationSignal(),
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                @Override
                public void onResult(CreateCredentialResponse res) {
                    if (!(res instanceof CreatePublicKeyCredentialResponse)) {
                        call.reject("Unexpected credential type.", "ERROR");
                        return;
                    }
                    try {
                        JSONObject r = new JSONObject(((CreatePublicKeyCredentialResponse) res).getRegistrationResponseJson());
                        JSObject out = new JSObject();
                        out.put("credentialId", r.optString("rawId", r.optString("id")));
                        JSONObject prf = prfOut(r);
                        if (prf != null) {
                            if (prf.has("enabled")) out.put("prfEnabled", prf.optBoolean("enabled"));
                            String first = prfFirst(prf);
                            if (first != null) out.put("prf", first);
                        }
                        call.resolve(out);
                    } catch (JSONException e) {
                        call.reject("Bad response from the passkey provider.", "ERROR", e);
                    }
                }

                @Override
                public void onError(@NonNull CreateCredentialException e) {
                    if (e instanceof CreateCredentialCancellationException) call.reject("No passkey was made.", "CANCELLED");
                    else call.reject(String.valueOf(e.getMessage()), "ERROR", e);
                }
            });
    }

    @PluginMethod
    public void get(PluginCall call) {
        String rpId = call.getString("rpId"), challenge = call.getString("challenge"), salt = call.getString("prfSalt");
        if (rpId == null || challenge == null || salt == null) {
            call.reject("Missing arguments.", "BAD_ARGS");
            return;
        }
        String json;
        try {
            JSONObject o = new JSONObject();
            o.put("challenge", challenge);
            o.put("rpId", rpId);
            o.put("userVerification", "required");
            o.put("timeout", 120000);
            JSONArray allow = new JSONArray();
            JSArray ids = call.getArray("allowCredentials", new JSArray());
            for (int i = 0; i < ids.length(); i++) {
                allow.put(new JSONObject().put("type", "public-key").put("id", ids.getString(i)));
            }
            o.put("allowCredentials", allow);
            o.put("extensions", prfExt(salt));
            json = o.toString();
        } catch (JSONException e) {
            call.reject("Bad request.", "BAD_ARGS", e);
            return;
        }
        GetCredentialRequest req = new GetCredentialRequest.Builder()
            .addCredentialOption(new GetPublicKeyCredentialOption(json))
            .build();
        CredentialManager cm = CredentialManager.create(getContext());
        cm.getCredentialAsync(getActivity(), req, new CancellationSignal(), ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse res) {
                    Credential c = res.getCredential();
                    if (!(c instanceof PublicKeyCredential)) {
                        call.reject("Unexpected credential type.", "ERROR");
                        return;
                    }
                    try {
                        JSONObject r = new JSONObject(((PublicKeyCredential) c).getAuthenticationResponseJson());
                        JSObject out = new JSObject();
                        out.put("credentialId", r.optString("rawId", r.optString("id")));
                        String first = prfFirst(prfOut(r));
                        if (first != null) out.put("prf", first);
                        call.resolve(out);
                    } catch (JSONException e) {
                        call.reject("Bad response from the passkey provider.", "ERROR", e);
                    }
                }

                @Override
                public void onError(@NonNull GetCredentialException e) {
                    if (e instanceof GetCredentialCancellationException) call.reject("No passkey was chosen.", "CANCELLED");
                    else if (e instanceof NoCredentialException)
                        call.reject("No bWalletX passkey on this phone.", "NO_CREDENTIAL");
                    else call.reject(String.valueOf(e.getMessage()), "ERROR", e);
                }
            });
    }

    private static JSONObject prfExt(String salt) throws JSONException {
        return new JSONObject().put("prf", new JSONObject().put("eval", new JSONObject().put("first", salt)));
    }

    private static JSONObject prfOut(JSONObject response) {
        JSONObject ext = response.optJSONObject("clientExtensionResults");
        return ext == null ? null : ext.optJSONObject("prf");
    }

    private static String prfFirst(JSONObject prf) {
        if (prf == null) return null;
        JSONObject results = prf.optJSONObject("results");
        if (results == null) return null;
        String first = results.optString("first", "");
        return first.isEmpty() ? null : first;
    }
}
