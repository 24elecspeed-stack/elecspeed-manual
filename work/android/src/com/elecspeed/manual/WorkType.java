package com.elecspeed.manual;

/**
 * 작업 종류 목록 — 전기블로그 클립보드 앱(references/app-debug-icon.apk)의 WORK_TYPES를 그대로 가져왔습니다.
 *
 * 화면과 ChatGPT 요청문에는 사람이 읽는 LABELS를 쓰고, 워드프레스 등록에는 SLUGS를 씁니다.
 * 두 배열은 같은 순서로 짝을 이룹니다. SLUGS 값은 전부 예전 버전이 쓰던 case_type 슬러그 중에서
 * 골랐습니다 — 사이트에 없는 슬러그를 새로 만들면 등록할 때
 * "사이트에서 작업 유형을 찾지 못했습니다"로 실패합니다.
 */
public final class WorkType {
    public static final String[] LABELS = {
        "누전 차단기 내려감",
        "메인 차단기 내려감",
        "두꺼비집 안올라감",
        "콘센트 전기 안됨",
        "부분정전",
        "누전 검사",
        "절연저항 검사",
        "전기배선수리",
        "분전반 점검",
        "에어컨 차단기 문제",
        "전열 차단기 문제",
        "누전 수리",
        "차단기 교체",
        "분전반 교체",
        "정전 복구",
        "콘센트 교체",
        "콘센트 증설",
        "스위치 교체",
        "조명 깜빡임",
        "등기구·조명 교체",
        "전등 안켜짐",
        "인덕션 전용선 공사",
        "전기차 충전기 배선",
        "세탁기·건조기 전용선",
        "접지 공사",
        "전기 용량 증설(승압)",
        "콘센트 스파크·타는 냄새",
        "차단기 소리남·발열",
        "전기 안전점검"
    };

    /** LABELS와 같은 순서. 워드프레스 case_type 슬러그. */
    public static final String[] SLUGS = {
        "누전-차단기",
        "누전-차단기",
        "두꺼비집-분전반",
        "콘센트",
        "배선-정전",
        "누전-차단기",
        "누전-차단기",
        "배선-정전",
        "두꺼비집-분전반",
        "누전-차단기",
        "누전-차단기",
        "누전-차단기",
        "누전-차단기",
        "두꺼비집-분전반",
        "배선-정전",
        "콘센트",
        "콘센트",
        "조명-스위치",
        "조명-스위치",
        "조명-스위치",
        "조명-스위치",
        "인덕션회로",
        "EV충전기",
        "전기증설",
        "접지불량",
        "전기증설",
        "콘센트",
        "누전-차단기",
        "배전반점검"
    };

    /** 카테고리를 고르면 작업 종류도 같이 맞춰 주기 위한 기본 위치. */
    public static int defaultIndexFor(String categoryId) {
        if ("preset_2_outlet".equals(categoryId)) return 3;        // 콘센트 전기 안됨
        if ("preset_3_wiring".equals(categoryId)) return 7;        // 전기배선수리
        return 0;                                                  // 1번·4번 → 누전 차단기 내려감
    }

    public static String slugAt(int index) {
        return (index < 0 || index >= SLUGS.length) ? SLUGS[0] : SLUGS[index];
    }

    public static String labelAt(int index) {
        return (index < 0 || index >= LABELS.length) ? LABELS[0] : LABELS[index];
    }

    private WorkType() {}
}
