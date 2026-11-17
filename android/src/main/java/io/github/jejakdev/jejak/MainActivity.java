package io.github.jejakdev.jejak;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Klien tipis Jejak: membuka UI web dari server Jejak yang alamatnya diisi
 * pengguna (akses jaringan + sandi dinyalakan di Pengaturan Jejak desktop).
 */
public class MainActivity extends Activity {
    private static final String PREF = "jejak";
    private static final String KEY_URL = "server";
    private static final int LATAR = Color.parseColor("#172033");
    private static final int TEKS = Color.parseColor("#e6ecf7");
    private static final int LEMBUT = Color.parseColor("#9fb0cc");

    private WebView web;
    private String galat = "";

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        String url = simpanan().getString(KEY_URL, "");
        if (url.isEmpty()) tampilSetup("");
        else bukaServer(url);
    }

    private SharedPreferences simpanan() {
        return getSharedPreferences(PREF, MODE_PRIVATE);
    }

    private static String normal(String s) {
        s = s.trim();
        if (s.isEmpty()) return "";
        if (!s.matches("(?i)^https?://.*")) s = "http://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    private void tampilSetup(String pesan) {
        if (web != null) {
            web.destroy();
            web = null;
        }
        LinearLayout kol = new LinearLayout(this);
        kol.setOrientation(LinearLayout.VERTICAL);
        kol.setGravity(Gravity.CENTER_VERTICAL);
        kol.setBackgroundColor(LATAR);
        kol.setPadding(dp(28), dp(28), dp(28), dp(28));

        TextView judul = new TextView(this);
        judul.setText("Jejak");
        judul.setTextColor(TEKS);
        judul.setTextSize(28);
        kol.addView(judul);

        TextView info = new TextView(this);
        info.setText("Alamat server Jejak, mis. 192.168.1.20:4747. "
            + "Nyalakan akses jaringan dan sandi di Pengaturan Jejak.");
        info.setTextColor(LEMBUT);
        info.setTextSize(14);
        info.setPadding(0, dp(8), 0, dp(16));
        kol.addView(info);

        final EditText isi = new EditText(this);
        isi.setHint("http://192.168.1.20:4747");
        isi.setHintTextColor(LEMBUT);
        isi.setTextColor(TEKS);
        isi.setSingleLine(true);
        isi.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        isi.setText(simpanan().getString(KEY_URL, ""));
        kol.addView(isi);

        if (!pesan.isEmpty()) {
            TextView p = new TextView(this);
            p.setText(pesan);
            p.setTextColor(Color.parseColor("#ff8a8a"));
            p.setTextSize(13);
            p.setPadding(0, dp(12), 0, 0);
            kol.addView(p);
        }

        Button sambung = new Button(this);
        sambung.setText("Sambung");
        sambung.setOnClickListener(v -> {
            String url = normal(isi.getText().toString());
            if (url.isEmpty()) return;
            simpanan().edit().putString(KEY_URL, url).apply();
            bukaServer(url);
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        kol.addView(sambung, lp);

        setContentView(kol);
    }

    private void bukaServer(final String url) {
        galat = "";
        web = new WebView(this);
        web.setBackgroundColor(LATAR);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        final String host = Uri.parse(url).getHost();
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (host != null && host.equalsIgnoreCase(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) {
                    galat = "Tidak bisa terhubung ke " + url + " (" + e.getDescription() + ").";
                    runOnUiThread(() -> tampilSetup(galat));
                }
            }
        });
        setContentView(web);
        web.loadUrl(url);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        if (web == null) {
            finish();
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle("Jejak")
            .setItems(new String[] {"Ubah server", "Keluar"}, (d, i) -> {
                if (i == 0) tampilSetup("");
                else finish();
            })
            .setNegativeButton("Batal", null)
            .show();
    }
}
