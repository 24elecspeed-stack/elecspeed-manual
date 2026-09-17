package com.elecspeed.manual;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.*;

/**
 * 화면 꾸미기 도우미.
 *
 * 이 프로젝트는 aapt로 매니페스트와 assets만 패키징합니다(build.ps1에 -S res가 없음).
 * 그래서 styles.xml / drawable xml을 쓸 수 없고, 색과 모양을 전부 코드로 만들어야 합니다.
 * 색과 모양은 전기블로그 클립보드 앱과 똑같이 맞췄습니다 — 남색 + 노란색, 둥근 카드, 번호 배지.
 */
public final class Ui {
    public static final int NAVY       = Color.parseColor("#16233A");
    public static final int NAVY_DARK  = Color.parseColor("#0D1524");
    public static final int NAVY_LIGHT = Color.parseColor("#243B5E");
    public static final int AMBER      = Color.parseColor("#FFC629");
    public static final int BG         = Color.parseColor("#F1F4F9");
    public static final int SURFACE    = Color.parseColor("#FFFFFF");
    public static final int TINT       = Color.parseColor("#EEF3FB");
    public static final int OUTLINE    = Color.parseColor("#DFE5EE");
    public static final int TEXT       = Color.parseColor("#111827");
    public static final int TEXT_DIM   = Color.parseColor("#5A6679");
    public static final int HINT       = Color.parseColor("#9AA5B4");
    public static final int NOTE_BG    = Color.parseColor("#FFF7E0");
    public static final int NOTE_LINE  = Color.parseColor("#F2DFA6");

