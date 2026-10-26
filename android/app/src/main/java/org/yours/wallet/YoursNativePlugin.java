package org.yours.wallet;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.media.AudioManager;
import android.media.AudioDeviceInfo;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.os.Message;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * Native side of src/mobile/native.ts.
 *
 * secure*    AES-GCM with a non-exportable AndroidKeyStore key; ciphertext in private prefs.
 * biometric* Separate AndroidKeyStore key usable only after a strong-biometric prompt,
 *            invalidated when biometrics are re-enrolled.
 * browser*   Full-screen WebView overlay for dApps. The provider script is injected at
 *            document start; messages are accepted from the main frame only and carry the
 *            origin WebView reports, never one the page claims.
 */
@CapacitorPlugin(
    name = "YoursNative",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") }
)
public class YoursNativePlugin extends Plugin {

    /**
     * In-frame bApps (src/mobile/bappFrame) are cross-origin iframes in the wallet WebView; Android
     * blocks their cookies by default, which breaks their logins. Only allowlisted bApps are framed.
     */
    @Override
    public void load() {
        CookieManager.getInstance().setAcceptThirdPartyCookies(getBridge().getWebView(), true);
    }

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String STORAGE_ALIAS = "yours_storage_v1";
    private static final String BIOMETRIC_ALIAS = "yours_biometric_v1";
    private static final String STORAGE_PREFS = "yours_secure";
    private static final String BIOMETRIC_PREFS = "yours_biometric";
    private static final int GCM_TAG_BITS = 128;

    // ------------------------------------------------------------------ secure storage

    private SharedPreferences prefs(String name) {
        return getContext().getSharedPreferences(name, Context.MODE_PRIVATE);
    }

    private SecretKey storageKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(STORAGE_ALIAS)) return (SecretKey) ks.getKey(STORAGE_ALIAS, null);
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(
            new KeyGenParameterSpec.Builder(STORAGE_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return gen.generateKey();
    }

    private static String seal(Cipher cipher, String plain) throws Exception {
        byte[] ct = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        byte[] out = new byte[1 + iv.length + ct.length];
        out[0] = (byte) iv.length;
        System.arraycopy(iv, 0, out, 1, iv.length);
        System.arraycopy(ct, 0, out, 1 + iv.length, ct.length);
        return Base64.encodeToString(out, Base64.NO_WRAP);
    }

    private static byte[] ivOf(String sealed) {
        byte[] raw = Base64.decode(sealed, Base64.NO_WRAP);
        byte[] iv = new byte[raw[0]];
        System.arraycopy(raw, 1, iv, 0, iv.length);
        return iv;
    }

    private static String open(Cipher cipher, String sealed) throws Exception {
        byte[] raw = Base64.decode(sealed, Base64.NO_WRAP);
        int ivLen = raw[0];
        byte[] ct = new byte[raw.length - 1 - ivLen];
        System.arraycopy(raw, 1 + ivLen, ct, 0, ct.length);
        return new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("Must provide key");
            return;
        }
        try {
            String sealed = prefs(STORAGE_PREFS).getString(key, null);
            JSObject ret = new JSObject();
            if (sealed == null) {
                ret.put("value", JSObject.NULL);
            } else {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, storageKey(), new GCMParameterSpec(GCM_TAG_BITS, ivOf(sealed)));
                ret.put("value", open(cipher, sealed));
            }
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Secure read failed", e);
        }
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("Must provide key and value");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, storageKey());
            // commit(): the keystore must be on disk before JS is told it was saved.
            if (!prefs(STORAGE_PREFS).edit().putString(key, seal(cipher, value)).commit()) {
                call.reject("Secure write failed");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Secure write failed", e);
        }
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("Must provide key");
            return;
        }
        prefs(STORAGE_PREFS).edit().remove(key).commit();
        call.resolve();
    }

    @PluginMethod
    public void secureKeys(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("keys", new org.json.JSONArray(prefs(STORAGE_PREFS).getAll().keySet()));
        call.resolve(ret);
    }

    // ------------------------------------------------------------------ biometrics

    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    private boolean biometricAvailable() {
        return BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    private SecretKey biometricKey(boolean create) throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(BIOMETRIC_ALIAS)) return (SecretKey) ks.getKey(BIOMETRIC_ALIAS, null);
        if (!create) return null;
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
            BIOMETRIC_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(spec.build());
        return gen.generateKey();
    }

    private void deleteBiometricKey() {
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE);
            ks.load(null);
            ks.deleteEntry(BIOMETRIC_ALIAS);
        } catch (Exception ignored) {}
        prefs(BIOMETRIC_PREFS).edit().clear().commit();
    }

    private interface CipherUse {
        void run(Cipher cipher) throws Exception;
    }

    private void promptWithCipher(PluginCall call, Cipher cipher, String title, String subtitle, CipherUse use) {
        getActivity().runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(
                (AppCompatActivity) getActivity(),
                ContextCompat.getMainExecutor(getContext()),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                        try {
                            use.run(result.getCryptoObject().getCipher());
                        } catch (Exception e) {
                            call.reject("Biometric operation failed", "failed", e);
                        }
                    }

                    @Override
                    public void onAuthenticationError(int code, @NonNull CharSequence message) {
                        boolean cancelled =
                            code == BiometricPrompt.ERROR_USER_CANCELED ||
                            code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                            code == BiometricPrompt.ERROR_CANCELED;
                        call.reject(message.toString(), cancelled ? "cancelled" : "failed");
                    }
                }
            );
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setNegativeButtonText("Use password")
                .setAllowedAuthenticators(AUTHENTICATORS)
                .build();
            prompt.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
    }

    @PluginMethod
    public void biometricStatus(PluginCall call) {
        JSObject ret = new JSObject();
        boolean available = biometricAvailable();
        ret.put("available", available);
        ret.put("biometryType", available ? "fingerprint" : "none");
        call.resolve(ret);
    }

    @PluginMethod
    public void biometricSet(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("Must provide key and value");
            return;
        }
        if (!biometricAvailable()) {
            call.reject("Biometrics unavailable", "unavailable");
            return;
        }
        try {
            // A fresh key per enrolment: nothing sealed under an older one survives.
            deleteBiometricKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, biometricKey(true));
            promptWithCipher(call, cipher, "Turn on fingerprint unlock", "Confirm to unlock your wallet with your fingerprint", (c) -> {
                prefs(BIOMETRIC_PREFS).edit().putString(key, seal(c, value)).commit();
                call.resolve();
            });
        } catch (Exception e) {
            call.reject("Biometric setup failed", "failed", e);
        }
    }

    @PluginMethod
    public void biometricGet(PluginCall call) {
        String key = call.getString("key");
        String reason = call.getString("reason", "Unlock your wallet");
        String sealed = key == null ? null : prefs(BIOMETRIC_PREFS).getString(key, null);
        if (sealed == null) {
            JSObject ret = new JSObject();
            ret.put("value", JSObject.NULL);
            call.resolve(ret);
            return;
        }
        try {
            SecretKey secret = biometricKey(false);
            if (secret == null) throw new KeyPermanentlyInvalidatedException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secret, new GCMParameterSpec(GCM_TAG_BITS, ivOf(sealed)));
            promptWithCipher(call, cipher, "Unlock your wallet", reason, (c) -> {
                JSObject ret = new JSObject();
                ret.put("value", open(c, sealed));
                call.resolve(ret);
            });
        } catch (KeyPermanentlyInvalidatedException e) {
            // Biometrics changed since enrolment: the sealed passKey is unrecoverable by design. The JS side
            // (biometricUnlock.ts) tells the user and re-enrols after the next password unlock.
            android.util.Log.w("YoursNative", "biometric key invalidated (new fingerprint enrolled?); needs re-enrolment");
            deleteBiometricKey();
            JSObject ret = new JSObject();
            ret.put("value", JSObject.NULL);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Biometric unlock failed", "failed", e);
        }
    }

    /**
     * Fingerprint / face OR the phone's PIN, pattern or password (BiometricPrompt with DEVICE_CREDENTIAL). Used to
     * confirm the owner when the wallet password is forgotten (Change password). Resolves { ok }.
     */
    @PluginMethod
    public void deviceOwnerAuth(PluginCall call) {
        String reason = call.getString("reason", "Confirm it's you");
        int allowed = BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        if (BiometricManager.from(getContext()).canAuthenticate(allowed) != BiometricManager.BIOMETRIC_SUCCESS) {
            JSObject no = new JSObject();
            no.put("ok", false);
            call.resolve(no);
            return;
        }
        getActivity().runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(
                (AppCompatActivity) getActivity(),
                ContextCompat.getMainExecutor(getContext()),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                        JSObject ret = new JSObject();
                        ret.put("ok", true);
                        call.resolve(ret);
                    }

                    @Override
                    public void onAuthenticationError(int code, @NonNull CharSequence message) {
                        JSObject ret = new JSObject();
                        ret.put("ok", false);
                        call.resolve(ret);
                    }
                }
            );
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("Confirm it's you")
                .setSubtitle(reason)
                .setAllowedAuthenticators(allowed)
                .build();
            prompt.authenticate(info);
        });
    }

    @PluginMethod
    public void biometricRemove(PluginCall call) {
        deleteBiometricKey();
        call.resolve();
    }

    // ------------------------------------------------------------------ dApp browser

    private FrameLayout browserRoot;
    private WebView browser;
    private TextView browserTitle;
    private OnBackPressedCallback browserBack;
    private TextView browserBackButton;
    /** Fullscreen video view from WebChromeClient.onShowCustomView, laid over the browser. */
    private View browserFullscreen;
    private WebChromeClient.CustomViewCallback browserFullscreenCallback;
    /** Bumped on every main-frame navigation; replies for an older page are dropped. */
    private int pageGeneration = 0;
    private final Map<String, PendingReply> pendingReplies = new HashMap<>();

    private static final class PendingReply {

        final JavaScriptReplyProxy proxy;
        final String pageRequestId;
        final int generation;

        PendingReply(JavaScriptReplyProxy proxy, String pageRequestId, int generation) {
            this.proxy = proxy;
            this.pageRequestId = pageRequestId;
            this.generation = generation;
        }
    }

    /** Hosts match, ignoring a leading "www.". */
    static boolean sameSite(String a, String b) {
        String x = a == null ? "" : a.toLowerCase().replaceFirst("^www\\.", "");
        String y = b == null ? "" : b.toLowerCase().replaceFirst("^www\\.", "");
        return !x.isEmpty() && x.equals(y);
    }

    private void exitBrowserFullscreen() {
        if (browserFullscreen == null) return;
        if (browserRoot != null) browserRoot.removeView(browserFullscreen);
        browserFullscreen = null;
        if (browserFullscreenCallback != null) browserFullscreenCallback.onCustomViewHidden();
        browserFullscreenCallback = null;
    }

    private static boolean isWebUrl(Uri uri) {
        String scheme = uri.getScheme();
        return "https".equals(scheme) || "http".equals(scheme);
    }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
    }

    @SuppressLint("SetJavaScriptEnabled")
    @PluginMethod
    public void browserOpen(PluginCall call) {
        String url = call.getString("url");
        String provider = call.getString("provider");
        if (url == null || provider == null || !isWebUrl(Uri.parse(url))) {
            call.reject("Must provide an http(s) url and provider script");
            return;
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            call.reject("This Android System WebView is too old for the dApp browser; update it from Play Store");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (browser != null) {
                browserRoot.setVisibility(View.VISIBLE);
                browser.loadUrl(url);
                call.resolve();
                return;
            }
            AppCompatActivity activity = (AppCompatActivity) getActivity();

            browserRoot = new FrameLayout(activity);
            browserRoot.setBackgroundColor(Color.rgb(1, 1, 1));
            browserRoot.setClickable(true);
            LinearLayout column = new LinearLayout(activity);
            column.setOrientation(LinearLayout.VERTICAL);
            browserRoot.addView(column, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

            LinearLayout bar = new LinearLayout(activity);
            bar.setOrientation(LinearLayout.HORIZONTAL);
            bar.setGravity(Gravity.CENTER_VERTICAL);
            bar.setPadding(dp(4), 0, dp(4), 0);
            TextView back = toolbarButton(activity, "‹", 26);
            back.setContentDescription("Back");
            browserBackButton = back;
            back.setOnClickListener((v) -> browserGoBack());
            browserTitle = new TextView(activity);
            browserTitle.setTextColor(Color.rgb(156, 163, 175));
            browserTitle.setTextSize(13);
            browserTitle.setSingleLine(true);
            browserTitle.setGravity(Gravity.CENTER);
            browserTitle.setOnClickListener((v) -> promptForUrl(activity));
            TextView close = toolbarButton(activity, "✕", 18);
            close.setOnClickListener((v) -> closeBrowser());
            bar.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));
            bar.addView(browserTitle, new LinearLayout.LayoutParams(0, dp(48), 1));
            bar.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
            column.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

            browser = new WebView(activity);
            WebSettings s = browser.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setAllowFileAccess(false);
            s.setAllowContentAccess(false);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            // On so target=_blank / window.open reach onCreateWindow below (another site opens in the system browser).
            s.setSupportMultipleWindows(true);
            s.setJavaScriptCanOpenWindowsAutomatically(true);
            // bApps (bmovies.app feeds) autoplay muted video without a tap.
            s.setMediaPlaybackRequiresUserGesture(false);
            // Lets sites tell they're inside the wallet (and can connect via window.CWI without a wallet chooser).
            // bWalletInset/48: the wallet bar above the page is 48dp tall.
            s.setUserAgentString(
                s.getUserAgentString() + " bWallet/1 YoursWalletMobile/1 bWalletChannel/" + BuildConfig.CHANNEL + " bWalletInset/48"
            );
            browser.setWebChromeClient(
                new WebChromeClient() {
                    @Override
                    public void onShowCustomView(View view, CustomViewCallback callback) {
                        exitBrowserFullscreen();
                        if (browserRoot == null) {
                            callback.onCustomViewHidden();
                            return;
                        }
                        view.setBackgroundColor(Color.BLACK);
                        browserFullscreen = view;
                        browserFullscreenCallback = callback;
                        browserRoot.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    }

                    @Override
                    public void onHideCustomView() {
                        exitBrowserFullscreen();
                    }

                    @Override
                    public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                        // A throwaway WebView catches the new window's first URL, then is dropped.
                        WebView probe = new WebView(view.getContext());
                        probe.setWebViewClient(
                            new WebViewClient() {
                                @Override
                                public boolean shouldOverrideUrlLoading(WebView p, WebResourceRequest request) {
                                    openNewWindowUrl(request.getUrl());
                                    p.destroy();
                                    return true;
                                }
                            }
                        );
                        WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                        transport.setWebView(probe);
                        resultMsg.sendToTarget();
                        return true;
                    }
                }
            );
            browser.setWebViewClient(
                new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        // Only web pages load here; other schemes (intent:, file:, javascript:) are dropped.
                        return !isWebUrl(request.getUrl());
                    }

                    @Override
                    public void onPageStarted(WebView view, String pageUrl, android.graphics.Bitmap favicon) {
                        pageGeneration++;
                        pendingReplies.clear();
                        Uri uri = Uri.parse(pageUrl);
                        if (browserTitle != null) browserTitle.setText(uri.getHost() == null ? pageUrl : uri.getHost());
                    }

                    @Override
                    public void doUpdateVisitedHistory(WebView view, String pageUrl, boolean isReload) {
                        updateBrowserBackLabel();
                    }
                }
            );

            Set<String> anyOrigin = Collections.singleton("*");
            WebViewCompat.addDocumentStartJavaScript(browser, provider, anyOrigin);
            WebViewCompat.addWebMessageListener(browser, "yoursNative", anyOrigin, (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                // Subframes (ads, embeds) cannot talk to the wallet; only the page the user sees.
                if (!isMainFrame || !isWebUrl(sourceOrigin)) return;
                try {
                    JSONObject msg = new JSONObject(message.getData());
                    String requestId = UUID.randomUUID().toString();
                    pendingReplies.put(requestId, new PendingReply(replyProxy, msg.getString("id"), pageGeneration));
                    JSObject event = new JSObject();
                    event.put("requestId", requestId);
                    event.put("origin", sourceOrigin.toString().replaceAll("/$", ""));
                    event.put("url", view.getUrl());
                    event.put("payload", msg.getString("payload"));
                    notifyListeners("browserRequest", event);
                } catch (Exception ignored) {}
            });
            column.addView(browser, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

            ViewCompat.setOnApplyWindowInsetsListener(browserRoot, (v, insets) -> {
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsetsCompat.CONSUMED;
            });
            activity.addContentView(browserRoot, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            ViewCompat.requestApplyInsets(browserRoot);

            browserBack = new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    if (browserFullscreen != null) exitBrowserFullscreen();
                    else browserGoBack();
                }
            };
            activity.getOnBackPressedDispatcher().addCallback(activity, browserBack);

            browser.loadUrl(url);
            call.resolve();
        });
    }

    private TextView toolbarButton(Context context, String label, int sizeSp) {
        TextView button = new TextView(context);
        button.setText(label);
        button.setTextSize(sizeSp);
        button.setTextColor(Color.rgb(156, 163, 175));
        button.setGravity(Gravity.CENTER);
        return button;
    }

    private void promptForUrl(AppCompatActivity activity) {
        EditText input = new EditText(activity);
        input.setSingleLine(true);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setText(browser == null ? "" : browser.getUrl());
        input.selectAll();
        androidx.appcompat.app.AlertDialog dialog = new androidx.appcompat.app.AlertDialog.Builder(activity)
            .setTitle("Go to")
            .setView(input)
            .setPositiveButton("Go", (d, w) -> loadTyped(input.getText().toString()))
            .setNegativeButton("Cancel", null)
            .create();
        input.setOnEditorActionListener((v, actionId, event) -> {
            loadTyped(input.getText().toString());
            dialog.dismiss();
            return true;
        });
        dialog.show();
    }

    private void loadTyped(String typed) {
        String text = typed.trim();
        if (text.isEmpty() || browser == null) return;
        String url = text.contains("://") ? text : "https://" + text;
        if (isWebUrl(Uri.parse(url))) browser.loadUrl(url);
    }

    /** target=_blank / window.open: same site loads in place; another site opens in the system browser. */
    private void openNewWindowUrl(Uri uri) {
        if (browser == null || !isWebUrl(uri)) return;
        Uri current = browser.getUrl() == null ? null : Uri.parse(browser.getUrl());
        if (current != null && sameSite(uri.getHost(), current.getHost())) {
            browser.loadUrl(uri.toString());
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
        } catch (Exception ignored) {}
    }

    /**
     * Bar back and system back: native history, else the page's own history (single-page apps),
     * else close the browser and return to the wallet.
     */
    private void browserGoBack() {
        final WebView view = browser;
        if (view == null) return;
        if (view.canGoBack()) {
            view.goBack();
            return;
        }
        final String before = view.getUrl();
        view.evaluateJavascript("history.length > 1 ? (history.back(), true) : false", (result) -> {
            if (browser != view) return;
            if (!"true".equals(result)) {
                closeBrowser();
                return;
            }
            view.postDelayed(() -> {
                if (browser != view) return;
                String after = view.getUrl();
                if (after == null ? before == null : after.equals(before)) closeBrowser();
            }, 300);
        });
    }

    /** Back label: "Close" when back would leave the browser. */
    private void updateBrowserBackLabel() {
        if (browserBackButton == null || browser == null) return;
        browserBackButton.setContentDescription(browser.canGoBack() ? "Back" : "Close");
    }

    private void closeBrowser() {
        getActivity().runOnUiThread(() -> {
            if (browser == null) return;
            if (browserBack != null) browserBack.remove();
            exitBrowserFullscreen();
            ((ViewGroup) browserRoot.getParent()).removeView(browserRoot);
            browser.destroy();
            browser = null;
            browserRoot = null;
            browserTitle = null;
            browserBackButton = null;
            pendingReplies.clear();
            notifyListeners("browserClosed", new JSObject());
        });
    }

    @PluginMethod
    public void browserClose(PluginCall call) {
        closeBrowser();
        call.resolve();
    }

    @PluginMethod
    public void browserSetHidden(PluginCall call) {
        boolean hidden = Boolean.TRUE.equals(call.getBoolean("hidden", false));
        getActivity().runOnUiThread(() -> {
            if (browserRoot != null) browserRoot.setVisibility(hidden ? View.GONE : View.VISIBLE);
            if (browserBack != null) browserBack.setEnabled(!hidden);
            call.resolve();
        });
    }

    @PluginMethod
    public void browserRespond(PluginCall call) {
        String requestId = call.getString("requestId");
        String response = call.getString("response");
        getActivity().runOnUiThread(() -> {
            PendingReply pending = requestId == null ? null : pendingReplies.remove(requestId);
            if (pending != null && pending.generation == pageGeneration && response != null) {
                try {
                    JSONObject out = new JSONObject();
                    out.put("id", pending.pageRequestId);
                    out.put("response", response);
                    pending.proxy.postMessage(out.toString());
                } catch (Exception ignored) {}
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void browserEmit(PluginCall call) {
        String event = call.getString("event");
        String detail = call.getString("detail", "null");
        getActivity().runOnUiThread(() -> {
            if (browser != null && event != null) {
                String js =
                    "window.dispatchEvent(new CustomEvent(" + JSONObject.quote(event) + ",{detail:JSON.parse(" + JSONObject.quote(detail) + ")}));";
                browser.evaluateJavascript(js, null);
            }
            call.resolve();
        });
    }

    // ------------------------------------------------------------------ speech (hold the dock's b to talk to b)

    private SpeechRecognizer speech;
    private String speechText = "";
    private PluginCall speechStopCall;

    @PluginMethod
    public void speechAvailable(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(out);
    }

    @PluginMethod
    public void haptic(PluginCall call) {
        try {
            Vibrator v = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null) v.vibrate(VibrationEffect.createOneShot(15, VibrationEffect.DEFAULT_AMPLITUDE));
        } catch (Exception ignored) {}
        call.resolve();
    }

    private void speechResult(PluginCall call, boolean started, String reason) {
        JSObject out = new JSObject();
        out.put("started", started);
        if (reason != null) out.put("reason", reason);
        call.resolve(out);
    }

    /** Resolves once listening: { started: true } or { started: false, reason: 'denied' | 'asked' | 'unavailable' }. */
    @PluginMethod
    public void speechStart(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "speechPermission");
            return;
        }
        beginSpeech(call);
    }

    @PermissionCallback
    private void speechPermission(PluginCall call) {
        // The finger has usually let go while the prompt was up: say so rather than start listening late.
        speechResult(call, false, getPermissionState("microphone") == PermissionState.GRANTED ? "asked" : "denied");
    }

    private void beginSpeech(PluginCall call) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            speechResult(call, false, "unavailable");
            return;
        }
        getActivity().runOnUiThread(() -> {
            destroySpeech();
            speechText = "";
            speech = SpeechRecognizer.createSpeechRecognizer(getContext());
            speech.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle b) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rms) {
                    JSObject o = new JSObject();
                    o.put("level", Math.max(0, Math.min(1, (rms + 2) / 12.0)));
                    notifyListeners("speechLevel", o);
                }
                @Override public void onBufferReceived(byte[] b) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onError(int error) { finishSpeech(); }
                @Override public void onResults(Bundle b) { take(b); finishSpeech(); }
                @Override public void onPartialResults(Bundle b) { take(b); }
                @Override public void onEvent(int t, Bundle b) {}
                private void take(Bundle b) {
                    ArrayList<String> m = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (m == null || m.isEmpty() || m.get(0) == null || m.get(0).isEmpty()) return;
                    speechText = m.get(0);
                    JSObject o = new JSObject();
                    o.put("text", speechText);
                    notifyListeners("speechPartial", o);
                }
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
            // Holding = talking: don't end on a pause.
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 10000);
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 10000);
            speech.startListening(i);
            speechResult(call, true, null);
        });
    }

    /** Recognition ended (results, error or the stop timeout): answer a waiting speechStop. */
    private void finishSpeech() {
        PluginCall c = speechStopCall;
        speechStopCall = null;
        if (c != null) {
            JSObject o = new JSObject();
            o.put("text", speechText);
            c.resolve(o);
        }
    }

    private void destroySpeech() {
        if (speech != null) {
            speech.destroy();
            speech = null;
        }
    }

    @PluginMethod
    public void speechStop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (speech == null) {
                JSObject o = new JSObject();
                o.put("text", speechText);
                call.resolve(o);
                return;
            }
            speechStopCall = call;
            speech.stopListening();
            // Final results normally land within a second; don't wait forever.
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                finishSpeech();
                destroySpeech();
            }, 1500);
        });
    }

    @PluginMethod
    public void speechCancel(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            speechStopCall = null;
            if (speech != null) speech.cancel();
            destroySpeech();
            speechText = "";
            call.resolve();
        });
    }

    /** Tester check-ins (src/mobile/testers/checkin.ts): who installed this app; com.android.vending = Google Play. */
    @PluginMethod
    public void installerPackage(PluginCall call) {
        String installer = null;
        try {
            android.content.pm.PackageManager pm = getContext().getPackageManager();
            String pkg = getContext().getPackageName();
            if (android.os.Build.VERSION.SDK_INT >= 30) installer = pm.getInstallSourceInfo(pkg).getInstallingPackageName();
            else installer = pm.getInstallerPackageName(pkg);
        } catch (Exception ignored) {}
        JSObject out = new JSObject();
        out.put("installer", installer);
        call.resolve(out);
    }

    /**
     * Return-to-site after a phone pairing (src/pair/returnTo.ts): open an intent://…#Intent;scheme=https;package=…;
     * S.browser_fallback_url=…;end URL in the browser the user came from. Only an https VIEW of a browsable URL is
     * started (no component, selector or extras are copied); if that browser is gone, the https fallback opens in the
     * default browser.
     */
    @PluginMethod
    public void openIntentUri(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null || !uri.startsWith("intent://")) {
            call.reject("Must provide an intent:// url");
            return;
        }
        Intent parsed;
        try {
            parsed = Intent.parseUri(uri, Intent.URI_INTENT_SCHEME);
        } catch (Exception e) {
            call.reject("Bad intent url");
            return;
        }
        Uri data = parsed.getData();
        String fallback = parsed.getStringExtra("browser_fallback_url");
        if (data == null || !"https".equals(data.getScheme())) {
            call.reject("Return must be https");
            return;
        }
        Intent view = new Intent(Intent.ACTION_VIEW, data);
        view.addCategory(Intent.CATEGORY_BROWSABLE);
        view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (parsed.getPackage() != null) view.setPackage(parsed.getPackage());
        try {
            getContext().startActivity(view);
            call.resolve();
            return;
        } catch (android.content.ActivityNotFoundException e) {
            // that browser isn't installed: fall through to the https fallback
        }
        Uri fb = fallback != null ? Uri.parse(fallback) : data;
        if (!"https".equals(fb.getScheme())) fb = data;
        try {
            Intent plain = new Intent(Intent.ACTION_VIEW, fb);
            plain.addCategory(Intent.CATEGORY_BROWSABLE);
            plain.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(plain);
            call.resolve();
        } catch (Exception e) {
            call.reject("No browser to return to");
        }
    }

    /** Open this app's details page in Android Settings (Permissions lives there). */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open Settings");
        }
    }

    /**
     * Recovery phrase / key copies (src/mobile/secretClipboard.ts): the clip is marked sensitive
     * (ClipDescription.EXTRA_IS_SENSITIVE, honoured from Android 13) so the system preview hides it.
     * The token is a random clip label; secretClear wipes only a clip that still carries it.
     */
    @PluginMethod
    public void secretCopy(PluginCall call) {
        String text = call.getString("text", "");
        String token = "bwallet-secret-" + java.util.UUID.randomUUID().toString();
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                android.content.ClipboardManager cm = (android.content.ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                android.content.ClipData clip = android.content.ClipData.newPlainText(token, text);
                android.os.PersistableBundle extras = new android.os.PersistableBundle();
                extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
                clip.getDescription().setExtras(extras);
                cm.setPrimaryClip(clip);
                JSObject ret = new JSObject();
                ret.put("token", token);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Could not copy");
            }
        });
    }

    @PluginMethod
    public void secretClear(PluginCall call) {
        String token = call.getString("token", "");
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                android.content.ClipboardManager cm = (android.content.ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                android.content.ClipDescription d = cm.getPrimaryClipDescription();
                // Null when another app copied since, or when Android hides the clipboard from a backgrounded app.
                if (token != null && !token.isEmpty() && d != null && d.getLabel() != null && token.contentEquals(d.getLabel())) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) cm.clearPrimaryClip();
                    else cm.setPrimaryClip(android.content.ClipData.newPlainText("", ""));
                }
            } catch (Exception ignored) {
                // Best effort: nothing to report.
            }
            call.resolve();
        });
    }

    /** bWallet calls: loudspeaker on/off for WebRTC audio (src/mobile/calls/media.ts). */
    @PluginMethod
    public void audioSetSpeaker(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) {
            call.reject("Audio unavailable");
            return;
        }
        am.setMode(on ? AudioManager.MODE_IN_COMMUNICATION : AudioManager.MODE_NORMAL);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+: route communication audio to the built-in speaker (setSpeakerphoneOn is deprecated).
            if (on) {
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                        am.setCommunicationDevice(d);
                        break;
                    }
                }
            } else {
                am.clearCommunicationDevice();
            }
        } else {
            setSpeakerphoneLegacy(am, on);
        }
        call.resolve();
    }

    @SuppressWarnings("deprecation")
    private static void setSpeakerphoneLegacy(AudioManager am, boolean on) {
        am.setSpeakerphoneOn(on);
    }
}