    public static int dp(Context c, float value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                c.getResources().getDisplayMetrics()));
    }

    private static GradientDrawable round(int fill, int radiusDp, Context c) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(c, radiusDp));
        return d;
    }

    /** 스크롤 화면 뼈대. 반환값은 내용을 넣을 세로 LinearLayout. */
    public static LinearLayout screen(Activity a) {
        ScrollView scroll = new ScrollView(a);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);
        LinearLayout column = new LinearLayout(a);
        column.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(column);
        a.setContentView(scroll);
        return column;
    }

    /**
     * 맨 위 짙은 남색 헤더.
     * targetSdk 35(Android 15)는 edge-to-edge가 강제라 그냥 두면 제목이 상태표시줄에 가립니다.
     * 그래서 상태표시줄 높이만큼 위쪽 padding을 더해 줍니다.
     */
    public static LinearLayout header(Activity a, LinearLayout parent, String title, String subtitle) {
        final LinearLayout bar = new LinearLayout(a);
        bar.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable(
                GradientDrawable.Orientation.BR_TL, new int[]{NAVY_LIGHT, NAVY, NAVY_DARK});
        bg.setCornerRadii(new float[]{0, 0, 0, 0, dp(a, 26), dp(a, 26), dp(a, 26), dp(a, 26)});
        bar.setBackground(bg);
        final int basePadTop = dp(a, 26);
        bar.setPadding(dp(a, 20), basePadTop, dp(a, 20), dp(a, 22));

        TextView t = new TextView(a);
        t.setText(title);
        t.setTextColor(Color.WHITE);
        t.setTextSize(23);
        t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        bar.addView(t);

        TextView s = new TextView(a);
        s.setText(subtitle);
        s.setTextColor(AMBER);
        s.setTextSize(13);
        bar.addView(s);

        parent.addView(bar, new LinearLayout.LayoutParams(-1, -2));
        bar.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                int top = Build.VERSION.SDK_INT >= 30
                        ? insets.getInsets(WindowInsets.Type.systemBars()).top
                        : insets.getSystemWindowInsetTop();
                v.setPadding(v.getPaddingLeft(), basePadTop + top, v.getPaddingRight(), v.getPaddingBottom());
                return insets;
            }
        });
        bar.requestApplyInsets();
        return bar;
    }

    /** 헤더 안에 넣는 연한 알약 모양 안내 칩. */
    public static TextView chip(Activity a, LinearLayout header, String text) {
        TextView v = new TextView(a);
        v.setText(text);
        v.setTextColor(Color.parseColor("#D8E2F0"));
        v.setTextSize(12);
        GradientDrawable d = round(Color.parseColor("#1FFFFFFF"), 20, a);
        d.setStroke(dp(a, 1), Color.parseColor("#55FFC629"));
        v.setBackground(d);
        v.setPadding(dp(a, 14), dp(a, 7), dp(a, 14), dp(a, 7));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.topMargin = dp(a, 14);
        header.addView(v, lp);
        return v;
    }

    /**
     * 흰 카드. number가 0보다 크면 노란 동그라미 번호 배지를 붙입니다.
     * 반환값은 카드 안에 내용을 계속 넣을 세로 LinearLayout.
     */
    public static LinearLayout card(Activity a, LinearLayout parent, int number, String title) {
        LinearLayout outer = new LinearLayout(a);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setBackground(round(SURFACE, 18, a));
        outer.setElevation(dp(a, 2));
        outer.setPadding(dp(a, 16), dp(a, 16), dp(a, 16), dp(a, 16));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.leftMargin = lp.rightMargin = dp(a, 14);
        lp.topMargin = dp(a, 12);
        parent.addView(outer, lp);

        if (title != null && !title.isEmpty()) {
            LinearLayout row = new LinearLayout(a);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            if (number > 0) {
                TextView badge = new TextView(a);
                badge.setText(String.valueOf(number));
                badge.setGravity(Gravity.CENTER);
                badge.setTextColor(NAVY);
                badge.setTextSize(14);
                badge.setTypeface(badge.getTypeface(), android.graphics.Typeface.BOLD);
                GradientDrawable circle = new GradientDrawable();
                circle.setShape(GradientDrawable.OVAL);
                circle.setColor(AMBER);
                badge.setBackground(circle);
                LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(dp(a, 28), dp(a, 28));
                bl.rightMargin = dp(a, 10);
                row.addView(badge, bl);
            }
            TextView t = new TextView(a);
            t.setText(title);
            t.setTextColor(TEXT);
            t.setTextSize(17);
            t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
            row.addView(t, new LinearLayout.LayoutParams(0, -2, 1f));
            outer.addView(row);
        }
        return outer;
    }

    private static Button baseButton(Activity a, LinearLayout parent, String text, int fill, int textColor, int pressed) {
        Button b = new Button(a);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(15);
        b.setTypeface(b.getTypeface(), android.graphics.Typeface.BOLD);
        b.setTextColor(textColor);
        b.setStateListAnimator(null);
        b.setMinHeight(dp(a, 52));
        b.setMinimumHeight(dp(a, 52));
        b.setPadding(dp(a, 14), dp(a, 12), dp(a, 14), dp(a, 12));
        StateListDrawable sl = new StateListDrawable();
        sl.addState(new int[]{android.R.attr.state_pressed}, round(pressed, 14, a));
        sl.addState(new int[]{-android.R.attr.state_enabled}, round(Color.parseColor("#C9D2DF"), 14, a));
        sl.addState(new int[]{}, round(fill, 14, a));
        b.setBackground(sl);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(a, 8);
        parent.addView(b, lp);
        return b;
    }

    /** 주 동작 — 짙은 남색 */
    public static Button primary(Activity a, LinearLayout parent, String text) {
        return baseButton(a, parent, text, NAVY, Color.WHITE, NAVY_DARK);
    }

    /** 중요 동작 — 노란색 */
    public static Button accent(Activity a, LinearLayout parent, String text) {
        return baseButton(a, parent, text, AMBER, NAVY, Color.parseColor("#E2A600"));
    }

    /** 보조 동작 — 연한 회색 */
    public static Button tonal(Activity a, LinearLayout parent, String text) {
        return baseButton(a, parent, text, TINT, NAVY, Color.parseColor("#D6DFEC"));
    }

    /** 테두리만 있는 버튼 */
    public static Button outlined(Activity a, LinearLayout parent, String text) {
        Button b = baseButton(a, parent, text, SURFACE, NAVY, TINT);
        GradientDrawable normal = round(SURFACE, 14, a);
        normal.setStroke(dp(a, 1.5f), OUTLINE);
        GradientDrawable down = round(TINT, 14, a);
        down.setStroke(dp(a, 1.5f), OUTLINE);
        StateListDrawable sl = new StateListDrawable();
        sl.addState(new int[]{android.R.attr.state_pressed}, down);
        sl.addState(new int[]{}, normal);
        b.setBackground(sl);
        b.setTextSize(14);
        b.setMinHeight(dp(a, 48));
        b.setMinimumHeight(dp(a, 48));
        return b;
    }

    public static TextView hint(Activity a, LinearLayout parent, String text) {
        TextView v = new TextView(a);
        v.setText(text);
        v.setTextSize(12);
        v.setTextColor(TEXT_DIM);
        v.setLineSpacing(dp(a, 3), 1f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(a, 6);
        parent.addView(v, lp);
        return v;
    }

    /** 노란 안내 상자 */
    public static TextView note(Activity a, LinearLayout parent, String text) {
        TextView v = hint(a, parent, text);
        GradientDrawable d = round(NOTE_BG, 12, a);
        d.setStroke(dp(a, 1), NOTE_LINE);
        v.setBackground(d);
        v.setPadding(dp(a, 12), dp(a, 12), dp(a, 12), dp(a, 12));
        ((LinearLayout.LayoutParams) v.getLayoutParams()).topMargin = dp(a, 10);
        return v;
    }

    /** 상태 표시용 알약 */
    public static TextView statusChip(Activity a, LinearLayout parent, String text) {
        TextView v = new TextView(a);
        v.setText(text);
        v.setTextSize(12);
        v.setTextColor(NAVY);
        GradientDrawable d = round(TINT, 20, a);
        d.setStroke(dp(a, 1), OUTLINE);
        v.setBackground(d);
        v.setPadding(dp(a, 14), dp(a, 8), dp(a, 14), dp(a, 8));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.topMargin = dp(a, 8);
        parent.addView(v, lp);
        return v;
    }

    public static TextView fieldLabel(Activity a, LinearLayout parent, String text) {
        TextView v = new TextView(a);
        v.setText(text);
        v.setTextSize(12);
        v.setTextColor(TEXT_DIM);
        v.setTypeface(v.getTypeface(), android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(a, 12);
        parent.addView(v, lp);
        return v;
    }

    /** 입력칸을 둥근 연회색 상자로 */
    public static void styleField(Activity a, EditText e) {
        GradientDrawable d = round(TINT, 12, a);
        d.setStroke(dp(a, 1), OUTLINE);
        e.setBackground(d);
        e.setPadding(dp(a, 14), dp(a, 12), dp(a, 14), dp(a, 12));
        e.setTextSize(15);
        e.setTextColor(TEXT);
        e.setHintTextColor(HINT);
        if (e.getLayoutParams() instanceof LinearLayout.LayoutParams) {
            ((LinearLayout.LayoutParams) e.getLayoutParams()).topMargin = dp(a, 8);
        }
    }

    /** 스피너도 같은 둥근 상자로 */
    public static void styleSpinner(Activity a, Spinner s) {
        GradientDrawable d = round(TINT, 12, a);
        d.setStroke(dp(a, 1), OUTLINE);
        s.setBackground(d);
        s.setPadding(dp(a, 12), dp(a, 10), dp(a, 12), dp(a, 10));
        if (s.getLayoutParams() instanceof LinearLayout.LayoutParams) {
            ((LinearLayout.LayoutParams) s.getLayoutParams()).topMargin = dp(a, 8);
        }
    }

    private Ui() {}
}
