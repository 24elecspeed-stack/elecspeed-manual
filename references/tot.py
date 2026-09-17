# -*- coding: utf-8 -*-
"""
24시 긴급 전기수리 - 전기수리 사례(electric_case) 자동 등록 버전

핵심 변경:
1) 일반 글(posts)이 아니라 전기수리 사례(electric_case)에 등록
2) 임시저장 상태(draft)로 등록
3) ACF 필드 district / dong / symptom / cause / service도 함께 저장
4) Gemini 없이 TXT 완성 본문 사용
5) API 키와 WP 앱 비밀번호는 환경변수에서 읽음
"""

import os
import json
import random
import re
import time
from pathlib import Path
import requests

# =========================================================
# 1. 기본 설정
# =========================================================

import os
import json
import random
import re
import time
import html
import functools
import requests
from datetime import datetime, timedelta
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont, ImageOps

WP_URL = "https://24elecspeed.com"
WP_USER = "mymanowar"

# ★ 여기 두 곳에 직접 입력
WP_APP_PASSWORD = "".replace(" ", "").strip()

PHONE_NUMBER = "0507-1417-8239"

POST_STATUS = "draft"
ELECTRIC_CASE_ENDPOINT = f"{WP_URL}/wp-json/wp/v2/electric_case"

# =========================================================
# 본문 문단(<p>) 공통 스타일
# -----------------------------------------------------------
# 새 글을 만들 때(랜덤조합/MANUAL_300 둘 다)와, 이미 등록된 글을
# 고치는 FIX_READABILITY_ALL 모드가 이 값 하나를 함께 씁니다.
# 여기 숫자만 바꾸면 새 글/기존 글 전부 같은 스타일로 맞춰집니다.
# =========================================================
BODY_PARAGRAPH_STYLE = (
    "margin:0 0 32px 0; padding:0; color:#1c2128; "
    "line-height:1.9; font-size:clamp(16px,4.2vw,18px); "
    "letter-spacing:-0.2px; word-break:keep-all; "
    "overflow-wrap:break-word;"
)

# =========================================================
# 예약 발행 설정 (하루 N개, 랜덤 시각으로 순차 공개)
# -----------------------------------------------------------
# 실제 "공개(publish)" 전환은 워드프레스가 예약 시각에 자체적으로
# 처리합니다(WP-Cron). 이 스크립트는 예약 시각만 찍어서 한 번에
# 등록하고 바로 종료하므로, PC를 계속 켜둘 필요가 없습니다.
# 네이버 서치어드바이저 자동 제출도 워드프레스 쪽 PHP 스니펫이
# 글이 실제 공개되는 순간 처리합니다.
#
# 지역 진행 방식: 서울 25개 구를 SEOUL_DATA에 적힌 순서 그대로 전부
# 다 채우기 전에는 경기 지역으로 넘어가지 않습니다(랜덤으로 섞지
# 않고 순차 진행). 어디까지 등록했는지는 location_progress.json에
# 저장되어, 다음 날 실행할 때 자동으로 그다음 동부터 이어집니다.
# =========================================================
POSTS_PER_DAY = 1  # 하루에 등록할 개수(고정)

# 예약 발행 시각을 뽑을 하루 시간대(24시간 표기). 이 범위 안에서
# 무작위 시각을 POSTS_PER_DAY개 뽑아 오름차순으로 정렬해 사용합니다.
DAILY_PUBLISH_WINDOW_START_HOUR = 8
DAILY_PUBLISH_WINDOW_END_HOUR = 23

# 모든 배너 뒤에 사용할 공통 배경 이미지
BANNER_IMAGE_URLS = [
    "https://24elecspeed.com/wp-content/uploads/2026/08/ChatGPT-Image-2026년-8월-19일-오후-12_41_19-3.png",
    "https://24elecspeed.com/wp-content/uploads/2026/08/ChatGPT-Image-2026년-8월-19일-오후-12_41_19-2.png",
]


@functools.lru_cache(maxsize=4)
def resolve_default_featured_media_id(auth, wp_url=WP_URL):
    """
    BANNER_IMAGE_URLS 중 워드프레스 미디어 라이브러리에 이미 올라가 있는
    이미지 하나를 찾아 그 미디어 ID를 반환합니다. (대표이미지/og:image로
    쓸 공통 배너 이미지)

    미디어를 오래된 순(id 오름차순)으로 페이지를 넘기며 source_url이
    정확히 일치하는 항목을 찾습니다. 찾지 못하면 None을 반환합니다.
    (같은 auth로는 한 번만 조회하고 이후에는 캐시된 값을 재사용합니다.)
    """
    media_endpoint = f"{wp_url}/wp-json/wp/v2/media"
    target_urls = set(BANNER_IMAGE_URLS)

    page = 1
    per_page = 100
    max_pages = 10
    total_scanned = 0

    while page <= max_pages:
        try:
            response = requests.get(
                media_endpoint,
                params={
                    "per_page": per_page,
                    "page": page,
                    "orderby": "id",
                    "order": "asc",
                    "_fields": "id,source_url",
                },
                auth=auth,
                timeout=30,
            )
        except requests.RequestException as e:
            print(f"⚠️ 기본 대표이미지 조회 중 오류: {e}")
            break

        if response.status_code != 200:
            break

        items = response.json()
        if not items:
            break

        total_scanned += len(items)
        for item in items:
            if item.get("source_url") in target_urls:
                return item.get("id")

        page += 1

    print(f"⚠️ 기본 대표이미지(BANNER_IMAGE_URLS)를 미디어 라이브러리에서 찾지 못했습니다 "
          f"(미디어 {total_scanned}개 확인함). 대표이미지 없이 등록됩니다.")
    return None


# =========================================================
# 1-1. 글마다 다른 대표이미지(썸네일) 자동 생성
# ---------------------------------------------------------
# 배너 이미지 2장을 수백 개 글이 나눠 쓰다 보니, 검색엔진이 이걸
# "글마다 고유한 사진"이 아니라 "사이트 공통 로고"로 판단해서
# 검색결과 썸네일에서 제외하는 문제가 있었습니다. 배경 사진 위에
# "구 동 + 제목 + 전화번호"를 매번 다르게 얹은 썸네일을 새로 만들어
# 대표이미지로 등록해서, 글마다 진짜 다른 이미지가 되게 합니다.
#
# - 디자인: 마스코트 캐릭터(사이트 로고 원본에서 잘라옴) + 지역명
#   큰 글씨 + 전화번호. 방금 확정한 사이트 기본 로고와 같은 스타일
#   이라 브랜드 일관성이 있고, 지역명이 글마다 달라서 이미지도
#   매번 달라집니다.
# - 크기: 1200x630 (og:image 표준 권장 비율)
# - 생성/업로드 중 어디서든 실패하면 기존 공통 배너 이미지로
#   자동 대체됩니다(글 등록 자체가 실패하지 않도록).
# =========================================================

TITLE_CARD_FONT_BLACK = "/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc"
TITLE_CARD_FONT_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
TITLE_CARD_WIDTH = 1200
TITLE_CARD_HEIGHT = 630
TITLE_CARD_MAX_KB = 250  # 이미지 1장당 목표 최대 용량(KB)

# 캐릭터를 잘라올 원본 로고 이미지 (사이트에 이미 올라가 있는 그 마스코트)
CHARACTER_SOURCE_URL = "https://24elecspeed.com/wp-content/uploads/2026/08/ChatGPT-Image-2026년-8월-19일-오후-12_37_52.png"
CHARACTER_CROP_BOX = (150, 30, 1100, 650)  # 원본에서 캐릭터 부분만 잘라내는 좌표


def _fit_text_lines(draw, text, font, max_width):
    """긴 문구를 max_width 안에 맞게 여러 줄로 자동 줄바꿈합니다."""
    words = text.split(" ")
    lines = []
    current = ""
    for word in words:
        trial = (current + " " + word).strip()
        if draw.textlength(trial, font=font) <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def _save_png_under_size(image, out_path, target_kb=TITLE_CARD_MAX_KB):
    """
    PNG로 저장합니다(로고 스타일이라 사진처럼 손실압축할 필요가
    적어서 PNG 유지). 용량이 너무 크면 JPEG로 대체 저장하고,
    실제로 저장된 경로(확장자 포함)를 반환합니다.
    """
    image.save(out_path, "PNG", optimize=True)
    size_kb = out_path.stat().st_size / 1024
    if size_kb <= target_kb:
        return out_path

    jpeg_path = out_path.with_suffix(".jpg")
    image.convert("RGB").save(jpeg_path, "JPEG", quality=85, optimize=True)
    out_path.unlink(missing_ok=True)
    return jpeg_path


@functools.lru_cache(maxsize=1)
def _get_character_crop():
    """
    마스코트 캐릭터 원본 이미지를 다운로드해서 캐릭터 부분만
    잘라 반환합니다(글마다 새로 안 받고 한 번만 받아 캐시).
    실패하면 None을 반환합니다.
    """
    try:
        response = requests.get(CHARACTER_SOURCE_URL, timeout=30)
        response.raise_for_status()
        src = Image.open(BytesIO(response.content)).convert("RGBA")
        return src.crop(CHARACTER_CROP_BOX)
    except Exception as e:
        print(f"⚠️ 캐릭터 원본 이미지 다운로드 실패: {e}")
        return None


def generate_title_card_image(gu, dong, title, out_path):
    """
    마스코트 캐릭터 + "구 동" 큰 글씨 + 전화번호를 얹은 1200x630
    가로형 이미지를 만들어 out_path에 저장합니다. (사이트 기본
    로고와 같은 스타일 — 지역명만 매번 바뀝니다.) 캐릭터 다운로드나
    폰트 준비에 실패하면 None을 반환합니다.
    """
    char_crop = _get_character_crop()
    if char_crop is None:
        return None

    W, H = TITLE_CARD_WIDTH, TITLE_CARD_HEIGHT
    canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255))

    char_w, char_h = char_crop.size
    target_h = 480
    target_w = int(char_w * (target_h / char_h))
    char_resized = char_crop.resize((target_w, target_h), Image.LANCZOS)
    canvas.paste(char_resized, (-30, 75), char_resized)

    draw = ImageDraw.Draw(canvas)

    try:
        font_region = ImageFont.truetype(TITLE_CARD_FONT_BLACK, 58)
        font_phone = ImageFont.truetype(TITLE_CARD_FONT_BLACK, 40)
        font_sub = ImageFont.truetype(TITLE_CARD_FONT_BOLD, 26)
    except OSError as e:
        print(f"⚠️ 폰트를 찾을 수 없습니다({TITLE_CARD_FONT_BLACK}): {e}")
        return None

    text_x = target_w - 90
    max_text_width = W - text_x - 40

    # 지역명(구 동) — 가장 크게, 최대 2줄
    region_text = f"{gu} {dong}"
    region_lines = _fit_text_lines(draw, region_text, font_region, max_text_width)[:2]
    y = 95
    for line in region_lines:
        draw.text((text_x, y), line, font=font_region, fill=(15, 30, 60, 255))
        y += 70

    # 전화번호 알약 배지
    phone_str_w = draw.textlength(PHONE_NUMBER, font=font_phone)
    pad_x = 30
    pill_w = int(phone_str_w) + pad_x * 2
    pill_h = 76
    pill_y = y + 20
    draw.rounded_rectangle(
        [text_x, pill_y, text_x + pill_w, pill_y + pill_h],
        radius=pill_h // 2,
        fill=(15, 30, 60, 255),
    )
    phone_bbox = draw.textbbox((0, 0), PHONE_NUMBER, font=font_phone)
    phone_h = phone_bbox[3] - phone_bbox[1]
    draw.text(
        (text_x + pad_x, pill_y + (pill_h - phone_h) // 2 - phone_bbox[1]),
        PHONE_NUMBER, font=font_phone, fill=(255, 200, 0, 255),
    )

    # 서브 텍스트
    sub_y = pill_y + pill_h + 35
    draw.text((text_x, sub_y), "서울·경기 24시간 출동", font=font_sub, fill=(90, 100, 115, 255))
    draw.text((text_x, sub_y + 42), "누전수리 · 차단기 · 전기배선", font=font_sub, fill=(90, 100, 115, 255))

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    return _save_png_under_size(canvas.convert("RGB"), out_path)


def upload_generated_image_to_wp(local_path, auth, wp_url=WP_URL):
    """
    로컬 이미지 파일을 워드프레스 미디어 라이브러리에 업로드하고
    (URL, 미디어ID)를 반환합니다. 실패하면 (None, None)을 반환합니다.
    """
    local_path = Path(local_path)
    media_endpoint = f"{wp_url}/wp-json/wp/v2/media"

    try:
        file_data = local_path.read_bytes()
        content_type = "image/png" if local_path.suffix.lower() == ".png" else "image/jpeg"
        headers = {
            "Content-Disposition": f'attachment; filename="{local_path.name}"',
            "Content-Type": content_type,
        }
        response = requests.post(
            media_endpoint,
            headers=headers,
            data=file_data,
            auth=auth,
            timeout=60,
        )
        if response.status_code in (200, 201):
            result = response.json()
            return result.get("source_url"), result.get("id")

        print(f"❌ 썸네일 업로드 실패 ({response.status_code}): {local_path.name}")
        print(response.text[:500])
        return None, None

    except (requests.RequestException, OSError) as e:
        print(f"❌ 썸네일 업로드 중 오류: {e}")
        return None, None


def build_unique_featured_media_id(gu, dong, title, auth):
    """
    이 글만의 고유한 대표이미지를 만들어 업로드하고 미디어ID를
    반환합니다. 생성/업로드 중 어디서든 실패하면 공통 배너
    이미지(resolve_default_featured_media_id)로 대신합니다.
    """
    tmp_dir = Path(__file__).with_name("thumbnail_tmp")
    tmp_dir.mkdir(exist_ok=True)
    out_path = tmp_dir / f"thumb_{int(time.time())}_{random.randint(1000, 9999)}.png"

    image_path = generate_title_card_image(gu, dong, title, out_path)

    if image_path:
        source_url, media_id = upload_generated_image_to_wp(image_path, auth)
        try:
            image_path.unlink()
        except OSError:
            pass
        if media_id:
            print(f"✅ 고유 썸네일 생성/업로드 성공 (미디어ID {media_id}): {source_url}")
            return media_id
        print("⚠️ 생성한 썸네일 업로드 실패 — 기본 배너 이미지로 대체합니다.")
    else:
        print("⚠️ 썸네일 생성 실패(배경/폰트 문제) — 기본 배너 이미지로 대체합니다.")

    fallback_id = resolve_default_featured_media_id(auth)
    if fallback_id:
        print(f"✅ 기본 배너 이미지로 대체함 (미디어ID {fallback_id})")
    else:
        print("❌ 기본 배너 이미지도 못 찾아서 대표이미지 없이 등록됩니다.")
    return fallback_id



# =========================================================
# 2. 지역 데이터
# =========================================================

SEOUL_DATA = {
    "강남구": ["개포동", "논현동", "대치동", "도곡동", "삼성동", "세곡동", "수서동", "신사동", "압구정동", "역삼동", "율현동", "일원동", "자곡동", "청담동"],
    "강동구": ["강일동", "고덕동", "길동", "둔촌동", "명일동", "상일동", "성내동", "암사동", "천호동"],
    "강북구": ["미아동", "번동", "수유동", "우이동"],
    "강서구": ["가양동", "개화동", "공항동", "등촌동", "마곡동", "방화동", "염창동", "화곡동"],
    "관악구": ["남현동", "봉천동", "신림동"],
    "광진구": ["광장동", "구의동", "군자동", "자양동", "중곡동", "화양동"],
    "구로구": ["개봉동", "고척동", "구로동", "신도림동", "오류동"],
    "금천구": ["가산동", "독산동", "시흥동"],
    "노원구": ["공릉동", "상계동", "월계동", "중계동", "하계동"],
    "도봉구": ["도봉동", "방학동", "쌍문동", "창동"],
    "동대문구": ["답십리동", "신설동", "용두동", "이문동", "장안동", "전농동", "제기동", "청량리동"],
    "동작구": ["노량진동", "대방동", "사당동", "상도동", "흑석동"],
    "마포구": ["공덕동", "망원동", "상암동", "서교동", "성산동", "연남동", "합정동"],
    "서대문구": ["남가좌동", "북가좌동", "신촌동", "연희동", "홍은동", "홍제동"],
    "서초구": ["내곡동", "반포동", "방배동", "서초동", "양재동", "잠원동"],
    "성동구": ["금호동", "마장동", "성수동", "옥수동", "행당동"],
    "성북구": ["길음동", "돈암동", "동선동", "보문동", "삼선동", "안암동", "정릉동"],
    "송파구": ["가락동", "거여동", "마천동", "문정동", "방이동", "삼전동", "석촌동", "잠실동"],
    "양천구": ["목동", "신월동", "신정동"],
    "영등포구": ["당산동", "대림동", "문래동", "신길동", "여의도동", "영등포동"],
    "용산구": ["한남동", "이태원동", "이촌동", "원효로동", "청파동", "후암동"],
    "은평구": ["갈현동", "구산동", "대조동", "불광동", "수색동", "응암동", "진관동"],
    "종로구": ["혜화동", "평창동", "삼청동", "명륜동", "부암동"],
    "중구": ["신당동", "을지로", "충무로", "황학동", "회현동"],
    "중랑구": ["망우동", "면목동", "묵동", "신내동", "중화동"],
}

# 경기도 31개 시·군 전체를 반영 (구가 있는 대도시는 구 단위로, 나머지는 시 단위로)
GYEONGGI_DATA = {
    "수원시 장안구": ["정자동", "율천동", "천천동", "송죽동"],
    "수원시 권선구": ["권선동", "곡선동", "세류동", "금곡동", "호매실동"],
    "수원시 팔달구": ["인계동", "매교동", "지동", "우만동"],
    "수원시 영통구": ["영통동", "매탄동", "망포동", "원천동"],
    "성남시 수정구": ["신흥동", "태평동", "단대동", "산성동"],
    "성남시 중원구": ["성남동", "중앙동", "금광동", "상대원동"],
    "성남시 분당구": ["서현동", "정자동", "야탑동", "이매동", "판교동"],
    "고양시 덕양구": ["행신동", "화정동", "능곡동", "원신동", "삼송동"],
    "고양시 일산동구": ["장항동", "백석동", "마두동", "식사동"],
    "고양시 일산서구": ["주엽동", "대화동", "탄현동", "가좌동"],
    "용인시 처인구": ["김량장동", "역북동", "포곡읍", "모현읍"],
    "용인시 기흥구": ["구갈동", "신갈동", "보정동", "동백동"],
    "용인시 수지구": ["풍덕천동", "죽전동", "동천동", "상현동"],
    "부천시": ["중동", "상동", "심곡동", "송내동", "오정동", "약대동"],
    "안양시 만안구": ["안양동", "박달동", "석수동"],
    "안양시 동안구": ["평촌동", "비산동", "관양동", "호계동"],
    "안산시 상록구": ["사동", "본오동", "월피동", "성포동"],
    "안산시 단원구": ["고잔동", "원곡동", "초지동", "선부동"],
    "화성시": ["병점동", "동탄동", "봉담읍", "향남읍", "남양읍"],
    "평택시": ["비전동", "송탄동", "안중읍", "포승읍", "지제동"],
    "의정부시": ["의정부동", "호원동", "장암동", "신곡동", "민락동"],
    "시흥시": ["정왕동", "대야동", "은행동", "신천동", "배곧동"],
    "파주시": ["금촌동", "운정동", "문산읍", "조리읍"],
    "김포시": ["사우동", "장기동", "구래동", "풍무동", "고촌읍"],
    "광명시": ["철산동", "하안동", "광명동", "소하동"],
    "광주시": ["경안동", "송정동", "오포읍", "곤지암읍"],
    "군포시": ["산본동", "당동", "당정동", "금정동"],
    "이천시": ["창전동", "중리동", "부발읍", "신둔면"],
    "양주시": ["옥정동", "회천동", "덕정동", "은현면"],
    "오산시": ["오산동", "세마동", "원동", "궐동"],
    "구리시": ["인창동", "수택동", "갈매동", "교문동"],
    "안성시": ["봉산동", "동본동", "공도읍", "죽산면"],
    "포천시": ["신읍동", "선단동", "소흘읍", "일동면"],
    "의왕시": ["고천동", "오전동", "내손동", "포일동"],
    "하남시": ["신장동", "덕풍동", "미사동", "풍산동"],
    "여주시": ["여흥동", "중앙동", "가남읍", "점동면"],
    "동두천시": ["생연동", "보산동", "송내동"],
    "과천시": ["별양동", "중앙동", "부림동"],
    "양평군": ["양평읍", "옥천면", "강상면"],
    "가평군": ["가평읍", "청평면", "설악면"],
    "연천군": ["연천읍", "전곡읍", "청산면"],
}

WORK_TYPES = [
    "차단기 내려감 누전 수리 및 원인 점검",
    "분전반(두꺼비집) 탄화 및 탄 냄새 교체 수리",
    "특정 콘센트 쇼트 및 차단기 떨어짐 점검",
    "노후 누전차단기 교체 및 전열 회로 수리",
    "조명 및 스위치 고장 점검 및 교체",
    "배선 노후로 인한 부분 정전 점검",
    "전기 증설 및 승압 공사 상담",
    "접지 불량 및 감전 위험 점검",
    "멀티탭·연장선 과부하 및 발열 점검",
    "계량기·인입선 이상 및 전기 공급 점검",
    "인터폰·초인종 고장 점검 및 수리",
    "화재감지기·경보기 오작동 점검",
    "옥상·외부 전기설비 누전 점검",
    "승강기 전기설비 점검",
    "냉난방기 전용 회로 신설 공사",
    "주차장 조명·전기설비 점검",
    "상가 간판 전기공사 및 점검",
    "태양광 연계 전기설비 점검",
    "비상발전기 연계 전기점검",
    "옥내 배전반 정기 안전점검",
    "전기온수기 전용 배선 점검",
    "인덕션·전기레인지 전용 회로 신설",
    "전기자동차 충전기 설치 상담",
    "옥외 전등·가로등 고장 점검",
    "창고·공장 전기설비 정기점검",
    "화장실·욕실 방수 콘센트 설치",
    "실내 배선 매립 공사 상담",
    "스마트홈 전기배선 연동 공사",
    "지하실·반지하 전기설비 습기 점검",
    "신축·인테리어 전기 공사 총괄 상담",
]

# 매일 서울/경기 각 동(洞)에 무작위로 배정되는 작업유형 중, "비상발전기
# 연계 점검"처럼 일반 가정 동네 이야기와 안 어울리는(발전기는
# 보통 정전이 잦은 지방·산간 지역이나 특수 시설에서 쓰는 설비라,
# "OO구 OO동"식 도심 글과 짝지어지면 어색함) 항목과, 아파트·빌라·
# 다가구주택 등 "주거용" 개별 세대 전기수리와 무관한(승강기·주차장·
# 태양광·가로등·EV충전기·스마트홈은 건물 공용설비이거나 신규 설비
# 설치 상담이라 "누전수리·전기수리·차단기수리" 위주로 가야 하는
# 방향과 맞지 않음) 상가·공장·공용설비 관련 항목은 실제 글 생성 시
# 무작위 선택 대상에서 제외합니다. WORK_TYPES 리스트 자체는 그대로
# 두고(다른 딕셔너리들이 인덱스로 참조하고 있어서 순서를 바꾸면
# 안 됨) 뽑을 때만 걸러냅니다.
GEN_EXCLUDED_FROM_RANDOM_PICK = [
    "비상발전기 연계 전기점검",
    "인터폰·초인종 고장 점검 및 수리",
    "화재감지기·경보기 오작동 점검",
    "상가 간판 전기공사 및 점검",
    "창고·공장 전기설비 정기점검",
    "승강기 전기설비 점검",
    "주차장 조명·전기설비 점검",
    "태양광 연계 전기설비 점검",
    "옥외 전등·가로등 고장 점검",
    "전기자동차 충전기 설치 상담",
    "스마트홈 전기배선 연동 공사",
]

WORK_TYPES_FOR_RANDOM_PICK = [
    w for w in WORK_TYPES if w not in GEN_EXCLUDED_FROM_RANDOM_PICK
]

# ★ work_type을 뽑을 때 "차단기 내려감·누전수리·콘센트수리·전기수리"
# 핵심 4개 유형이 훨씬 자주 나오도록 가중치를 줍니다. 예전에는
# WORK_TYPES_FOR_RANDOM_PICK 안의 19개 유형이 전부 똑같은 확률(1/19)
# 로 뽑혀서, 실제로 원하는 "차단기/누전/콘센트 전기수리" 글보다
# 온수기·인덕션·신축상담 같은 부수적인 유형이 더 많이 나오는
# 문제가 있었습니다. 아래 가중치를 적용하면 핵심 4개 유형이
# 전체의 약 80%를 차지하고, 나머지 15개 유형이 남은 20%를
# 나눠 갖습니다.
GEN_WORKTYPE_CORE_KEYWORDS = [
    WORK_TYPES[0],  # 차단기 내려감 누전 수리 및 원인 점검
    WORK_TYPES[1],  # 분전반(두꺼비집) 탄화 및 탄 냄새 교체 수리
    WORK_TYPES[2],  # 특정 콘센트 쇼트 및 차단기 떨어짐 점검
    WORK_TYPES[3],  # 노후 누전차단기 교체 및 전열 회로 수리
]

GEN_WORKTYPE_CORE_TOTAL_WEIGHT = 0.8  # 핵심 4개 유형이 차지할 총 비중


def pick_weighted_work_type():
    """
    WORK_TYPES_FOR_RANDOM_PICK 중에서, 핵심 4개 유형(차단기 내려감/
    분전반 탄화/콘센트 쇼트/노후 누전차단기)이 전체의 약 80%를
    차지하도록 가중치를 줘서 하나를 뽑습니다. 나머지 유형들은
    남은 20%를 균등하게 나눠 갖습니다.
    """
    core = [w for w in GEN_WORKTYPE_CORE_KEYWORDS if w in WORK_TYPES_FOR_RANDOM_PICK]
    others = [w for w in WORK_TYPES_FOR_RANDOM_PICK if w not in core]

    if not core:
        return random.choice(WORK_TYPES_FOR_RANDOM_PICK)

    core_weight_each = GEN_WORKTYPE_CORE_TOTAL_WEIGHT / len(core)
    other_weight_each = (
        (1 - GEN_WORKTYPE_CORE_TOTAL_WEIGHT) / len(others) if others else 0
    )

    population = core + others
    weights = [core_weight_each] * len(core) + [other_weight_each] * len(others)

    return random.choices(population, weights=weights, k=1)[0]


# =========================================================
# 3. 작업유형(case_type) 매핑
# =========================================================
# 최종 URL 구조:
# /누전-차단기/글-슬러그/
#
# case_type 용어는 워드프레스에서 사용하는 실제 taxonomy slug입니다.
CASE_TYPE_MAP = {
    "차단기 내려감 누전 수리 및 원인 점검": "누전-차단기",
    "분전반(두꺼비집) 탄화 및 탄 냄새 교체 수리": "두꺼비집-분전반",
    "특정 콘센트 쇼트 및 차단기 떨어짐 점검": "콘센트",
    "노후 누전차단기 교체 및 전열 회로 수리": "누전-차단기",
    "조명 및 스위치 고장 점검 및 교체": "조명-스위치",
    "배선 노후로 인한 부분 정전 점검": "배선-정전",
    "전기 증설 및 승압 공사 상담": "전기증설",
    "접지 불량 및 감전 위험 점검": "접지불량",
    "멀티탭·연장선 과부하 및 발열 점검": "멀티탭",
    "계량기·인입선 이상 및 전기 공급 점검": "계량기-인입선",
    "인터폰·초인종 고장 점검 및 수리": "인터폰",
    "화재감지기·경보기 오작동 점검": "화재감지기",
    "옥상·외부 전기설비 누전 점검": "옥상전기설비",
    "승강기 전기설비 점검": "승강기전기",
    "냉난방기 전용 회로 신설 공사": "냉난방전용회로",
    "주차장 조명·전기설비 점검": "주차장전기",
    "상가 간판 전기공사 및 점검": "간판전기",
    "태양광 연계 전기설비 점검": "태양광전기",
    "비상발전기 연계 전기점검": "비상발전기",
    "옥내 배전반 정기 안전점검": "배전반점검",
    "전기온수기 전용 배선 점검": "온수기배선",
    "인덕션·전기레인지 전용 회로 신설": "인덕션회로",
    "전기자동차 충전기 설치 상담": "EV충전기",
    "옥외 전등·가로등 고장 점검": "가로등전기",
    "창고·공장 전기설비 정기점검": "공장전기점검",
    "화장실·욕실 방수 콘센트 설치": "방수콘센트",
    "실내 배선 매립 공사 상담": "배선매립공사",
    "스마트홈 전기배선 연동 공사": "스마트홈배선",
    "지하실·반지하 전기설비 습기 점검": "지하습기전기",
    "신축·인테리어 전기 공사 총괄 상담": "신축인테리어전기",
}


# =========================================================
# 3. 작업 유형 → ACF 값
# ---------------------------------------------------------
# "조명" in work_type 같은 부분 문자열 매칭은 유형이 늘어나면서
# "주차장 조명·전기설비 점검"처럼 서로 다른 유형에 같은 단어가
# 겹치면 잘못 매칭될 위험이 있어, WORK_TYPES 문자열 전체를
# key로 쓰는 정확한 매칭 딕셔너리로 작성합니다.
# =========================================================

ACF_FIELDS_BY_WORK_TYPE = {
    WORK_TYPES[0]: ("차단기가 내려가며 전기가 끊기는 증상", "누전 및 연결 전기회로 이상 여부 점검", "누전 점검 및 전기회로 수리"),
    WORK_TYPES[1]: ("분전반 탄 냄새 및 두꺼비집 이상", "분전반 내부 노후화 및 전선 접속부 이상 가능성 점검", "분전반 점검 및 필요 부위 교체 수리"),
    WORK_TYPES[2]: ("특정 콘센트 사용 시 차단기 내려감", "콘센트 및 연결 회로의 쇼트·누전 여부 점검", "콘센트 및 전기회로 점검·수리"),
    WORK_TYPES[3]: ("노후 누전차단기 반복 작동", "차단기 노후화 및 연결 전열 회로 이상 여부 점검", "누전차단기 점검 및 교체 수리"),
    WORK_TYPES[4]: ("조명이 켜지지 않거나 스위치 조작이 안 되는 증상", "조명기구, 스위치 접점, 연결 배선의 고장 여부 점검", "조명·스위치 점검 및 필요 부위 교체"),
    WORK_TYPES[5]: ("특정 공간이나 회로만 반복적으로 정전되는 증상", "노후 배선의 접속 불량 및 절연 상태 점검", "배선 상태 점검 및 필요 구간 교체"),
    WORK_TYPES[6]: ("기존 계약전력으로 필요한 전력을 감당하지 못하는 상황", "현재 계약전력, 배선 용량, 분전반 여유 용량 검토", "전기 증설·승압 상담 및 필요 공사 안내"),
    WORK_TYPES[7]: ("접지 불량으로 인한 감전 위험 또는 기기 오작동 의심 증상", "접지선 연결 상태 및 접지저항 값 점검", "접지 상태 점검 및 필요 시 접지 보강 공사"),
    WORK_TYPES[8]: ("멀티탭이나 연장선 사용 중 발열·과열이 느껴지는 증상", "멀티탭 정격 용량 초과 및 접속부 노후 여부 점검", "멀티탭·연장선 점검 및 배선 분리 안내"),
    WORK_TYPES[9]: ("계량기 주변 이상이나 인입선 관련 전기 공급 문제", "계량기 연결 상태 및 인입선 손상 여부 점검", "계량기·인입선 점검 및 필요 시 한전 연계 안내"),
    WORK_TYPES[10]: ("인터폰·초인종이 작동하지 않거나 화면·음성에 이상이 있는 증상", "인터폰 단자함 배선 및 전원 공급 상태 점검", "인터폰·초인종 점검 및 필요 부위 교체"),
    WORK_TYPES[11]: ("화재감지기·경보기가 오작동하거나 반응이 없는 증상", "감지기 센서 및 연결 배선, 전원 상태 점검", "화재감지기·경보기 점검 및 필요 부위 교체"),
    WORK_TYPES[12]: ("옥상이나 외부에 설치된 전기설비에서 누전이 의심되는 증상", "외부 노출 배선·설비의 방수 상태 및 절연 성능 점검", "옥상·외부 전기설비 점검 및 필요 보강 공사"),
    WORK_TYPES[13]: ("승강기 관련 전기설비에서 이상이 의심되는 증상", "승강기 전원 공급 배선 및 접속 상태 점검", "승강기 전기설비 점검 및 필요 부위 정비 안내"),
    WORK_TYPES[14]: ("냉난방기 전용 회로가 없어 기존 회로에 부하가 몰리는 상황", "냉난방기 소비전력과 기존 회로 용량의 적합성 검토", "냉난방기 전용 회로 신설 상담 및 공사 안내"),
    WORK_TYPES[15]: ("주차장 조명이나 전기설비에서 이상이 나타나는 증상", "주차장 배선의 노후·습기 영향 및 접속 상태 점검", "주차장 조명·전기설비 점검 및 필요 부위 교체"),
    WORK_TYPES[16]: ("상가 간판 조명이 켜지지 않거나 깜빡이는 증상", "간판 전용 배선 및 안정기·전원 공급 상태 점검", "간판 전기공사 점검 및 필요 부위 교체"),
    WORK_TYPES[17]: ("태양광 설비 연계 부분에서 전기 이상이 의심되는 증상", "태양광 연계 배선 및 인버터 주변 전기설비 상태 점검", "태양광 연계 전기설비 점검 및 필요 정비 안내"),
    WORK_TYPES[18]: ("비상발전기 연계 전기설비에서 이상이 의심되는 증상", "발전기 연계 배선 및 절체 스위치 상태 점검", "비상발전기 연계 전기점검 및 필요 정비 안내"),
    WORK_TYPES[19]: ("옥내 배전반의 정기 안전점검이 필요한 상황", "배전반 내부 접속 상태 및 전반적인 노후도 점검", "옥내 배전반 정기 안전점검 및 필요 부위 정비"),
    WORK_TYPES[20]: ("전기온수기 전용 배선이 없어 발생하는 전기 이상 증상", "전기온수기 소비전력과 연결 배선 용량의 적합성 검토", "전기온수기 전용 배선 점검 및 신설 안내"),
    WORK_TYPES[21]: ("인덕션·전기레인지 사용 중 차단기가 내려가는 증상", "고전력 조리기기와 기존 회로 용량의 적합성 검토", "인덕션 전용 회로 신설 상담 및 공사 안내"),
    WORK_TYPES[22]: ("전기자동차 충전기 설치를 검토 중인 상황", "설치 위치의 전력 용량 및 배선 인입 가능 여부 검토", "전기차 충전기 설치 상담 및 필요 공사 안내"),
    WORK_TYPES[23]: ("옥외 전등이나 가로등이 켜지지 않거나 깜빡이는 증상", "옥외 배선의 방수 상태 및 점멸기·안정기 이상 여부 점검", "옥외 전등·가로등 점검 및 필요 부위 교체"),
    WORK_TYPES[24]: ("창고·공장 전기설비의 정기 점검이 필요한 상황", "산업용 배선 및 분전반의 노후도, 부하 상태 점검", "창고·공장 전기설비 정기점검 및 필요 정비 안내"),
    WORK_TYPES[25]: ("화장실·욕실 등 습기 있는 공간에 방수 콘센트 설치가 필요한 상황", "설치 위치의 습기 노출 정도와 기존 배선 상태 검토", "방수 콘센트 설치 상담 및 필요 공사 안내"),
    WORK_TYPES[26]: ("실내 배선을 벽체 매립 방식으로 정리하고 싶은 상황", "기존 노출 배선의 위치와 매립 가능 여부 검토", "배선 매립 공사 상담 및 필요 시공 안내"),
    WORK_TYPES[27]: ("스마트홈 기기 연동을 위한 전기배선 정비가 필요한 상황", "기존 배선과 스마트 기기 연동에 필요한 배선의 적합성 검토", "스마트홈 전기배선 연동 공사 상담 및 안내"),
    WORK_TYPES[28]: ("지하실·반지하 공간의 전기설비에서 습기 영향이 의심되는 증상", "습기로 인한 배선 절연 저하 및 부식 여부 점검", "지하 공간 전기설비 습기 점검 및 필요 보강 안내"),
    WORK_TYPES[29]: ("신축이나 인테리어 공사에 맞춰 전기 공사 전반을 검토해야 하는 상황", "전체 배선 계획, 콘센트·조명 배치, 분전반 용량 검토", "신축·인테리어 전기 공사 총괄 상담 및 안내"),
}


def make_case_fields(gu, dong, work_type):
    symptom, cause, service = ACF_FIELDS_BY_WORK_TYPE.get(
        work_type,
        ("차단기가 내려가며 전기가 끊기는 증상", "누전 및 연결 전기회로 이상 여부 점검", "누전 점검 및 전기회로 수리"),
    )

    return {
        "district": gu,
        "dong": dong,
        "symptom": symptom,
        "cause": cause,
        "service": service,
    }


# =========================================================
# 4. 작업유형(case_type) 확인/생성
# =========================================================

def get_or_create_case_type(term_slug, auth):
    """
    case_type taxonomy의 term ID를 가져옵니다.
    해당 slug가 없으면 같은 이름으로 용어를 생성합니다.
    """
    endpoint = f"{WP_URL}/wp-json/wp/v2/case_type"

    try:
        response = requests.get(
            endpoint,
            params={"slug": term_slug, "per_page": 1},
            auth=auth,
            timeout=30,
        )

        if response.status_code == 200:
            terms = response.json()
            if terms:
                term_id = terms[0].get("id")
                if term_id:
                    print(f"✅ case_type 확인: {term_slug} (ID: {term_id})")
                    return int(term_id)

        if response.status_code not in (200, 400):
            print(f"⚠️ case_type 조회 실패: {response.status_code}")
            print(response.text[:700])
            return None

        # 없으면 생성
        create_response = requests.post(
            endpoint,
            json={
                "name": term_slug,
                "slug": term_slug,
            },
            auth=auth,
            timeout=30,
        )

        if create_response.status_code in (200, 201):
            term_id = create_response.json().get("id")
            if term_id:
                print(f"✅ case_type 생성: {term_slug} (ID: {term_id})")
                return int(term_id)

        # 이미 존재하는 경우 다시 조회
        try:
            data = create_response.json()
            if data.get("code") == "term_exists":
                term_id = data.get("data", {}).get("term_id")
                if term_id:
                    print(f"✅ 기존 case_type 사용: {term_slug} (ID: {term_id})")
                    return int(term_id)
        except Exception:
            pass

        print(f"❌ case_type 생성 실패: {create_response.status_code}")
        print(create_response.text[:1000])
        return None

    except requests.RequestException as e:
        print(f"❌ case_type 연결 오류: {e}")
        return None


# =========================================================
# 5. 전화 클릭 배너
# =========================================================

def get_top_banner(gu, dong, image_url):
    location_text = f"{html.escape(gu)} {html.escape(dong)}"

    return f"""
<a href="tel:{PHONE_NUMBER}" style="display:block;text-decoration:none;color:inherit;">
<div style="position:relative;overflow:hidden;margin:0 0 28px;border-radius:16px;min-height:300px;background:linear-gradient(90deg,rgba(3,25,38,.94),rgba(3,38,55,.74)),url('{image_url}') center/cover no-repeat;box-shadow:0 8px 24px rgba(0,0,0,.16);font-family:Arial,'Noto Sans KR',sans-serif;cursor:pointer;">
  <div style="padding:30px 15px 26px;text-align:center;color:#fff;">
    <div style="display:inline-block;background:#ff3b30;color:#fff;font-size:15px;font-weight:800;padding:8px 18px;border-radius:24px;margin-bottom:18px;">365일 24시간 긴급출동</div>
    <div style="margin:0 auto 14px;">
      <div style="font-size:clamp(20px,4.2vw,42px);line-height:1.3;font-weight:900;letter-spacing:-0.8px;word-break:keep-all;text-shadow:0 2px 5px rgba(0,0,0,.45);">{location_text}</div>
      <div style="font-size:clamp(20px,4.2vw,42px);line-height:1.3;font-weight:900;letter-spacing:-0.8px;word-break:keep-all;text-shadow:0 2px 5px rgba(0,0,0,.45);">전기수리 전문</div>
    </div>
    <div style="font-size:clamp(17px,3vw,23px);font-weight:700;line-height:1.5;margin-bottom:20px;word-break:keep-all;">누전수리&nbsp;· 차단기수리&nbsp;· 전기설비&nbsp;· 전기증설</div>
    <span style="display:inline-block;background:#ffc400;color:#111;font-size:clamp(20px,4vw,30px);font-weight:900;padding:15px 30px;border-radius:45px;margin-bottom:16px;box-shadow:0 5px 14px rgba(0,0,0,.28);">☎ 긴급 전화 상담</span>
    <div style="width:100%;font-size:clamp(22px,8vw,66px);line-height:1.15;font-weight:950;letter-spacing:0.5px;white-space:nowrap;color:#ffd400;text-shadow:0 2px 5px rgba(0,0,0,.55);">{PHONE_NUMBER}</div>
    <div style="width:100%;box-sizing:border-box;font-size:clamp(14px,3vw,21px);font-weight:800;color:#fff;margin-top:16px;word-break:keep-all;">📞 이미지를 클릭하시면 전화 연결 되십니다.</div>
  </div>
</div>
</a>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:0 0 34px;font-family:Arial,'Noto Sans KR',sans-serif;">
  <div style="border:1px solid #ddd;border-radius:12px;padding:20px 12px;text-align:center;background:#fff;"><div style="font-size:clamp(22px,5vw,30px);">⚡</div><div style="font-size:clamp(14px,3.4vw,17px);font-weight:800;line-height:1.35;word-break:keep-all;margin-top:6px;">누전 출장 수리</div><div style="font-size:clamp(11px,2.6vw,13px);color:#777;line-height:1.45;word-break:keep-all;margin-top:6px;">차단기 떨어짐<br>누전 점검</div></div>
  <div style="border:1px solid #ddd;border-radius:12px;padding:20px 12px;text-align:center;background:#fff;"><div style="font-size:clamp(22px,5vw,30px);">🔌</div><div style="font-size:clamp(14px,3.4vw,17px);font-weight:800;line-height:1.35;word-break:keep-all;margin-top:6px;">차단기·배선 교체</div><div style="font-size:clamp(11px,2.6vw,13px);color:#777;line-height:1.45;word-break:keep-all;margin-top:6px;">노후 차단기<br>메인 스위치</div></div>
  <div style="border:1px solid #ddd;border-radius:12px;padding:20px 12px;text-align:center;background:#fff;"><div style="font-size:clamp(22px,5vw,30px);">💡</div><div style="font-size:clamp(14px,3.4vw,17px);font-weight:800;line-height:1.35;word-break:keep-all;margin-top:6px;">조명·콘센트 공사</div><div style="font-size:clamp(11px,2.6vw,13px);color:#777;line-height:1.45;word-break:keep-all;margin-top:6px;">LED 교체<br>스위치 증설</div></div>
  <div style="border:1px solid #ddd;border-radius:12px;padding:20px 12px;text-align:center;background:#fff;"><div style="font-size:clamp(22px,5vw,30px);">🛠️</div><div style="font-size:clamp(14px,3.4vw,17px);font-weight:800;line-height:1.35;word-break:keep-all;margin-top:6px;">전기 설비 공사</div><div style="font-size:clamp(11px,2.6vw,13px);color:#777;line-height:1.45;word-break:keep-all;margin-top:6px;">아파트·빌라·다가구<br>전기 증설/개보수</div></div>
</div>
"""


def get_bottom_banner(image_url):
    return f"""
<a href="tel:{PHONE_NUMBER}" style="display:block;text-decoration:none;color:inherit;">
<div style="position:relative;overflow:hidden;margin:45px 0 10px;border-radius:16px;background:linear-gradient(90deg,rgba(3,25,38,.97),rgba(3,38,55,.82)),url('{image_url}') center/cover no-repeat;color:#fff;text-align:center;font-family:Arial,'Noto Sans KR',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.16);cursor:pointer;">
  <div style="padding:38px 12px 42px;">
    <div style="font-size:clamp(23px,5vw,36px);font-weight:900;line-height:1.3;margin-bottom:10px;">24시 긴급 전기수리</div>
    <div style="font-size:clamp(15px,3vw,20px);font-weight:700;margin-bottom:22px;word-break:keep-all;">누전수리&nbsp;· 차단기교체&nbsp;· 분전반&nbsp;· 콘센트&nbsp;· 전기배선</div>
    <div style="width:100%;box-sizing:border-box;background:#ffd000;color:#111;border-radius:12px;padding:14px 8px;margin:0 auto 15px;font-size:clamp(20px,7vw,50px);line-height:1.2;font-weight:950;letter-spacing:0.5px;word-break:keep-all;box-shadow:0 5px 14px rgba(0,0,0,.3);">{PHONE_NUMBER}</div>
    <div style="width:100%;box-sizing:border-box;font-size:clamp(14px,3vw,21px);font-weight:800;line-height:1.5;word-break:keep-all;">📞 이미지를 클릭하시면 전화 연결 되십니다.</div>
  </div>
</div>
</a>
"""


# =========================================================
# 관련 태그 (구/동 기준 30개) — 서울경기_누전수리.html과 동일한 디자인
# =========================================================

TAG_GENERIC_POOL = [
    "누전수리", "전기수리", "차단기수리", "분전반수리", "두꺼비집수리", "콘센트수리",
    "누전차단기교체", "전기설비공사", "전기증설", "24시간전기수리", "긴급전기출동", "전기누전점검",
    "차단기내려감", "메인차단기내려감", "두꺼비집안올라감", "두꺼비집내려감", "차단기고장교체", "차단기트립",
    "콘센트스파크", "콘센트타는냄새", "분전반탄냄새", "분전반그을림", "누전차단기오작동", "콘센트과열",
    "배선노후", "전기끊김", "정전", "특정콘센트전기안됨", "욕실누전", "우천시전기이상",
    "새벽전기끊김", "차단기올려도금방내려감", "멀티탭과열", "전기스파크", "전기화재위험", "배선접속불량",
    "전기설비노후", "다가구주택전기수리", "주택전기수리", "아파트전기수리", "빌라전기수리", "전기점검서비스",
]


def build_related_tags_html(gu, dong):
    """
    실제 등록 대상 지역(구/동) 전용 태그 6개 + 공통 태그 24개 = 30개를
    업로드해주신 서울경기_누전수리.html의 "관련 태그" 섹션과
    똑같은 알약(pill) 디자인으로 만듭니다.
    """
    location = f"{gu}{dong}".replace(" ", "")

    region_tags = [
        f"{location}전기수리",
        f"{location}누전수리",
        f"{location}차단기수리",
        f"{location}콘센트수리",
        f"{location}분전반수리",
        f"{location}두꺼비집수리",
    ]

    generic_pool = TAG_GENERIC_POOL.copy()
    random.shuffle(generic_pool)
    generic_tags = generic_pool[:24]

    spans = []

    for tag in region_tags:
        escaped = html.escape(tag)
        spans.append(
            '<span style="background:#e8f3ff;color:#0a5fb4;font-size:13px;'
            f'padding:7px 14px;border-radius:20px;">#{escaped}</span>'
        )

    for tag in generic_tags:
        escaped = html.escape(tag)
        spans.append(
            '<span style="background:#eef1f5;color:#333;font-size:13px;'
            f'padding:7px 14px;border-radius:20px;">#{escaped}</span>'
        )

    return (
        '<h2 style="font-size:18px;font-weight:900;color:#1c2128;margin:38px 0 14px;">관련 태그</h2>'
        '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;">'
        + "".join(spans)
        + "</div>"
    )


# =========================================================
# 본문 중간 전화연결 배너
# =========================================================

def get_mid_banner(image_url):
    """
    본문 중간 전화연결 배너.
    지정된 업로드 이미지를 배경으로 사용합니다.
    전화번호는 표시하지 않습니다.
    """
    safe_image_url = html.escape(image_url, quote=True)

    return f"""
<a href="tel:{PHONE_NUMBER}" style="display:block;text-decoration:none;color:inherit;">
<div data-electric-mid-banner="1"
     style="position:relative;overflow:hidden;margin:42px 0;
     border-radius:16px;min-height:240px;
     background-image:linear-gradient(90deg,rgba(0,20,32,.82),rgba(0,35,50,.62)),url('{safe_image_url}');
     background-position:center center;background-size:cover;background-repeat:no-repeat;
     color:#fff;text-align:center;font-family:Arial,'Noto Sans KR',sans-serif;
     box-shadow:0 7px 22px rgba(0,0,0,.18);cursor:pointer;">
  <div style="padding:34px 18px 36px;">
    <div style="font-size:clamp(14px,2.5vw,19px);font-weight:800;margin-bottom:10px;">
      24시간 긴급 전기수리
    </div>
    <div style="font-size:clamp(24px,5vw,38px);font-weight:900;line-height:1.3;margin-bottom:14px;text-shadow:0 2px 5px rgba(0,0,0,.45);">
      전기 문제가 반복된다면<br>현장 점검이 필요합니다
    </div>
    <div style="display:inline-block;max-width:92%;box-sizing:border-box;background:#ffd000;color:#111;padding:13px 20px;border-radius:40px;font-size:clamp(14px,3.4vw,23px);font-weight:900;word-break:keep-all;box-shadow:0 4px 12px rgba(0,0,0,.28);">
      📞 이미지를 누르시면 전화연결됩니다
    </div>
  </div>
</div>
</a>
"""


def insert_mid_banners(content, image_urls):
    """
    AI 본문 중간에 사진 배경 전화연결 배너를 삽입합니다.
    4번째와 8번째 HTML 블록 뒤에 최대 2개 삽입합니다.
    """
    if not content or not image_urls:
        return content

    if 'data-mid-electric-banner="1"' in content:
        return content

    # Python 정규식의 가변 길이 look-behind 오류를 피하기 위해
    # 닫는 태그를 캡처한 뒤 본문 조각과 다시 합칩니다.
    raw_parts = re.split(
        r'(</(?:p|h2|h3|h4|ul|ol|blockquote)>)',
        content,
        flags=re.IGNORECASE
    )

    parts = []
    idx = 0

    while idx < len(raw_parts):
        current = raw_parts[idx]

        if idx + 1 < len(raw_parts):
            closing_tag = raw_parts[idx + 1]
            parts.append(current + closing_tag)
            idx += 2
        else:
            if current:
                parts.append(current)
            idx += 1

    output = []
    block_count = 0
    banner_count = 0

    for part in parts:
        if not part:
            continue

        output.append(part)

        # 소제목(h2/h3/h4) 바로 뒤에는 배너를 넣지 않습니다.
        # (소제목과 그 설명 문단이 배너에 의해 갈라지는 문제 방지)
        # 문단(p)·목록(ul/ol)·인용문(blockquote)이 끝난 지점만
        # 배너 삽입 후보로 셉니다.
        if re.search(
            r'</(?:p|ul|ol|blockquote)>$',
            part.strip(),
            flags=re.IGNORECASE
        ):
            block_count += 1

            if block_count in (4, 8) and banner_count < 2:
                image_url = image_urls[banner_count % len(image_urls)]
                banner = get_mid_banner(image_url)
                banner = banner.replace(
                    '<a href="tel:',
                    '<a data-mid-electric-banner="1" href="tel:',
                    1
                )
                output.append(banner)
                banner_count += 1

    # 글이 짧아 4번째 블록이 없으면 중간에 1개 삽입
    # (이때도 소제목 바로 뒤는 피해서, 문단/목록이 끝난 지점을 찾습니다)
    if banner_count == 0 and len(output) >= 3:
        mid = len(output) // 2
        insert_at = None

        for offset in range(len(output)):
            for candidate in (mid + offset, mid - offset):
                if 0 <= candidate < len(output):
                    if re.search(
                        r'</(?:p|ul|ol|blockquote)>$',
                        output[candidate].strip(),
                        flags=re.IGNORECASE
                    ):
                        insert_at = candidate + 1
                        break
            if insert_at is not None:
                break

        if insert_at is None:
            insert_at = mid

        image_url = image_urls[0]
        banner = get_mid_banner(image_url)
        banner = banner.replace(
            '<a href="tel:',
            '<a data-mid-electric-banner="1" href="tel:',
            1
        )
        output.insert(insert_at, banner)

    return ''.join(output)


# =========================================================
# 6. TXT 완성 본문
# =========================================================

CASES_FILE = Path(__file__).with_name(
    "electric_case_20000_combo_v3.txt"
)

# 네이버 어뷰징 방지 + 다양한 작업유형 노출을 위해 추가로 준비한 사례
# 글감 파일이 있으면 함께 읽어옵니다. 없으면 무시하고 넘어갑니다.
NEW_CASES_FILE = Path(__file__).with_name(
    "electric_case_new_cases_60.txt"
)

# =========================================================
# 동(洞)별 제목 사용 이력 — 실행할 때마다 초기화되지 않고
# 파일로 영구 저장됩니다. 한 번 특정 동에서 쓴 제목은
# 이후 몇 번을 다시 실행하더라도 같은 동에서는 다시 쓰지 않습니다.
# =========================================================

TITLE_HISTORY_FILE = Path(__file__).with_name(
    "used_titles_by_dong.json"
)


def load_title_history():
    """
    {"강남구 역삼동": ["제목1", "제목2", ...], ...} 형태로 저장된
    동별 제목 사용 이력을 읽어옵니다. 파일이 없으면 빈 이력으로 시작합니다.
    """
    if not TITLE_HISTORY_FILE.exists():
        return {}

    try:
        with open(TITLE_HISTORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        # 리스트를 set으로 변환해 조회 속도를 높입니다.
        return {loc: set(titles) for loc, titles in data.items()}
    except (json.JSONDecodeError, OSError):
        print("⚠️ 제목 이력 파일을 읽지 못해 새로 시작합니다.")
        return {}


def save_title_history(history):
    """동별 제목 사용 이력을 JSON으로 저장합니다."""
    serializable = {loc: sorted(titles) for loc, titles in history.items()}
    with open(TITLE_HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(serializable, f, ensure_ascii=False, indent=2)


# =========================================================
# 지역 진행 상태 저장 (서울 → 경기 순서로 이어서 진행)
# =========================================================

LOCATION_PROGRESS_FILE = Path(__file__).with_name(
    "location_progress.json"
)


def load_location_progress_index():
    """
    지금까지 몇 번째 지역까지 등록을 마쳤는지(0부터 시작하는 인덱스)를
    읽어옵니다. 파일이 없으면 0(처음부터)으로 시작합니다.
    """
    if not LOCATION_PROGRESS_FILE.exists():
        return 0

    try:
        with open(LOCATION_PROGRESS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return int(data.get("next_index", 0))
    except (json.JSONDecodeError, OSError, ValueError):
        print("⚠️ 지역 진행 상태 파일을 읽지 못해 처음부터 시작합니다.")
        return 0


def save_location_progress_index(next_index):
    """다음 실행 때 이어서 시작할 인덱스를 저장합니다."""
    with open(LOCATION_PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump({"next_index": int(next_index)}, f, ensure_ascii=False, indent=2)


# =========================================================
# 총 등록 개수 상한(300개) + 본문 재료 파일 교체 전까지 실행 잠금
# ---------------------------------------------------------
# 지금까지 등록한 누적 개수가 TOTAL_POST_LIMIT(300)에 도달하면,
# CASES_FILE(본문 재료 TXT)이 "그때 그대로"인 한 스크립트를 실행해도
# 아무것도 등록하지 않고 바로 종료합니다. CASES_FILE을 지우고
# 다시 만들면(파일 수정 시각이 바뀌면) 새 본문이 들어온 것으로
# 보고 누적 개수를 0으로 되돌려 다시 실행되게 합니다.
# =========================================================

TOTAL_POST_LIMIT = 300

POST_LIMIT_STATE_FILE = Path(__file__).with_name(
    "total_post_count.json"
)


def _cases_file_mtime():
    """CASES_FILE의 마지막 수정 시각(없으면 None)."""
    try:
        return CASES_FILE.stat().st_mtime
    except OSError:
        return None


def load_post_limit_state():
    if not POST_LIMIT_STATE_FILE.exists():
        return {"total_posted": 0, "cases_file_mtime": None}
    try:
        with open(POST_LIMIT_STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError, ValueError):
        print("⚠️ 누적 등록 상태 파일을 읽지 못해 초기화합니다.")
        return {"total_posted": 0, "cases_file_mtime": None}


def save_post_limit_state(state):
    with open(POST_LIMIT_STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def check_post_limit_before_run():
    """
    실행 시작 시 호출합니다.
    - 아직 300개 미만이면: 그냥 실행 가능(True), 이번에 등록할 수 있는
      "남은 개수"를 함께 돌려줍니다.
    - 300개에 도달했는데 CASES_FILE이 그때 그대로면: 실행을 막습니다
      (False, 0).
    - 300개에 도달했지만 CASES_FILE이 새로 바뀌었으면(본문 재료를
      다시 만듦): 누적 개수를 0으로 리셋하고 다시 실행을 허용합니다.
    반환값: (실행 가능 여부: bool, 이번에 등록 가능한 최대 개수: int)
    """
    state = load_post_limit_state()
    current_mtime = _cases_file_mtime()
    total_posted = state.get("total_posted", 0)

    if total_posted >= TOTAL_POST_LIMIT:
        if state.get("cases_file_mtime") == current_mtime:
            print("==============================================")
            print(f"🚫 누적 {TOTAL_POST_LIMIT}개 등록을 이미 완료했습니다. 실행을 중단합니다.")
            print(f"   새로 등록하려면 {CASES_FILE.name} 파일을 지운 뒤 다시 실행해서")
            print("   본문 재료를 새로 만들어야 합니다(그러면 자동으로 다시 300개부터 시작).")
            print("==============================================")
            return False, 0
        else:
            print("✅ 본문 재료 파일이 새로 만들어진 것을 확인해서, 누적 등록 개수를 0으로 초기화합니다.")
            state = {"total_posted": 0, "cases_file_mtime": current_mtime}
            save_post_limit_state(state)
            total_posted = 0

    remaining = TOTAL_POST_LIMIT - total_posted
    return True, remaining


def record_posts_made(n):
    """이번 실행에서 실제로 등록한 개수(n)를 누적 상태에 더해서 저장합니다."""
    if n <= 0:
        return
    state = load_post_limit_state()
    state["total_posted"] = state.get("total_posted", 0) + n
    state["cases_file_mtime"] = _cases_file_mtime()
    save_post_limit_state(state)


# =========================================================
# 6-1. TXT 대량 생성기 (조합형)
# -----------------------------------------------------------
# CASES_FILE이 없으면 아래 문단 재료(도입/증상체크리스트/원인 3항목/
# 점검순서/교체시점/점검후확인/주의사항/FAQ)를 랜덤 조합해서
# electric_case_20000_combo_v3.txt를 자동으로 만듭니다.
# 실제 경쟁사 글을 긁어오지 않고, 직접 만든 문단 조각을 조합하는
# 방식이라 저작권 문제와 유사문서(어뷰징) 문제를 함께 줄여줍니다.
# 소제목 8개 + 증상 체크리스트 + 원인 3항목 + FAQ 3개까지 넣어서
# 실제 발행 중인 글과 비슷한 분량/구성이 되도록 만들었습니다.
#
# 중요: 각 "## 소제목"/"### 소제목" 뒤에는 반드시 빈 줄(\n\n)을 넣어야
# 합니다. 빈 줄이 없으면 build_txt_post()의 블록 파서가 소제목과 그
# 뒤의 본문을 한 덩어리로 묶어 <h2> 태그 안에 통째로 넣어버립니다.
# =========================================================

GEN_HOUSING_TYPES = ["아파트", "빌라", "다가구주택"]

# 작업유형별 핵심 증상 키워드(제목/본문에 사용)
GEN_SYMPTOM_KEYWORDS = {
    WORK_TYPES[0]: ["누전차단기가 자꾸 내려가는 증상", "차단기가 수시로 떨어지는 문제", "전기가 갑자기 끊기는 증상", "메인차단기가 반복해서 내려가는 증상"],
    WORK_TYPES[1]: ["분전반에서 탄 냄새가 나는 증상", "두꺼비집 탄화 현상", "분전반 내부 그을림 문제"],
    WORK_TYPES[2]: ["특정 콘센트 사용 시 차단기가 떨어지는 문제", "콘센트 쇼트 의심 증상", "콘센트 사용 중 전기가 끊기는 문제"],
    WORK_TYPES[3]: ["노후 누전차단기 반복 작동 문제", "오래된 차단기의 잦은 오작동", "노후 배선으로 인한 전기 이상"],
    WORK_TYPES[4]: ["조명이 켜지지 않는 증상", "스위치를 눌러도 반응이 없는 증상", "조명이 깜빡거리는 문제"],
    WORK_TYPES[5]: ["특정 공간만 반복적으로 정전되는 증상", "일부 회로만 전기가 끊기는 문제", "노후 배선으로 인한 부분 정전"],
    WORK_TYPES[6]: ["전기 사용량 증가로 인한 용량 부족 문제", "계약전력 초과가 의심되는 상황", "전기 증설이 필요한 것으로 보이는 상황"],
    WORK_TYPES[7]: ["접지 불량이 의심되는 증상", "기기를 만지면 미세한 감전이 느껴지는 증상", "접지 상태 확인이 필요한 상황"],
    WORK_TYPES[8]: ["멀티탭 사용 중 발열이 느껴지는 증상", "연장선이 뜨거워지는 문제", "멀티탭 과부하 의심 증상"],
    WORK_TYPES[9]: ["계량기 주변 이상이 의심되는 상황", "인입선 손상이 의심되는 상황", "전기 공급이 불안정한 증상"],
    WORK_TYPES[10]: ["인터폰이 작동하지 않는 증상", "초인종 소리가 안 들리는 문제", "인터폰 화면이 안 나오는 증상"],
    WORK_TYPES[11]: ["화재감지기가 오작동하는 증상", "경보기가 반응하지 않는 문제", "감지기 점검이 필요한 상황"],
    WORK_TYPES[12]: ["옥상 전기설비에서 누전이 의심되는 상황", "외부 전기설비 점검이 필요한 상황", "빗물 유입으로 인한 전기 이상 의심"],
    WORK_TYPES[13]: ["승강기 전기설비 이상이 의심되는 상황", "승강기 정전 관련 문의", "승강기 전원부 점검 필요 상황"],
    WORK_TYPES[14]: ["냉난방기 사용 중 차단기가 내려가는 증상", "전용 회로가 없어 부하가 몰리는 상황", "냉난방기 신규 설치 상담"],
    WORK_TYPES[15]: ["주차장 조명이 꺼지지 않거나 안 켜지는 증상", "주차장 전기설비 이상 의심", "주차장 습기로 인한 전기 문제 의심"],
    WORK_TYPES[16]: ["상가 간판이 켜지지 않는 증상", "간판 조명이 깜빡이는 문제", "간판 전기공사 상담"],
    WORK_TYPES[17]: ["태양광 연계 설비 이상이 의심되는 상황", "태양광 인버터 주변 전기 이상 의심", "태양광 설비 점검 상담"],
    WORK_TYPES[18]: ["비상발전기 연계 전기설비 이상 의심", "정전 시 발전기 절체 문제", "발전기 연계 점검 상담"],
    WORK_TYPES[19]: ["배전반 정기 점검이 필요한 상황", "배전반 노후 상태 확인 필요", "배전반 안전점검 상담"],
    WORK_TYPES[20]: ["전기온수기 사용 중 차단기가 내려가는 증상", "온수기 전용 배선이 없는 상황", "온수기 신규 설치 상담"],
    WORK_TYPES[21]: ["인덕션 사용 중 차단기가 내려가는 증상", "전기레인지 전용 회로가 없는 상황", "인덕션 신규 설치 상담"],
    WORK_TYPES[22]: ["전기차 충전기 설치를 검토 중인 상황", "충전기 설치 위치 전력 확인 필요", "충전기 설치 상담"],
    WORK_TYPES[23]: ["옥외 전등이 켜지지 않는 증상", "가로등이 깜빡이는 문제", "옥외 조명 점검 상담"],
    WORK_TYPES[24]: ["창고·공장 전기설비 정기점검 필요", "산업용 배선 노후 확인 필요", "공장 전기설비 안전점검 상담"],
    WORK_TYPES[25]: ["화장실·욕실 방수 콘센트 설치 상담", "습기 있는 공간 콘센트 안전 확인 필요", "방수 콘센트 신규 설치 문의"],
    WORK_TYPES[26]: ["실내 배선 매립 공사 상담", "노출 배선 정리 문의", "인테리어 배선 매립 문의"],
    WORK_TYPES[27]: ["스마트홈 기기 연동 배선 상담", "스마트 스위치 설치 문의", "홈오토메이션 배선 정비 문의"],
    WORK_TYPES[28]: ["지하실 전기설비 습기 영향 의심", "반지하 배선 부식 의심", "지하 공간 전기설비 점검 상담"],
    WORK_TYPES[29]: ["신축 전기 공사 총괄 상담", "인테리어 전기 공사 계획 상담", "전체 배선·분전반 계획 문의"],
}

GEN_OPENING_VARIANTS = [
    "차단기가 내려가거나 특정 공간의 전기가 끊기면 먼저 분전반을 확인하게 됩니다. 다만 손잡이 위치만 보고 원인을 정하기보다는 어떤 조건에서 증상이 생겼는지를 함께 살펴보는 것이 안전합니다.",
    "전기 관련 증상은 겉으로 보이는 현상만으로는 원인을 단정하기 어렵습니다. {gu} {dong} {housing}에서도 언제, 어디에서, 어떤 상황에서 문제가 나타났는지를 먼저 정리하는 것이 점검의 시작입니다.",
    "{gu} {dong} {housing}에서 {symptom}에 대한 문의를 받았습니다. 이런 증상은 단순히 한 가지 원인으로 결론짓기보다, 발생 조건을 함께 확인해야 정확한 원인을 좁힐 수 있습니다.",
    "겉보기엔 특별히 이상이 없어 보여도 전기 계통에서는 문제가 진행되고 있는 경우가 있습니다. {gu} {dong} {housing}에서 겪고 계신 증상도 무조건 한 가지 원인으로 단정하기보다, 나타난 조건을 하나씩 짚어보는 편이 안전합니다.",
    "{gu} {dong} {housing}에서 전기 이상을 겪으셨다면, 먼저 증상이 반복되는지 한 번으로 끝났는지를 구분하는 것이 점검의 출발점이 됩니다. 반복 여부에 따라 확인해야 할 범위가 달라지기 때문입니다.",
    "전기 문제는 특성상 원인이 겹쳐서 나타나는 경우가 많아, {gu} {dong} {housing}에서도 증상 하나만 보고 결론을 내리기보다는 발생 시점과 사용 환경을 함께 살펴보는 것이 정확한 판단에 도움이 됩니다.",
]

GEN_CONTEXT_VARIANTS = [
    "{gu} {dong} {housing}에서 「{symptom}」과 같은 상황을 살펴볼 때는 증상이 언제, 어디에서, 어떤 조건에서 나타났는지를 먼저 정리하는 것이 좋습니다. 아파트와 빌라, 다가구주택에서 발생하는 전기 문제는 비슷한 증상으로 시작하더라도 원인은 서로 다를 수 있습니다.",
    "{gu} {dong}에 위치한 {housing}에서 겪고 계신 「{symptom}」은 사용 환경에 따라 원인이 달라질 수 있습니다. 같은 증상이라도 특정 기기를 사용할 때 발생하는 경우와, 아무것도 사용하지 않는 상태에서 발생하는 경우는 확인해야 할 범위가 서로 다릅니다.",
    "「{symptom}」이 반복된다고 해서 원인이 항상 한 가지로 정해져 있는 것은 아닙니다. {gu} {dong} {housing} 상황에 맞춰, 집에서 먼저 구분해볼 수 있는 기준부터 정리해보겠습니다.",
    "{gu} {dong} {housing}에서 「{symptom}」을 겪고 계시다면, 원인을 누전이나 과부하 한쪽으로 성급히 단정하기보다 증상이 나타나는 패턴부터 살펴보는 것이 순서입니다.",
]

GEN_CONTEXT2_VARIANTS = [
    "{gu} {dong} {housing}에서 확인할 수 있는 상황을 기준으로 「{symptom}」에 대해 살펴보겠습니다. 전기 문제는 증상만 보고 하나의 원인으로 결론을 내리기보다 전기가 끊긴 범위와 발생 조건을 함께 확인하는 것이 좋습니다.",
    "이런 증상은 방치하면 재발할 가능성이 있기 때문에, {gu} {dong} {housing} 상황에 맞춰 원인이 될 수 있는 범위를 하나씩 짚어보는 과정이 필요합니다.",
    "{gu} {dong} {housing}에서는 눈으로 보이는 변색·그을음 같은 흔적과, 손으로 느껴지는 열감이나 진동을 함께 확인하는 것이 원인을 좁히는 데 도움이 됩니다.",
    "{symptom} 자체보다 그 증상이 나타나는 시점과 조건이 더 중요한 단서가 되는 경우가 많습니다. {gu} {dong} {housing}에서도 이 부분을 먼저 정리해두면 점검이 한결 수월해집니다.",
]

GEN_SYMPTOM_CHECKLIST = {
    WORK_TYPES[0]: [
        "차단기가 반복해서 내려가는 경우",
        "특정 공간이나 일부 콘센트만 전기가 들어오지 않는 경우",
        "특정 전기제품을 사용할 때 증상이 반복되는 경우",
        "콘센트나 스위치 주변에서 열감·그을음·스파크가 느껴지는 경우",
        "비가 오거나 욕실 사용 뒤 전기 이상이 나타나는 경우",
        "새벽 등 특정 시간대에 같은 현상이 반복되는 경우",
        "차단기를 올려도 금방 다시 내려가는 경우",
        "여러 고전력 기기를 동시에 켰을 때만 내려가는 경우",
        "가전제품을 하나씩 꺼봐도 원인 기기를 특정하기 어려운 경우",
        "차단기를 만지면 미세한 진동이나 소리가 느껴지는 경우",
    ],
    WORK_TYPES[1]: [
        "분전반 근처에서 탄 냄새가 나는 경우",
        "분전반 커버 주변이 변색되거나 그을려 있는 경우",
        "특정 차단기만 유난히 뜨겁게 느껴지는 경우",
        "차단기를 만졌을 때 미세한 진동이나 소음이 느껴지는 경우",
        "분전반 주변 벽면이나 커버에 그을음이 보이는 경우",
        "특정 회로를 사용할 때만 탄 냄새가 심해지는 경우",
        "분전반을 열었을 때 특정 부위만 색이 변해 있는 경우",
        "분전반 커버를 만지면 미지근한 정도를 넘어 뜨겁게 느껴지는 경우",
        "냄새는 나는데 정확히 어느 차단기에서 나는지 구분이 안 되는 경우",
    ],
    WORK_TYPES[2]: [
        "특정 콘센트를 사용할 때만 차단기가 내려가는 경우",
        "콘센트 주변에서 스파크가 튀거나 타는 냄새가 나는 경우",
        "콘센트에 플러그를 꽂을 때 유난히 뻑뻑하거나 헐거운 경우",
        "콘센트 주변이 변색되어 있거나 그을린 흔적이 있는 경우",
        "같은 콘센트에서 반복적으로 같은 증상이 나타나는 경우",
        "여러 제품을 동시에 꽂았을 때만 문제가 생기는 경우",
        "콘센트를 만지면 미세한 열감이 느껴지는 경우",
        "손을 2~3초 이상 대기 어려울 정도로 콘센트가 뜨거운 경우",
        "특정 콘센트만 유독 사용감이 헐겁게 느껴지는 경우",
    ],
    WORK_TYPES[3]: [
        "차단기가 특별한 이유 없이 자주 작동하는 경우",
        "차단기를 설치한 지 오래되어 정확한 연식을 알기 어려운 경우",
        "차단기 외관이 변색되었거나 스위치 조작이 뻑뻑한 경우",
        "예전보다 전기 사용량이 늘었는데 차단기는 그대로인 경우",
        "차단기를 눌러도 반응이 둔하거나 늦게 작동하는 경우",
        "비슷한 시기에 설치된 다른 설비도 함께 노후된 경우",
        "테스트 버튼을 눌렀을 때 반응 속도가 예전과 달라진 느낌이 드는 경우",
        "정기 점검을 받아본 적이 언제인지 기억이 잘 안 나는 경우",
    ],
    WORK_TYPES[4]: [
        "스위치를 눌러도 조명이 켜지지 않는 경우",
        "조명이 켜졌다 꺼지기를 반복하며 깜빡거리는 경우",
        "특정 조명만 유독 자주 고장 나는 경우",
        "스위치를 누를 때 뻑뻑하거나 딸깍거리는 소리가 다른 경우",
        "조명 교체 후에도 같은 증상이 반복되는 경우",
        "스위치 주변에서 미세한 열감이나 냄새가 느껴지는 경우",
        "여러 조명이 한 스위치에 물려 있어 원인 파악이 어려운 경우",
    ],
    WORK_TYPES[5]: [
        "특정 방이나 구역만 반복적으로 정전되는 경우",
        "정전 범위가 매번 조금씩 다르게 나타나는 경우",
        "차단기는 정상인데 특정 콘센트만 전기가 안 들어오는 경우",
        "오래된 건물에서 배선 노후가 의심되는 경우",
        "정전이 특정 날씨나 시간대에 반복되는 경우",
        "벽 내부에서 미세한 냄새나 열감이 느껴지는 경우",
        "리모델링 이력이 없는 오래된 배선을 그대로 쓰고 있는 경우",
    ],
    WORK_TYPES[6]: [
        "여러 고전력 가전을 늘렸는데 계약전력은 그대로인 경우",
        "동시 사용 시 자주 차단기가 내려가 불편한 경우",
        "가전제품이 늘어나면서 전체 사용 전력이 커진 경우",
        "인테리어나 증축으로 전기 사용 계획이 바뀐 경우",
        "기존 배선 용량이 현재 사용량에 맞는지 확인이 필요한 경우",
        "승압 공사를 고려하고 있지만 절차를 잘 모르는 경우",
    ],
    WORK_TYPES[7]: [
        "금속 가전제품을 만졌을 때 미세한 저릿함이 느껴지는 경우",
        "욕실이나 세탁실 등 물 사용 공간에서 이상이 느껴지는 경우",
        "오래된 건물이라 접지 공사 여부가 불확실한 경우",
        "특정 기기를 사용할 때만 이상 증상이 나타나는 경우",
        "누전차단기 동작과 함께 접지 상태도 의심되는 경우",
        "리모델링 과정에서 접지선 연결이 확인되지 않은 경우",
    ],
    WORK_TYPES[8]: [
        "멀티탭을 만지면 뜨겁게 느껴지는 경우",
        "멀티탭에 여러 고전력 기기를 함께 꽂아 쓰는 경우",
        "연장선을 감은 채로 장시간 사용하는 경우",
        "멀티탭 표면이 변색되거나 그을린 흔적이 있는 경우",
        "오래된 멀티탭을 정격 확인 없이 계속 사용하는 경우",
        "멀티탭 사용 중 타는 냄새가 잠깐 느껴진 적이 있는 경우",
    ],
    WORK_TYPES[9]: [
        "계량기 주변에서 이상 소음이나 냄새가 느껴지는 경우",
        "특정 시간대에 전기 공급이 불안정하게 느껴지는 경우",
        "인입선 외관이 손상되거나 노후된 것으로 보이는 경우",
        "계량기 자체의 정상 작동 여부가 궁금한 경우",
        "정전이 우리 집만이 아니라 주변 세대와도 관련 있어 보이는 경우",
        "한전 쪽 문제인지 내부 배선 문제인지 구분이 안 되는 경우",
    ],
    WORK_TYPES[10]: [
        "인터폰 화면이 아예 안 켜지는 경우",
        "초인종을 눌러도 실내에서 소리가 안 들리는 경우",
        "인터폰 통화는 되는데 화면만 안 나오는 경우",
        "특정 시간대에만 작동이 불안정한 경우",
        "인터폰 단자함 주변에서 이상이 느껴지는 경우",
        "여러 세대가 함께 쓰는 공동현관 인터폰에서 문제가 있는 경우",
    ],
    WORK_TYPES[11]: [
        "화재감지기 표시등이 꺼져 있는 경우",
        "경보기가 이유 없이 울리는 경우",
        "테스트 버튼을 눌러도 반응이 없는 경우",
        "감지기 주변에 먼지나 오염이 많은 경우",
        "설치된 지 오래되어 정확한 연식을 알기 어려운 경우",
        "여러 개의 감지기 중 일부만 작동하지 않는 경우",
    ],
    WORK_TYPES[12]: [
        "옥상 전기설비 주변에서 빗물 유입 흔적이 보이는 경우",
        "외부 배선 피복이 손상되어 있는 경우",
        "우천 시에만 특정 회로에 이상이 나타나는 경우",
        "옥상 조명이나 설비가 자주 고장 나는 경우",
        "외부 단자함이 노후되어 보이는 경우",
        "외부 설비 주변에서 녹이나 부식이 보이는 경우",
    ],
    WORK_TYPES[13]: [
        "승강기 운행 중 조명이 깜빡이는 경우",
        "정전 후 승강기가 재작동하지 않는 경우",
        "승강기 전원부에서 이상 소음이 나는 경우",
        "특정 층에서만 문제가 반복되는 경우",
        "비상용 배터리 작동 여부가 불확실한 경우",
        "승강기 기계실 주변 전기설비가 노후된 경우",
    ],
    WORK_TYPES[14]: [
        "냉난방기 켤 때마다 차단기가 내려가는 경우",
        "냉난방기와 다른 가전을 같이 쓰면 문제가 생기는 경우",
        "여름·겨울철에만 반복되는 경우",
        "기존 콘센트가 냉난방기 전용이 아닌 경우",
        "신규 냉난방기 설치를 앞두고 있는 경우",
        "냉난방기 코드가 뜨겁게 느껴지는 경우",
    ],
    WORK_TYPES[15]: [
        "주차장 조명이 계속 켜져 있거나 안 켜지는 경우",
        "주차장 콘센트나 전기설비에서 이상이 느껴지는 경우",
        "우천이나 습기 많은 날 문제가 심해지는 경우",
        "지하주차장 조명 일부만 고장 난 경우",
        "센서등이 반응하지 않는 경우",
        "주차장 전기설비가 오래되어 보이는 경우",
    ],
    WORK_TYPES[16]: [
        "간판 조명이 아예 안 켜지는 경우",
        "간판 일부 글자만 불이 안 들어오는 경우",
        "간판이 깜빡이거나 점멸하는 경우",
        "우천 시에만 문제가 생기는 경우",
        "간판 설치 후 오랫동안 점검한 적이 없는 경우",
        "간판 전원 연결부에서 이상이 느껴지는 경우",
    ],
    WORK_TYPES[17]: [
        "태양광 발전량이 평소보다 눈에 띄게 줄어든 경우",
        "인버터 표시등에 이상 신호가 뜨는 경우",
        "태양광 연계 배선 주변에서 이상이 느껴지는 경우",
        "설치 후 정기 점검을 받은 적이 오래된 경우",
        "우천 후 발전 효율이 회복되지 않는 경우",
        "인버터 주변에서 소음이나 열감이 느껴지는 경우",
    ],
    WORK_TYPES[18]: [
        "정전 시 발전기가 자동으로 작동하지 않는 경우",
        "절체 스위치 전환이 느리거나 안 되는 경우",
        "발전기 시운전 상태를 오래 확인하지 않은 경우",
        "발전기 연료·배터리 상태가 불확실한 경우",
        "정전 복구 후 정상 전환이 안 되는 경우",
        "발전기 연계 배선이 노후된 것으로 보이는 경우",
    ],
    WORK_TYPES[19]: [
        "배전반 정기 점검을 받은 지 오래된 경우",
        "배전반 내부 접속부에 변색이 보이는 경우",
        "배전반 주변에서 열감이나 소음이 느껴지는 경우",
        "건물 전체 전기 사용량이 늘었는데 점검이 없었던 경우",
        "배전반 문이 헐겁거나 잠금 상태가 불안정한 경우",
        "배전반 근처에 물건이 쌓여 접근이 어려운 경우",
    ],
    WORK_TYPES[20]: [
        "전기온수기 사용 중 차단기가 내려가는 경우",
        "온수기 전용 콘센트가 없는 경우",
        "온수기 코드나 콘센트가 뜨겁게 느껴지는 경우",
        "온수기와 다른 가전을 같이 쓰면 문제가 생기는 경우",
        "신규 온수기 설치를 앞두고 있는 경우",
        "온수기 사용 중 미세한 열감이나 냄새가 느껴지는 경우",
    ],
    WORK_TYPES[21]: [
        "인덕션 사용 중 차단기가 내려가는 경우",
        "여러 화구를 동시에 켜면 문제가 생기는 경우",
        "전기레인지 전용 콘센트가 없는 경우",
        "코드나 콘센트가 뜨겁게 느껴지는 경우",
        "신규 인덕션 설치를 앞두고 있는 경우",
        "기존 가스레인지 자리에 인덕션을 설치한 경우",
    ],
    WORK_TYPES[22]: [
        "전기차 충전기 설치를 검토 중인 경우",
        "설치 위치의 전력 용량이 불확실한 경우",
        "공동주택이라 관리사무소 협의가 필요한 경우",
        "기존 배선에서 충전기까지 거리가 먼 경우",
        "완속·급속 중 어떤 방식이 맞는지 판단이 필요한 경우",
        "충전기 설치 후 이상 작동이 의심되는 경우",
    ],
    WORK_TYPES[23]: [
        "옥외 전등이 켜지지 않는 경우",
        "가로등이 낮에도 켜져 있는 경우",
        "가로등이 깜빡이거나 점멸하는 경우",
        "특정 구간의 옥외 조명만 고장 난 경우",
        "우천 후 문제가 심해지는 경우",
        "점멸기(센서)가 오작동하는 것으로 보이는 경우",
    ],
    WORK_TYPES[24]: [
        "창고·공장 전기설비 정기점검이 오래된 경우",
        "산업용 기계 사용 중 차단기가 자주 내려가는 경우",
        "배전반 내부에 변색이나 그을음이 보이는 경우",
        "전력 사용량이 늘었는데 설비는 그대로인 경우",
        "노후 건물이라 배선 상태가 불확실한 경우",
        "특정 라인에서만 전기 이상이 반복되는 경우",
    ],
    WORK_TYPES[25]: [
        "화장실·욕실에 콘센트가 없어 불편한 경우",
        "기존 콘센트가 방수 등급이 아닌 경우",
        "습기 있는 공간에서 감전 위험이 걱정되는 경우",
        "세탁실·베란다에 방수 콘센트가 필요한 경우",
        "리모델링을 계획 중인 경우",
        "기존 콘센트 주변에 습기 흔적이 있는 경우",
    ],
    WORK_TYPES[26]: [
        "기존 배선이 노출된 채로 지저분하게 설치돼 있는 경우",
        "인테리어를 새로 계획 중인 경우",
        "노출 배선 때문에 안전사고가 걱정되는 경우",
        "매립이 가능한 구조인지 궁금한 경우",
        "기존 배선 위치를 바꾸고 싶은 경우",
        "매립 공사 범위와 비용이 궁금한 경우",
    ],
    WORK_TYPES[27]: [
        "스마트 스위치 설치를 검토 중인 경우",
        "기존 배선이 스마트 기기 연동에 맞는지 궁금한 경우",
        "중성선 유무를 확인해야 하는 경우",
        "여러 스마트 기기를 한 번에 설치하려는 경우",
        "설치 후 기기가 불안정하게 작동하는 경우",
        "월패드·허브와의 연동 배선이 필요한 경우",
    ],
    WORK_TYPES[28]: [
        "지하실·반지하 배선 주변에 습기가 많은 경우",
        "콘센트나 스위치에 녹이나 부식이 보이는 경우",
        "장마철에만 전기 이상이 반복되는 경우",
        "누전차단기가 유독 이 공간에서 자주 작동하는 경우",
        "환기가 잘 안 되는 구조인 경우",
        "오래된 건물이라 배선 상태가 불확실한 경우",
    ],
    WORK_TYPES[29]: [
        "신축이나 전체 인테리어를 계획 중인 경우",
        "콘센트·조명 배치를 새로 정하고 싶은 경우",
        "분전반 용량을 새로 검토해야 하는 경우",
        "기존 배선을 그대로 쓸지 판단이 필요한 경우",
        "여러 시공업체와 일정 조율이 필요한 경우",
        "전기 공사 예산과 범위가 궁금한 경우",
    ],
}

# =========================================================
# (참고) 위 체크리스트는 매번 5~6개를 랜덤으로 뽑아 쓰므로,
# 항목 수를 늘려두면 같은 지역이라도 매번 다른 조합이 나옵니다.
# =========================================================

# 작업유형별 원인 항목 — (소제목, 설명) 튜플. 각 유형당 4개를 준비해두고
# 매번 3개를 랜덤으로 뽑아 쓰므로, 같은 지역이라도 매번 다른 조합이 나옵니다.
GEN_CAUSE_SECTIONS = {
    WORK_TYPES[0]: [
        ("차단기 상태", "오래 사용한 차단기 자체의 상태도 확인 대상이지만, 차단기만 바꾸기 전에 연결된 회로의 이상 여부를 함께 살펴보는 것이 중요합니다."),
        ("사용 부하", "여러 전열기기를 동시에 사용하거나 한 회로에 부하가 집중되는 조건에서는 과부하 가능성을 함께 검토할 수 있습니다."),
        ("접속부·콘센트", "그을음, 변색, 열감, 스파크 같은 흔적이 있다면 콘센트 외관뿐 아니라 내부 접속과 연결된 배선도 확인할 필요가 있습니다."),
        ("습기·계절 요인", "장마철이나 욕실 사용 직후처럼 습기가 많은 조건에서 반복된다면, 절연 저하로 인한 누전 가능성을 함께 살펴볼 수 있습니다."),
    ],
    WORK_TYPES[1]: [
        ("접속 단자 상태", "분전반 내부 접속 단자에 헐거움이나 부식이 있으면 접촉 저항이 커지면서 발열과 탄화로 이어질 수 있어 우선 확인이 필요합니다."),
        ("부하 집중", "특정 회로에 전력 사용이 몰리는 시간대가 있다면, 그 구간의 접속부에 열이 누적되고 있는지 함께 살펴봐야 합니다."),
        ("차단기·버스바 연결", "차단기와 버스바 사이 연결이 느슨해지면 미세한 스파크가 반복되면서 탄화 흔적이 남을 수 있습니다."),
        ("분전반 설치 환경", "통풍이 잘 안 되는 위치나 먼지가 쌓이기 쉬운 곳에 분전반이 있다면, 열이 잘 빠지지 않아 탄화가 진행되는 속도가 빨라질 수 있습니다."),
    ],
    WORK_TYPES[2]: [
        ("콘센트 내부 접점", "오래 사용한 콘센트는 내부 접점이 마모되거나 변형되면서 쇼트로 이어질 가능성이 있어 분해 점검이 필요할 수 있습니다."),
        ("연결 기기 부하", "특정 전자제품을 연결했을 때만 증상이 나타난다면, 해당 기기와 콘센트 회로의 관계를 먼저 확인하는 것이 좋습니다."),
        ("배선 접속 상태", "콘센트 뒤편 배선 접속이 느슨하거나 손상돼 있으면 사용 중 접촉 불량으로 이어질 수 있습니다."),
        ("플러그·멀티탭 상태", "콘센트 자체보다 꽂혀 있는 플러그나 멀티탭이 헐겁거나 노후된 경우에도 비슷한 증상이 나타날 수 있어 함께 확인하는 것이 좋습니다."),
    ],
    WORK_TYPES[3]: [
        ("차단기 노후화", "설치된 지 오래된 차단기는 내부 부품의 감도가 떨어지면서 정상적인 사용 조건에서도 반복적으로 작동할 수 있습니다."),
        ("배선 노후화", "차단기와 함께 연결된 전열 회로 배선도 오래됐다면 절연 성능 저하 여부를 같이 확인하는 것이 안전합니다."),
        ("사용 부하 변화", "가전제품이 늘어나거나 사용 패턴이 바뀌면서 예전보다 부하가 커진 경우, 기존 차단기 용량이 맞지 않을 수 있습니다."),
        ("점검 이력 부재", "설치 이후 별도 점검을 받은 적이 없다면, 겉으로 드러나지 않은 노후 징후가 누적돼 있을 가능성도 함께 고려할 수 있습니다."),
    ],
    WORK_TYPES[4]: [
        ("조명기구 자체 수명", "LED나 형광등도 사용 시간이 누적되면 수명이 다해 깜빡임이나 미점등으로 이어질 수 있어 조명기구 자체 상태부터 확인하는 것이 순서입니다."),
        ("스위치 접점 마모", "오래 사용한 스위치는 내부 접점이 마모되면서 눌러도 반응이 없거나 헐거운 느낌이 들 수 있습니다."),
        ("연결 배선 상태", "조명기구나 스위치가 아니라 그 사이를 연결하는 배선 자체에 접속 불량이 있는 경우도 있어 함께 확인이 필요합니다."),
        ("전압 불안정", "같은 회로에 부하가 몰릴 때만 깜빡거림이 반복된다면, 순간적인 전압 변동 가능성도 열어두고 살펴볼 수 있습니다."),
    ],
    WORK_TYPES[5]: [
        ("배선 노후·손상", "설치된 지 오래된 배선은 피복이 손상되거나 접속부가 느슨해지면서 부분 정전으로 이어질 수 있습니다."),
        ("접속 불량 구간", "벽 내부나 분전반 인근의 특정 접속 구간에 문제가 있으면, 그 구간과 연결된 콘센트나 조명만 전기가 끊길 수 있습니다."),
        ("분기 회로 구성", "오래된 건물은 분기 회로 구성이 지금 기준과 다를 수 있어, 정전 범위가 예상과 다르게 넓거나 좁게 나타날 수 있습니다."),
        ("리모델링 이력", "과거 리모델링 과정에서 배선이 임시로 연결된 부분이 있다면, 시간이 지나며 접속 상태가 나빠졌을 가능성도 확인해볼 수 있습니다."),
    ],
    WORK_TYPES[6]: [
        ("현재 계약전력", "지금 계약된 전력량이 실제 사용하는 전기제품의 총 용량을 감당할 수 있는지부터 확인하는 것이 증설 여부 판단의 출발점입니다."),
        ("배선·분전반 여유 용량", "계약전력을 늘리더라도 기존 배선과 분전반이 그 용량을 감당할 수 있는지 함께 검토해야 합니다."),
        ("사용 패턴 변화", "가전 추가나 가족 구성원 변화로 전력 사용 패턴이 달라졌다면, 그 변화 폭에 맞춰 증설 규모를 정하는 것이 좋습니다."),
        ("승압 필요 여부", "단순 증설로 충분한지, 단상에서 삼상으로의 승압까지 필요한지는 사용 기기의 종류에 따라 달라질 수 있습니다."),
    ],
    WORK_TYPES[7]: [
        ("접지선 연결 상태", "접지선이 제대로 연결돼 있지 않으면 기기 외함에 누설전류가 흘러도 감지가 늦어질 수 있어 우선 확인이 필요합니다."),
        ("접지저항 값", "접지가 되어 있어도 저항 값이 기준을 벗어나면 제 역할을 하지 못할 수 있어 측정을 통한 확인이 필요합니다."),
        ("건물 노후도", "오래된 건물일수록 접지 공사 자체가 안 되어 있거나 현재 기준에 맞지 않게 시공된 경우가 있어 구조 자체를 확인할 필요가 있습니다."),
        ("습기 있는 공간과의 연관성", "욕실, 세탁실처럼 물을 쓰는 공간과 가까운 회로일수록 접지 불량의 영향이 더 크게 나타날 수 있습니다."),
    ],
    WORK_TYPES[8]: [
        ("멀티탭 정격 초과", "멀티탭에 표시된 정격 용량보다 많은 전력을 동시에 사용하면 접점과 내부 배선에 열이 몰릴 수 있습니다."),
        ("접속부 노후", "오래 사용한 멀티탭은 플러그를 꽂는 접속부가 헐거워지면서 접촉 저항이 커지고 발열로 이어질 수 있습니다."),
        ("배선 감김 상태", "연장선을 감아둔 채로 장시간 사용하면 방열이 잘 안 돼 같은 용량이라도 더 쉽게 뜨거워질 수 있습니다."),
        ("품질·인증 여부", "정품 인증이 없는 제품은 정격 표시와 실제 성능이 다를 수 있어, 표시 용량만 믿고 사용하기보다 실제 발열 여부를 함께 확인하는 것이 좋습니다."),
    ],
    WORK_TYPES[9]: [
        ("계량기 자체 이상", "계량기 내부 접속이나 부품에 문제가 있으면 전기 공급이 불안정하게 느껴질 수 있어 우선 계량기 상태부터 확인이 필요합니다."),
        ("인입선 손상", "외부에 노출된 인입선이 노후되거나 손상됐다면 이 부분이 전기 공급 불안정의 원인이 될 수 있습니다."),
        ("한전 공급 구간 문제", "계량기 이전 구간(한전 관할)의 문제인지, 계량기 이후 내부 배선 문제인지를 구분하는 것이 점검 범위를 정하는 데 중요합니다."),
        ("주변 세대와의 연관성", "같은 건물 내 다른 세대에서도 비슷한 증상이 있다면, 개별 세대보다 공용 설비 쪽 원인을 함께 살펴볼 필요가 있습니다."),
    ],
    WORK_TYPES[10]: [
        ("전원 공급 상태", "인터폰은 별도 전원선으로 연결되는 경우가 많아, 해당 전원 공급이 끊겼는지부터 확인이 필요합니다."),
        ("단자함 접속 상태", "세대 통신단자함 내부 접속이 느슨하거나 손상되면 화면·음성 이상으로 이어질 수 있습니다."),
        ("인터폰 기기 자체 노후", "설치된 지 오래된 인터폰은 내부 부품 수명이 다해 오작동할 수 있습니다."),
    ],
    WORK_TYPES[11]: [
        ("센서 오염·수명", "감지기 센서에 먼지가 쌓이거나 수명이 다하면 정상적인 감지가 어려워질 수 있습니다."),
        ("전원·배터리 상태", "배터리형 감지기는 배터리 소진이, 배선형은 전원 공급 문제가 오작동의 원인이 될 수 있습니다."),
        ("연결 배선 상태", "감지기와 수신반을 연결하는 배선에 접속 불량이 있으면 신호 전달에 문제가 생길 수 있습니다."),
    ],
    WORK_TYPES[12]: [
        ("방수 상태 저하", "옥상·외부에 노출된 배선함의 방수 처리가 약해지면 빗물 유입으로 절연 성능이 떨어질 수 있습니다."),
        ("배선 피복 손상", "자외선과 온도 변화에 오래 노출된 외부 배선은 피복이 갈라지거나 손상될 수 있습니다."),
        ("단자함 부식", "외부 환경에 노출된 금속 부품은 부식이 진행되며 접속 불량으로 이어질 수 있습니다."),
    ],
    WORK_TYPES[13]: [
        ("전원 공급 배선 상태", "승강기 전용 전원 공급 배선에 접속 불량이나 노후가 있으면 운행 중 이상으로 이어질 수 있습니다."),
        ("절체 스위치 상태", "정전 시 비상 전원으로 전환되는 절체 스위치에 문제가 있으면 재작동이 지연될 수 있습니다."),
        ("기계실 전기설비 노후", "기계실 내 분전반과 배선이 오래됐다면 승강기 전기설비 전반의 안정성에 영향을 줄 수 있습니다."),
    ],
    WORK_TYPES[14]: [
        ("전용 회로 부재", "냉난방기가 다른 가전과 같은 회로를 쓰고 있다면, 동시 사용 시 부하가 몰려 차단기가 내려갈 수 있습니다."),
        ("소비전력 대비 배선 용량", "냉난방기의 소비전력이 기존 배선 용량보다 크면 반복적인 트립으로 이어질 수 있습니다."),
        ("콘센트·플러그 상태", "전용 회로가 있어도 콘센트나 플러그 자체가 노후됐다면 접촉 불량이 발생할 수 있습니다."),
    ],
    WORK_TYPES[15]: [
        ("습기·환기 영향", "지하주차장은 습기에 취약해 배선 절연 상태가 저하되기 쉽습니다."),
        ("센서·타이머 고장", "조명이 자동으로 켜지고 꺼지는 방식이라면 센서나 타이머 자체의 고장일 수 있습니다."),
        ("배선 노후", "설치된 지 오래된 주차장 배선은 접속 불량이나 피복 손상이 진행됐을 수 있습니다."),
    ],
    WORK_TYPES[16]: [
        ("안정기·전원 공급 상태", "간판 조명을 밝히는 안정기나 전원 공급 장치에 문제가 있으면 점등 불량으로 이어질 수 있습니다."),
        ("배선 노후·방수 저하", "외부에 노출된 간판 배선은 방수 성능이 떨어지면 빗물 유입으로 접속 불량이 생길 수 있습니다."),
        ("조명 소자 수명", "LED나 네온 등 조명 소자 자체의 수명이 다한 경우에도 부분 점등 불량이 나타날 수 있습니다."),
    ],
    WORK_TYPES[17]: [
        ("인버터 상태", "태양광 발전 전기를 가정용으로 변환하는 인버터에 이상이 있으면 발전 효율이나 안전성에 영향을 줄 수 있습니다."),
        ("연계 배선 상태", "태양광 설비와 기존 전기설비를 연결하는 배선의 접속 불량이나 손상이 원인이 될 수 있습니다."),
        ("설비 노후·오염", "패널이나 관련 설비의 노후, 오염이 누적되면 발전 효율 저하로 이어질 수 있습니다."),
    ],
    WORK_TYPES[18]: [
        ("절체 스위치 상태", "정전 시 상용전원에서 발전기 전원으로 전환하는 절체 스위치에 문제가 있으면 자동 전환이 지연되거나 안 될 수 있습니다."),
        ("발전기 자체 상태", "배터리나 연료, 내부 부품 상태에 따라 발전기 시동 자체가 안 되는 경우가 있습니다."),
        ("연계 배선 노후", "발전기와 건물 전기설비를 연결하는 배선이 노후되면 안정적인 전력 공급에 영향을 줄 수 있습니다."),
    ],
    WORK_TYPES[19]: [
        ("접속부 노후", "배전반 내부 접속 단자가 오래되면 접촉 저항이 커지며 발열로 이어질 수 있습니다."),
        ("부하 분산 상태", "특정 회로에 전력 사용이 몰려 있다면 배전반 전체의 균형이 무너져 있을 수 있습니다."),
        ("점검 이력 부재", "정기 점검 없이 오래 사용된 배전반은 겉으로 드러나지 않은 이상이 누적돼 있을 수 있습니다."),
    ],
    WORK_TYPES[20]: [
        ("전용 배선 부재", "전기온수기는 소비전력이 큰 편이라 전용 배선이 없으면 기존 회로에 부하가 몰릴 수 있습니다."),
        ("소비전력 대비 배선 용량", "온수기의 소비전력이 기존 배선 용량을 초과하면 반복적인 차단기 작동으로 이어질 수 있습니다."),
        ("콘센트·연결부 상태", "전용 배선이 있어도 콘센트나 연결부가 노후됐다면 접촉 불량이 발생할 수 있습니다."),
    ],
    WORK_TYPES[21]: [
        ("전용 회로 부재", "인덕션·전기레인지는 소비전력이 커서 전용 회로가 없으면 기존 회로에 부하가 몰릴 수 있습니다."),
        ("동시 사용 부하", "여러 화구를 동시에 사용하면 순간적으로 부하가 커져 차단기가 내려갈 수 있습니다."),
        ("배선·콘센트 용량", "기존 배선이나 콘센트가 인덕션의 소비전력을 감당하지 못하는 경우도 원인이 될 수 있습니다."),
    ],
    WORK_TYPES[22]: [
        ("설치 위치 전력 용량", "충전기는 지속적으로 높은 전력을 사용하므로, 설치 위치의 계약전력과 배선 용량이 충분한지 확인이 필요합니다."),
        ("배선 인입 경로", "주차 위치와 분전반 사이의 거리, 배선 인입 가능 여부가 설치 방식과 비용에 영향을 줍니다."),
        ("공동 설비와의 관계", "공동주택은 전체 전기 용량과 다른 세대 사용량을 함께 고려해야 하는 경우가 많습니다."),
    ],
    WORK_TYPES[23]: [
        ("점멸기·센서 고장", "옥외 조명은 점멸기나 조도 센서로 자동 작동하는 경우가 많아, 이 부품의 고장이 원인이 될 수 있습니다."),
        ("배선 방수 저하", "실외에 노출된 배선은 방수 성능이 떨어지면 빗물 유입으로 접속 불량이 생길 수 있습니다."),
        ("안정기·조명 소자 수명", "조명을 밝히는 안정기나 소자 자체의 수명이 다한 경우에도 점등 불량이 나타날 수 있습니다."),
    ],
    WORK_TYPES[24]: [
        ("산업용 배선 노후", "공장·창고의 배선은 사용 강도가 높아 일반 주거용보다 노후가 빨리 진행될 수 있습니다."),
        ("부하 집중", "특정 라인이나 설비에 전력 사용이 몰리면 해당 구간의 차단기·배선에 부담이 커질 수 있습니다."),
        ("분전반 용량 부족", "설비가 늘어나거나 교체되면서 기존 분전반 용량이 현재 사용량에 맞지 않을 수 있습니다."),
    ],
    WORK_TYPES[25]: [
        ("기존 콘센트의 방수 등급", "일반 콘센트는 습기에 취약해, 물 사용 공간에는 방수 등급 제품이 필요합니다."),
        ("설치 위치와 배선 경로", "방수 콘센트 설치 위치에 따라 기존 배선에서 분기할 수 있는지, 신규 배선이 필요한지가 달라집니다."),
        ("접지 상태", "습기 있는 공간의 콘센트는 접지 연결 여부가 안전에 특히 중요합니다."),
    ],
    WORK_TYPES[26]: [
        ("기존 배선 방식", "이전 시공 시 매립 대신 노출 방식으로 배선했다면, 매립 전환을 위해 벽체 작업이 필요할 수 있습니다."),
        ("벽체 구조", "건물 구조에 따라 매립이 가능한 부위와 어려운 부위가 나뉠 수 있어 사전 확인이 필요합니다."),
        ("배선 위치 변경 필요성", "인테리어 계획에 맞춰 콘센트나 스위치 위치를 바꾸려면 배선 경로도 함께 조정해야 합니다."),
    ],
    WORK_TYPES[27]: [
        ("중성선 유무", "일부 스마트 스위치는 중성선이 필요해, 기존 배선에 중성선이 없다면 별도 조치가 필요합니다."),
        ("기존 배선과의 호환성", "노후 배선이나 특정 방식으로 시공된 배선은 스마트 기기와 연동 시 추가 배선이 필요할 수 있습니다."),
        ("허브·통신 환경", "스마트 기기가 안정적으로 통신하려면 관련 허브나 신호 환경도 함께 고려해야 합니다."),
    ],
    WORK_TYPES[28]: [
        ("절연 성능 저하", "습기에 오래 노출된 배선은 절연 성능이 떨어지며 누전으로 이어질 수 있습니다."),
        ("금속 부품 부식", "콘센트, 스위치, 배관 등 금속 부품이 습기로 부식되면 접촉 불량이나 누전 위험이 커질 수 있습니다."),
        ("환기·배수 상태", "환기와 배수가 원활하지 않은 구조라면 습기가 누적되며 전기설비에 지속적인 영향을 줄 수 있습니다."),
    ],
    WORK_TYPES[29]: [
        ("전체 배선 계획 부재", "콘센트·조명·분전반 계획을 세우지 않고 진행하면 이후 재시공이 필요해질 수 있어 초기 계획이 중요합니다."),
        ("기존 배선과의 정합성", "신축·리모델링 시 기존 배선을 재사용할지, 새로 시공할지에 따라 공사 범위와 비용이 달라집니다."),
        ("분전반 용량", "늘어난 가전·설비를 고려해 분전반 용량을 함께 검토하지 않으면 완공 후 부족 문제가 생길 수 있습니다."),
    ],
}


GEN_PROCESS_STEP1_VARIANTS = [
    "먼저 {gu} {dong}의 {housing}에서 전기가 끊긴 범위를 구분합니다. 메인차단기까지 내려갔는지, 특정 분기차단기만 작동했는지, 또는 한두 곳의 콘센트만 문제가 있는지를 나누어 보면 확인 범위를 정하기가 쉬워집니다.",
    "가장 먼저 문제가 발생한 범위를 확인합니다. 집 전체에 영향이 있었는지, 아니면 일부 공간이나 회로에 국한된 문제였는지를 구분하는 것이 점검의 출발점이 됩니다.",
    "우선 증상이 한 번으로 끝났는지, 반복되고 있는지부터 구분합니다. 반복 여부에 따라 단순 일시적 현상인지, 원인을 찾아야 하는 상황인지가 달라지기 때문입니다.",
]

GEN_PROCESS_STEP2_VARIANTS = [
    "그다음 문제가 발생한 당시 사용하던 전기제품과 공간을 확인합니다. 에어컨·세탁기·전기온수기·인덕션 등 전력 사용이 큰 기기와 증상이 함께 나타났다면 해당 회로와 연결 상태를 별도로 살펴볼 필요가 있습니다.",
    "이후 증상이 발생한 시점에 사용 중이던 기기와 상황을 함께 확인합니다. 특정 제품 사용과 겹쳐서 반복된다면 그 기기와 연결된 회로부터 우선 살펴보는 것이 효율적입니다.",
    "그 다음으로는 여러 고전력 기기를 동시에 사용했을 때만 증상이 나타나는지를 확인합니다. 특정 조합에서만 반복된다면 과부하 쪽 가능성을, 조건 없이도 반복된다면 누전이나 접속 불량 쪽 가능성을 함께 열어두고 살펴봅니다.",
]

GEN_REPLACE_INTRO_VARIANTS = [
    "{cause_title} 부분이 노후되었거나 이상이 있다면 교체가 필요한 경우가 있습니다. 그러나 해당 부위만 교체하고 근본 원인을 그대로 두면 같은 증상이 반복될 수 있습니다.",
    "{cause_title}과(와) 관련된 부분에 이상이 있다면 단순 교체만으로 해결되지 않을 수 있습니다. 원인을 확인하지 않은 채 교체만 진행하면 증상이 다시 나타날 수 있습니다.",
]

GEN_REPLACE_CAUTION_VARIANTS = [
    "콘센트의 과열이나 탄화 흔적이 보이는 경우에는 콘센트만 바꾸기보다 연결된 전선과 접속부까지 확인하는 것이 좋습니다. 노후 전선이 의심되는 경우에도 전체를 무조건 교체하기보다 문제가 있는 구간과 주변 상태를 확인해 필요한 범위를 정하는 것이 현실적입니다.",
    "부분 교체만으로 증상이 해결되지 않는다면, 연결된 배선과 접속부의 상태까지 함께 확인해 필요한 작업 범위를 정하는 것이 안전합니다.",
]

GEN_POST_CHECK_VARIANTS = [
    "필요한 조치가 끝난 뒤에는 실제 사용 조건에서 차단기와 해당 회로가 정상적으로 유지되는지 확인하는 과정이 중요합니다. 일부 콘센트만 문제가 있었던 경우라면 해당 위치뿐 아니라 같은 분기회로에 연결된 다른 지점도 함께 확인하는 것이 좋습니다.",
    "작업 후에는 평소 사용하던 방식 그대로 며칠간 지켜보면서 같은 증상이 다시 나타나지 않는지 확인하는 것이 좋습니다.",
]

GEN_CAUTION_VARIANTS = [
    "문제가 사라졌더라도 같은 조건에서 다시 발생하는지 살펴보는 과정이 중요합니다. 차단기 동작 시간과 사용 중이던 기기를 기록해 두면 이후 점검에 도움이 될 수 있습니다.",
    "같은 증상이 다시 나타난다면 발생 시간과 당시 사용하던 기기, 전기가 끊긴 범위를 기록해 두면 다음 점검에서 원인을 좁히는 데 도움이 됩니다.",
]

# 유형별 "지금 바로 확인해야 할 응급 대응" — 순서가 있는 행동 목록
GEN_EMERGENCY_STEPS = {
    WORK_TYPES[0]: [
        "차단기가 반복해서 내려간다면 무리하게 계속 올리지 말고, 우선 사용 중이던 전기제품의 전원부터 뽑아둡니다.",
        "메인차단기까지 내려간 경우라면 분전반의 전체 스위치 상태를 확인하고, 무리해서 올리지 않습니다.",
        "타는 냄새나 스파크가 함께 느껴진다면 해당 회로는 사용을 멈추고 접근을 피합니다.",
        "물기가 있는 곳(욕실, 베란다 등)에서 증상이 나타났다면 마른 상태를 확인한 뒤에만 차단기를 조작합니다.",
        "연기나 불꽃이 계속된다면 즉시 안전을 확보하고 119에 신고한 뒤 접근하지 않습니다.",
    ],
    WORK_TYPES[1]: [
        "탄 냄새가 나는 즉시 해당 회로 사용을 멈추고, 가능하다면 메인차단기를 내려 전원을 차단합니다.",
        "분전반 커버를 임의로 열어 내부를 만지지 말고, 겉에서 보이는 변색·그을음 정도만 확인합니다.",
        "냄새가 나는 구간 주변은 환기가 가능한 범위에서 창문을 열어 환기합니다.",
        "연기가 보이거나 불꽃이 튄다면 즉시 119에 신고하고 분전반 근처로 다시 접근하지 않습니다.",
        "물기가 있는 상태에서는 절대 분전반이나 차단기를 만지지 않습니다.",
    ],
    WORK_TYPES[2]: [
        "문제가 되는 콘센트는 즉시 사용을 중지하고, 꽂혀 있던 플러그를 뽑아둡니다.",
        "스파크나 타는 냄새가 났다면 같은 콘센트에 다시 전원을 넣지 않습니다.",
        "콘센트 주변이 뜨겁거나 변색되어 있다면 손으로 직접 만지지 않습니다.",
        "연기나 지속적인 불꽃이 있다면 즉시 안전을 확보하고 119에 신고합니다.",
        "물기가 있는 곳이라면 마른 상태를 확인한 뒤에만 차단기를 조작합니다.",
    ],
    WORK_TYPES[3]: [
        "차단기가 반복적으로 작동한다면 무리하게 계속 올리지 말고 사용 중이던 기기 전원을 먼저 뽑습니다.",
        "차단기 외관이 심하게 변색되었거나 뜨겁다면 직접 만지지 않습니다.",
        "반복 작동이 짧은 간격으로 계속된다면 해당 회로 사용을 잠시 중단합니다.",
        "타는 냄새나 스파크가 동반된다면 즉시 안전을 확보하고 전문적인 확인을 받습니다.",
        "연기나 불꽃이 계속된다면 즉시 119에 신고한 뒤 접근하지 않습니다.",
    ],
    WORK_TYPES[4]: [
        "스위치를 눌러도 반응이 없다면 무리하게 여러 번 조작하지 말고 사용을 멈춥니다.",
        "조명 주변에서 타는 냄새나 열감이 느껴진다면 해당 회로 사용을 중단합니다.",
        "스위치나 조명 커버가 변색되었다면 직접 만지지 않고 접근을 피합니다.",
        "깜빡임이 심해지며 냄새까지 동반된다면 즉시 안전을 확보하고 전문적인 확인을 받습니다.",
        "물기가 있는 상태에서는 스위치나 조명기구를 만지지 않습니다.",
    ],
    WORK_TYPES[5]: [
        "정전된 공간의 전기제품 전원부터 뽑아 2차 피해를 예방합니다.",
        "벽이나 콘센트 주변에서 열감이나 냄새가 느껴진다면 해당 구간 사용을 멈춥니다.",
        "반복적인 정전이 짧은 간격으로 계속된다면 무리하게 차단기를 다시 올리지 않습니다.",
        "타는 냄새나 스파크가 동반된다면 즉시 안전을 확보하고 전문적인 확인을 받습니다.",
        "물기가 있는 상태에서는 분전반이나 콘센트를 만지지 않습니다.",
    ],
    WORK_TYPES[6]: [
        "차단기가 자주 내려간다면 우선 동시에 사용하는 고전력 기기 수를 줄여둡니다.",
        "무리한 증설 공사를 스스로 진행하지 말고 정식 절차를 통해 진행합니다.",
        "기존 배선 용량을 넘어서는 사용은 화재 위험으로 이어질 수 있어 임시로라도 사용을 조절합니다.",
        "타는 냄새나 발열이 동반된다면 즉시 안전을 확보하고 전문적인 확인을 받습니다.",
        "증설 전까지는 고전력 기기를 여러 회로에 나누어 사용합니다.",
    ],
    WORK_TYPES[7]: [
        "감전 위험이 의심되는 기기는 즉시 사용을 중단하고 전원을 뽑아둡니다.",
        "물기가 있는 공간에서 저릿함이 느껴졌다면 마른 상태를 확인한 뒤에만 접근합니다.",
        "접지 불량이 의심되는 상태에서는 해당 기기를 맨손으로 만지지 않습니다.",
        "감전 증상이 반복된다면 즉시 안전을 확보하고 전문적인 확인을 받습니다.",
        "가족이나 동거인에게도 해당 기기 사용을 잠시 자제하도록 안내합니다.",
    ],
    WORK_TYPES[8]: [
        "멀티탭이 뜨겁게 느껴진다면 즉시 사용을 중단하고 플러그를 뽑아둡니다.",
        "타는 냄새나 변색이 있었다면 같은 멀티탭을 다시 사용하지 않습니다.",
        "연기나 불꽃이 있었다면 즉시 안전을 확보하고 119에 신고합니다.",
        "감긴 상태의 연장선은 풀어서 방열이 되도록 한 뒤 사용 여부를 판단합니다.",
        "물기가 있는 곳에서는 멀티탭이나 연장선을 만지지 않습니다.",
    ],
    WORK_TYPES[9]: [
        "계량기나 인입선 주변에서 이상 소음·냄새가 느껴진다면 가까이 접근하지 않습니다.",
        "전기 공급이 불안정하다면 우선 고전력 기기 사용을 줄여둡니다.",
        "외부 인입선이 눈에 띄게 손상돼 보인다면 임의로 만지지 말고 전문적인 확인을 요청합니다.",
        "정전이 우리 집만이 아니라면 관리사무소나 한전에도 함께 상황을 알립니다.",
        "타는 냄새나 스파크가 동반된다면 즉시 안전을 확보하고 119에 신고합니다.",
    ],
    WORK_TYPES[10]: [
        "인터폰이 아예 안 되는 상황이라면 우선 방문자 확인을 다른 방식(전화 등)으로 대체합니다.",
        "단자함을 임의로 열어 배선을 만지지 않습니다.",
        "화면에서 스파크나 열감이 느껴진다면 전원을 차단하고 사용을 중단합니다.",
        "공동현관 인터폰 문제라면 관리사무소에도 함께 상황을 알립니다.",
    ],
    WORK_TYPES[11]: [
        "실제 화재 상황이 의심된다면 감지기 오작동 여부와 관계없이 즉시 대피를 우선합니다.",
        "경보기가 계속 울린다면 무리하게 분해하지 말고 관리사무소나 전문가에게 확인을 요청합니다.",
        "테스트 중이 아닌데 반복적으로 오작동한다면 해당 감지기 사용(신뢰)을 잠시 보류하고 점검을 받습니다.",
        "감지기 주변에서 실제 열감·연기가 느껴진다면 즉시 119에 신고합니다.",
    ],
    WORK_TYPES[12]: [
        "옥상·외부 설비 근처가 젖어 있다면 마른 상태를 확인한 뒤에만 접근합니다.",
        "스파크나 타는 냄새가 느껴진다면 해당 구역 접근을 피하고 즉시 안전을 확보합니다.",
        "우천 중에는 외부 전기설비 점검을 무리하게 진행하지 않습니다.",
        "감전 위험이 의심되면 즉시 119에 신고하고 접근을 통제합니다.",
    ],
    WORK_TYPES[13]: [
        "승강기 안에 갇힌 경우 비상벨이나 인터폰으로 즉시 연락을 취합니다.",
        "기계실 전기설비에서 이상이 감지되면 관리사무소와 전문 업체에 즉시 알립니다.",
        "정전 중에는 승강기 이용을 자제하고 계단을 이용합니다.",
        "타는 냄새나 스파크가 느껴진다면 즉시 안전을 확보하고 119에 신고합니다.",
    ],
    WORK_TYPES[14]: [
        "차단기가 반복해서 내려간다면 냉난방기 전원을 우선 뽑아둡니다.",
        "코드나 콘센트에서 열감·탄 냄새가 느껴지면 즉시 사용을 중단합니다.",
        "무리하게 차단기를 계속 올리지 않습니다.",
        "스파크나 연기가 있다면 즉시 안전을 확보하고 119에 신고합니다.",
    ],
    WORK_TYPES[15]: [
        "주차장 전기설비에서 스파크나 냄새가 느껴지면 즉시 접근을 피합니다.",
        "물이 고여 있는 구역의 전기설비는 마른 상태를 확인한 뒤에만 접근합니다.",
        "조명이 꺼져 어두운 경우 안전을 위해 우회 동선을 이용합니다.",
        "이상이 지속되면 관리사무소에 즉시 알립니다.",
    ],
    WORK_TYPES[16]: [
        "간판에서 스파크나 탄 냄새가 느껴지면 즉시 전원을 차단합니다.",
        "우천 중에는 간판 전기설비 점검을 무리하게 진행하지 않습니다.",
        "간판 주변 접근 시 감전 위험이 있다면 접근을 피합니다.",
        "화재 위험이 의심되면 즉시 119에 신고합니다.",
    ],
    WORK_TYPES[17]: [
        "인버터에서 이상 소음이나 열감이 느껴지면 전문가 확인 전까지 임의로 조작하지 않습니다.",
        "타는 냄새나 스파크가 있다면 즉시 안전을 확보하고 접근을 피합니다.",
        "우천 중에는 태양광 설비 점검을 무리하게 진행하지 않습니다.",
        "화재 위험이 의심되면 즉시 119에 신고합니다.",
    ],
    WORK_TYPES[18]: [
        "정전 시 발전기가 작동하지 않으면 무리하게 직접 조작하지 말고 관리자에게 알립니다.",
        "발전기 주변에서 연료 냄새나 이상 소음이 느껴지면 접근을 피합니다.",
        "발전기 연계 전기설비에서 스파크가 느껴지면 즉시 안전을 확보합니다.",
        "비상 상황이 지속되면 119나 전문 업체에 즉시 연락합니다.",
    ],
    WORK_TYPES[19]: [
        "배전반에서 열감이나 냄새가 느껴지면 즉시 사용을 중단하고 접근을 피합니다.",
        "배전반 문을 임의로 열어 내부를 만지지 않습니다.",
        "스파크나 연기가 있다면 즉시 안전을 확보하고 119에 신고합니다.",
        "배전반 근처 물건은 미리 치워 접근이 쉽도록 합니다.",
    ],
    WORK_TYPES[20]: [
        "차단기가 반복적으로 내려간다면 온수기 전원을 우선 뽑아둡니다.",
        "코드나 콘센트에서 열감·탄 냄새가 느껴지면 즉시 사용을 중단합니다.",
        "물기가 있는 상태에서는 온수기 전원부를 만지지 않습니다.",
        "스파크나 연기가 있다면 즉시 안전을 확보하고 119에 신고합니다.",
    ],
    WORK_TYPES[21]: [
        "차단기가 반복적으로 내려간다면 인덕션 전원을 우선 뽑아둡니다.",
        "코드나 콘센트에서 열감·탄 냄새가 느껴지면 즉시 사용을 중단합니다.",
        "무리하게 차단기를 계속 올리지 않습니다.",
        "스파크나 연기가 있다면 즉시 안전을 확보하고 119에 신고합니다.",
    ],
    WORK_TYPES[22]: [
        "충전 중 이상 소음이나 열감이 느껴지면 즉시 충전을 중단합니다.",
        "충전기 코드나 커넥터에서 스파크가 느껴지면 접근을 피합니다.",
        "우천 중에는 실외 충전기 사용에 특히 주의합니다.",
        "이상이 반복되면 즉시 안전을 확보하고 전문적인 확인을 받습니다.",
    ],
    WORK_TYPES[23]: [
        "옥외 조명이 꺼져 어두운 구간은 안전을 위해 우회 동선을 이용합니다.",
        "배선함에서 스파크나 냄새가 느껴지면 접근을 피합니다.",
        "우천 중에는 옥외 전기설비 점검을 무리하게 진행하지 않습니다.",
        "화재나 감전 위험이 의심되면 즉시 119에 신고합니다.",
    ],
    WORK_TYPES[24]: [
        "차단기가 반복해서 내려가면 가동 중인 설비를 우선 순차적으로 정지합니다.",
        "배전반에서 열감이나 냄새가 느껴지면 즉시 접근을 피합니다.",
        "스파크나 연기가 있다면 즉시 안전을 확보하고 119에 신고합니다.",
        "정전 시 위험 설비(회전체 등)는 즉시 전원 차단 여부를 확인합니다.",
    ],
    WORK_TYPES[25]: [
        "물기가 있는 상태에서 콘센트를 만지지 않습니다.",
        "기존 콘센트 주변에 습기 흔적이 있다면 사용을 자제하고 점검을 받습니다.",
        "감전 위험이 느껴지면 즉시 해당 콘센트 사용을 중단합니다.",
        "누전차단기가 함께 작동한다면 원인 확인 전까지 재사용을 피합니다.",
    ],
    WORK_TYPES[26]: [
        "노출 배선이 손상돼 있다면 임의로 만지지 말고 우선 사용을 중단합니다.",
        "배선 피복이 벗겨진 부분이 보이면 접근을 피하고 점검을 요청합니다.",
        "물기가 있는 곳의 노출 배선은 특히 주의합니다.",
        "감전 위험이 느껴지면 즉시 해당 구간 전원을 차단합니다.",
    ],
    WORK_TYPES[27]: [
        "스마트 스위치 설치 후 작동 이상이 있다면 무리하게 계속 조작하지 않습니다.",
        "배선 작업 중 이상이 발견되면 전원을 차단하고 확인을 요청합니다.",
        "기기에서 열감이나 냄새가 느껴지면 즉시 사용을 중단합니다.",
        "감전 위험이 느껴지면 즉시 해당 회로 전원을 차단합니다.",
    ],
    WORK_TYPES[28]: [
        "지하 공간이 침수되거나 물이 고인 상태라면 전기설비 근처 접근을 피합니다.",
        "습기 많은 곳의 콘센트·스위치는 마른 상태를 확인한 뒤에만 조작합니다.",
        "누전차단기가 반복 작동하면 무리하게 다시 올리지 않습니다.",
        "감전 위험이 느껴지면 즉시 해당 구역 전원을 차단합니다.",
    ],
    WORK_TYPES[29]: [
        "공사 중 노출된 배선은 함부로 만지지 않습니다.",
        "임시 전원을 사용하는 동안에도 물기 있는 곳에서는 주의합니다.",
        "스파크나 이상이 발견되면 즉시 작업을 중단하고 확인을 요청합니다.",
        "화재 위험이 의심되면 즉시 119에 신고합니다.",
    ],
}

# 유형별 재발 방지 예방 습관 (5개 중 4개 랜덤 추출)
GEN_PREVENTION_TIPS = {
    WORK_TYPES[0]: [
        "한 콘센트나 멀티탭에 전력 사용이 큰 기기를 몰아서 연결하지 않습니다.",
        "오래된 멀티탭이나 연장선은 정기적으로 상태를 확인하고 필요하면 교체합니다.",
        "차단기가 자주 작동하는 회로는 사용 패턴을 기록해 두면 다음 점검에 도움이 됩니다.",
        "습기가 많은 공간(욕실, 베란다 등)의 전기 사용은 특히 주의합니다.",
        "노후 주택이라면 배선과 분전반 상태를 주기적으로 점검하는 것이 좋습니다.",
    ],
    WORK_TYPES[1]: [
        "분전반 내부는 정기적으로 육안 점검해 변색이나 그을음이 없는지 확인합니다.",
        "특정 회로에 전력 사용이 몰리지 않도록 사용 패턴을 분산합니다.",
        "분전반 주변에 물건을 쌓아두지 않아 통풍이 잘 되도록 합니다.",
        "탄 냄새가 한 번이라도 있었다면 재발 여부를 주기적으로 확인합니다.",
        "노후 분전반은 교체 시점을 미리 점검해 두는 것이 안전합니다.",
    ],
    WORK_TYPES[2]: [
        "콘센트에 무리하게 여러 제품을 동시에 꽂지 않습니다.",
        "플러그를 꽂을 때 헐겁거나 뻑뻑한 느낌이 있으면 미리 점검합니다.",
        "콘센트 주변 온도나 변색 여부를 가끔씩 확인하는 습관을 들입니다.",
        "고전력 기기(전자레인지, 전기포트 등)는 가능하면 전용 콘센트를 사용합니다.",
        "오래된 콘센트는 사용 연수를 기록해 교체 시점을 판단합니다.",
    ],
    WORK_TYPES[3]: [
        "차단기 설치 연식을 확인해두고, 오래됐다면 교체 시점을 미리 점검합니다.",
        "가전제품이 늘어났다면 기존 차단기 용량이 충분한지 확인합니다.",
        "차단기가 자주 작동한다면 단순히 다시 올리기보다 원인을 함께 점검합니다.",
        "정기적으로 차단기 테스트 버튼을 눌러 정상 작동 여부를 확인합니다.",
        "노후 배선이 의심되면 차단기와 함께 배선 상태도 점검합니다.",
    ],
    WORK_TYPES[4]: [
        "조명이나 스위치의 사용 연한을 기록해 두면 교체 시점을 판단하기 쉽습니다.",
        "깜빡임이 잦아지면 완전히 고장 나기 전에 미리 점검을 받는 것이 좋습니다.",
        "한 스위치에 조명을 너무 많이 물리지 않도록 회로를 분산합니다.",
        "스위치 조작감이 평소와 다르게 느껴지면 초기에 확인해두는 것이 좋습니다.",
        "습기가 많은 공간의 조명·스위치는 방수 등급 제품 사용을 고려합니다.",
    ],
    WORK_TYPES[5]: [
        "정전이 반복되는 구간과 시점을 기록해 두면 원인 파악에 도움이 됩니다.",
        "오래된 배선은 정기적으로 상태를 점검받는 것이 안전합니다.",
        "리모델링 시 기존 배선을 그대로 재사용할지 함께 점검받는 것이 좋습니다.",
        "특정 회로에 사용이 몰리지 않도록 전기제품 배치를 분산합니다.",
        "정전이 잦은 구간은 완전히 고장 나기 전에 미리 점검받는 것이 좋습니다.",
    ],
    WORK_TYPES[6]: [
        "고전력 기기를 새로 들이기 전에 기존 배선 용량이 충분한지 미리 확인합니다.",
        "계약전력 사용량을 주기적으로 확인해 여유가 줄어드는지 살펴봅니다.",
        "증설이나 승압 계획이 있다면 미리 절차와 필요 서류를 확인해둡니다.",
        "가전 추가나 리모델링 계획이 있다면 전기 설비도 함께 재검토합니다.",
        "여러 고전력 기기를 한 회로에 몰아 쓰지 않도록 배치를 분산합니다.",
    ],
    WORK_TYPES[7]: [
        "습기 있는 공간의 전기 기기는 접지 상태를 주기적으로 확인합니다.",
        "리모델링 시 접지 공사가 함께 진행됐는지 확인해둡니다.",
        "감전과 관련된 이상 증상은 사소하더라도 초기에 점검받는 것이 안전합니다.",
        "오래된 건물이라면 접지 상태를 한 번쯤 전문적으로 확인받는 것이 좋습니다.",
        "새로운 전기기기 설치 시 접지 연결 여부를 함께 확인합니다.",
    ],
    WORK_TYPES[8]: [
        "멀티탭·연장선의 정격 용량을 확인하고 그 안에서만 사용합니다.",
        "감긴 상태로 장시간 사용하지 않고 필요한 만큼만 풀어서 씁니다.",
        "오래된 멀티탭은 정기적으로 교체 시점을 점검합니다.",
        "고전력 기기는 가능하면 벽면 콘센트에 직접 연결합니다.",
        "정품 인증 제품인지 확인하고 사용하는 것이 안전합니다.",
    ],
    WORK_TYPES[9]: [
        "계량기와 인입선 주변 상태를 가끔씩 육안으로 확인합니다.",
        "전기 공급 이상이 반복되면 초기에 한전이나 관리사무소에 문의해둡니다.",
        "노후 건물이라면 인입선 상태를 한 번쯤 점검받는 것이 좋습니다.",
        "정전이나 공급 불안정이 있었던 시점과 상황을 기록해 둡니다.",
        "공용 설비와 관련된 문제는 개별 대응보다 관리 주체와 함께 확인하는 것이 좋습니다.",
    ],
    WORK_TYPES[10]: [
        "인터폰 설치 연식을 기록해 두면 교체 시점 판단에 도움이 됩니다.",
        "화면이나 음성에 미세한 이상이 있다면 초기에 점검받는 것이 좋습니다.",
        "단자함 주변에 물건을 쌓아두지 않아 통풍과 접근이 쉽도록 합니다.",
        "공동 설비라면 관리사무소와 점검 이력을 공유해두는 것이 좋습니다.",
    ],
    WORK_TYPES[11]: [
        "정기적으로 테스트 버튼을 눌러 정상 작동 여부를 확인합니다.",
        "배터리형 감지기는 배터리 교체 주기를 기록해 둡니다.",
        "감지기 주변 먼지를 주기적으로 제거합니다.",
        "설치 연식이 오래됐다면 전체 교체 시점을 점검받는 것이 좋습니다.",
    ],
    WORK_TYPES[12]: [
        "옥상·외부 배선함의 방수 상태를 계절이 바뀔 때마다 확인합니다.",
        "외부 배선은 자외선·기온 변화에 강한 자재로 정기적으로 점검·교체합니다.",
        "우천 전후로 이상 징후가 있었는지 기록해 둡니다.",
        "노후 건물이라면 외부 설비 전체 점검을 주기적으로 받는 것이 좋습니다.",
    ],
    WORK_TYPES[13]: [
        "승강기 전기설비는 정기 유지보수 일정에 맞춰 점검받습니다.",
        "기계실 분전반 상태를 주기적으로 육안 점검합니다.",
        "비상용 배터리 작동 여부를 정기적으로 테스트합니다.",
        "이상 소음이나 조명 깜빡임은 초기에 점검을 요청합니다.",
    ],
    WORK_TYPES[14]: [
        "고전력 냉난방기는 설치 전에 전용 회로 필요 여부를 미리 확인합니다.",
        "여름·겨울철 사용 전 코드와 콘센트 상태를 점검합니다.",
        "다른 고전력 가전과 같은 회로에서 동시 사용을 피합니다.",
        "노후 배선이 의심되면 냉난방기 설치와 함께 배선도 점검받습니다.",
    ],
    WORK_TYPES[15]: [
        "주차장 전기설비는 정기적으로 육안 점검합니다.",
        "습기가 많은 구역은 배수·환기 상태도 함께 확인합니다.",
        "센서등 작동 여부를 주기적으로 테스트합니다.",
        "노후 배선은 미리 교체 계획을 세워두는 것이 안전합니다.",
    ],
    WORK_TYPES[16]: [
        "간판 조명은 정기적으로 점등 상태를 확인합니다.",
        "외부 배선의 방수 상태를 계절마다 점검합니다.",
        "안정기 수명을 기록해 두고 교체 시점을 관리합니다.",
        "설치 후 오래됐다면 전체 점검을 한 번 받아보는 것이 좋습니다.",
    ],
    WORK_TYPES[17]: [
        "태양광 설비는 정기적으로 발전량 추이를 확인합니다.",
        "인버터 상태를 주기적으로 점검받습니다.",
        "패널 오염 여부를 계절마다 확인합니다.",
        "설치 후 일정 주기로 전문 점검을 받는 것이 좋습니다.",
    ],
    WORK_TYPES[18]: [
        "발전기는 정기적으로 시운전 테스트를 진행합니다.",
        "절체 스위치의 자동 전환 기능을 주기적으로 점검합니다.",
        "연료·배터리 상태를 정기적으로 확인합니다.",
        "연계 배선의 노후 여부를 주기적으로 점검받습니다.",
    ],
    WORK_TYPES[19]: [
        "배전반은 정기적으로(보통 6개월~1년) 전문 점검을 받습니다.",
        "배전반 주변에 물건을 쌓아두지 않습니다.",
        "전력 사용량이 늘었다면 배전반 여유 용량도 함께 점검받습니다.",
        "점검 이력을 기록해 두면 다음 점검 시 비교에 도움이 됩니다.",
    ],
    WORK_TYPES[20]: [
        "고전력 온수기는 설치 전 전용 배선 필요 여부를 미리 확인합니다.",
        "코드와 콘센트 상태를 정기적으로 점검합니다.",
        "다른 고전력 가전과 동시 사용을 피합니다.",
        "노후 배선이 의심되면 온수기 설치와 함께 배선도 점검받습니다.",
    ],
    WORK_TYPES[21]: [
        "고전력 인덕션은 설치 전 전용 회로 필요 여부를 미리 확인합니다.",
        "여러 화구 동시 사용 시 소비전력 총합을 염두에 둡니다.",
        "코드와 콘센트 상태를 정기적으로 점검합니다.",
        "노후 배선이 의심되면 인덕션 설치와 함께 배선도 점검받습니다.",
    ],
    WORK_TYPES[22]: [
        "설치 전 전력 용량과 배선 경로를 충분히 검토합니다.",
        "공동주택이라면 관리사무소와 사전 협의를 진행합니다.",
        "충전기 상태를 정기적으로 점검합니다.",
        "우천이나 결빙 시 충전기 주변 안전 상태를 확인합니다.",
    ],
    WORK_TYPES[23]: [
        "옥외 조명은 정기적으로 점등 상태를 확인합니다.",
        "점멸기·센서의 작동 여부를 주기적으로 테스트합니다.",
        "실외 배선의 방수 상태를 계절마다 점검합니다.",
        "고장이 잦은 구간은 배선 자체 교체를 검토합니다.",
    ],
    WORK_TYPES[24]: [
        "창고·공장 전기설비는 정기적으로(보통 6개월~1년) 전문 점검을 받습니다.",
        "설비 증설 계획이 있다면 미리 배선·분전반 용량을 검토합니다.",
        "부하가 몰리는 라인은 사용 패턴을 기록해 관리합니다.",
        "노후 건물이라면 전체 배선 상태를 한 번쯤 점검받는 것이 좋습니다.",
    ],
    WORK_TYPES[25]: [
        "물 사용 공간에는 처음부터 방수 등급 콘센트를 설치합니다.",
        "습기 있는 공간의 콘센트는 정기적으로 상태를 확인합니다.",
        "접지 연결 여부를 설치 시점에 함께 확인합니다.",
        "리모델링 시 방수 콘센트 위치를 미리 계획해둡니다.",
    ],
    WORK_TYPES[26]: [
        "인테리어 계획 초기에 배선 매립 여부를 함께 검토합니다.",
        "노출 배선은 정기적으로 피복 상태를 확인합니다.",
        "매립 공사 후에도 배선 위치를 도면으로 기록해두면 이후 관리에 도움이 됩니다.",
        "습기 있는 공간의 배선은 매립 시 방수 처리를 함께 고려합니다.",
    ],
    WORK_TYPES[27]: [
        "스마트 기기 설치 전 배선 조건(중성선 등)을 미리 확인합니다.",
        "설치 계획을 전체적으로 세운 뒤 한 번에 정비하는 것이 효율적입니다.",
        "설치 후에도 정기적으로 작동 상태를 확인합니다.",
        "허브·통신 환경도 함께 점검해 안정성을 유지합니다.",
    ],
    WORK_TYPES[28]: [
        "지하 공간은 정기적으로 환기해 습기 누적을 줄입니다.",
        "배선·콘센트 상태를 계절마다(특히 장마 전후) 점검합니다.",
        "부식이 시작된 부품은 초기에 교체하는 것이 안전합니다.",
        "배수 상태를 함께 점검해 침수 위험을 줄입니다.",
    ],
    WORK_TYPES[29]: [
        "공사 전 전체 배선·분전반 계획을 미리 세워둡니다.",
        "가전·설비 계획을 반영해 여유 있는 용량으로 설계합니다.",
        "시공 후 도면을 남겨두면 이후 유지보수에 도움이 됩니다.",
        "정기 점검 계획도 함께 세워두는 것이 좋습니다.",
    ],
}


# FAQ 풀 (질문, 답변) — 유형 공통으로 4개를 랜덤 추출해 사용
GEN_FAQ_POOL = [
    ("차단기만 교체하면 해결되나요?", "차단기 자체의 문제일 수도 있지만 누전, 과부하, 배선이나 접속부 이상이 원인일 수도 있습니다. 원인 범위를 확인한 뒤 필요한 작업을 결정하는 것이 좋습니다."),
    ("차단기가 한 번 내려갔다가 다시 올라가면 괜찮은가요?", "일시적인 상황일 수도 있지만 같은 조건에서 반복되는지 확인하는 것이 좋습니다. 반복된다면 사용을 줄이고 발생 시간과 상황을 기록해 점검에 활용하는 것이 좋습니다."),
    ("콘센트에서 스파크나 타는 냄새가 나면 어떻게 해야 하나요?", "해당 콘센트 사용을 중지하고 반복해서 전원을 넣지 않는 것이 안전합니다. 연기나 지속적인 불꽃이 있다면 즉시 안전을 확보하고 전문적인 확인을 받아야 합니다."),
    ("직접 차단기를 만져서 점검해도 되나요?", "간단히 올리고 내리는 정도는 가능하지만, 분전반 내부를 직접 열어 배선을 만지는 것은 위험할 수 있어 권장하지 않습니다."),
    ("야간이나 주말에도 점검이 필요한가요?", "상황에 따라 다르지만, 전기 문제가 반복되거나 안전이 우려되는 경우에는 시간에 관계없이 확인이 필요할 수 있습니다."),
    ("냄새가 잠깐 났다가 사라졌는데 계속 써도 되나요?", "냄새가 사라졌다고 원인까지 사라진 것은 아닙니다. 같은 조건에서 다시 나타나는지 며칠 지켜보고, 반복된다면 점검을 받는 것이 안전합니다."),
    ("비 오는 날에만 증상이 나타나는데 원인이 뭘까요?", "습기와 관련된 누전 가능성을 먼저 의심할 수 있습니다. 젖은 곳 근처의 배선이나 콘센트 상태를 함께 확인하는 것이 좋습니다."),
    ("분전반은 얼마나 자주 점검받는 게 좋은가요?", "특별한 이상이 없더라도 보통 6개월에서 1년 주기로 한 번씩 점검받는 것이 권장됩니다. 노후 건물이라면 주기를 조금 더 짧게 잡는 것도 방법입니다."),
    ("손을 대기 어려울 정도로 뜨거우면 어떻게 해야 하나요?", "플러그를 급하게 뽑기보다, 먼저 분전반의 해당 차단기를 내려 전원을 차단하는 것이 안전합니다. 전원이 살아있는 상태에서 무리하게 뽑으면 스파크가 튈 수 있습니다."),
    ("누전인지 과부하인지 집에서 구분할 수 있나요?", "정확한 구분은 장비로 측정해야 하지만, 여러 기기를 동시에 켰을 때만 내려간다면 과부하 쪽에 가깝고, 특정 조건 없이도 반복된다면 누전 가능성을 함께 살펴볼 필요가 있습니다."),
    ("셀프로 원인을 어느 정도까지 확인해볼 수 있나요?", "전기제품을 하나씩 분리해보며 어떤 기기와 관련 있는지 정도는 확인해볼 수 있습니다. 다만 분전반 내부 배선이나 절연 상태 확인은 전문 장비가 필요해 직접 하기는 어렵습니다."),
    ("멀티탭 하나에 여러 기기를 꽂아 쓰는 게 문제가 되나요?", "멀티탭 자체보다는 거기 연결된 기기들의 총 소비전력이 문제가 됩니다. 고전력 기기(전자레인지, 헤어드라이기 등)를 한 멀티탭에 몰아 쓰면 과부하로 이어지기 쉽습니다."),
    ("차단기를 용량이 큰 것으로 바꾸면 해결되나요?", "차단기 용량만 키우면 순간적으로는 안 내려갈 수 있지만, 배선이 감당할 수 있는 용량을 넘기면 오히려 위험할 수 있습니다. 전체 배선 상태를 함께 확인하는 것이 안전합니다."),
    ("전기요금이 갑자기 늘어난 것도 전기 문제와 관련 있나요?", "직접적인 관련은 크지 않은 경우가 많지만, 드물게 누전으로 인해 전력이 새는 경우 요금에 영향을 줄 수도 있습니다. 사용량 변화가 없는데 요금만 늘었다면 함께 확인해볼 만합니다."),
    ("반려동물이 전선을 물어뜯은 것 같은데 어떻게 해야 하나요?", "노출된 배선은 감전이나 화재 위험이 있어 직접 만지지 말고 해당 회로 차단기부터 내려두는 것이 안전합니다. 이후 손상된 구간만 확인해 교체받는 것이 좋습니다."),
    ("오래된 아파트라 전체 배선을 다 바꿔야 하나요?", "증상이 특정 회로에만 국한된다면 전체 교체 없이 해당 구간만 손보는 경우가 많습니다. 다만 노후도가 심하면 부분 수리보다 전체 점검을 권하기도 합니다."),
    ("낮에는 괜찮다가 밤에만 증상이 나타나요, 왜 그런가요?", "야간에 냉난방기·조명 등 사용 기기가 몰리면서 순간 부하가 커지는 경우가 흔합니다. 어떤 기기를 켰을 때 증상이 나타나는지 시간대별로 기록해두면 원인 파악에 도움이 됩니다."),
    ("전기 기사님이 오시기 전에 미리 준비할 게 있나요?", "증상이 나타난 시간, 그때 사용 중이던 기기, 반복 빈도를 메모해두시면 현장 확인 시간이 줄어듭니다. 가능하면 분전반 주변 물건도 미리 치워두시면 좋습니다."),
    ("임차인인데 집주인 동의 없이 수리를 진행해도 되나요?", "구조 변경이 아닌 단순 고장 수리는 보통 세입자가 먼저 처리하고 비용을 협의하는 경우가 많지만, 계약 조건에 따라 다를 수 있어 미리 집주인과 상의하는 것이 안전합니다."),
    ("점검 후에도 같은 증상이 재발하면 어떻게 하나요?", "재발 시점과 상황을 기록해두고 다시 연락하시면, 이전 점검 내용을 바탕으로 원인을 좁혀서 확인할 수 있습니다. 대부분 업체는 일정 기간 재점검을 지원합니다."),
    ("에어컨 설치 후부터 증상이 시작됐는데 관련 있을까요?", "고전력 기기 신설로 기존 회로의 부하가 늘어난 경우일 수 있습니다. 설치 시점과 증상 시작 시점이 겹친다면 해당 회로 용량을 함께 확인해보는 것이 좋습니다."),
]

# =========================================================
# 제목 생성 — 완성 문장을 고르는 대신 여러 "단어은행"을 조합해서
# 만듭니다. 재료 풀을 크게 늘리고, 모든 조합이 최소 2개 재료를
# 함께 쓰도록 강제해서 조합 가짓수를 수천 단위로 키웠습니다.
# 이러면 지역이 수백 곳, 사례가 수천 건이어도 뒷문구가 완전히
# 똑같이 겹치는 경우가 훨씬 드물어집니다.
# 앞머리는 항상 "{구} {동} 차단기 내려감,"으로 고정합니다.
# =========================================================

# 대상(거주 형태/가구 유형) 재료
GEN_TITLE_AUDIENCE_POOL = [
    "아파트", "빌라",
    "1인 가구", "신혼부부 세대", "반려동물 있는 집", "아이 있는 집",
    "재택근무 중인 집", "어르신이 계신 집", "세입자", "자가 소유주",
    "신축 입주 세대", "노후 주택", "신혼집", "학생 자취방", "다가구주택",
    "리모델링한 집", "전세로 들어온 집", "월세로 사는 집",
    "1층 세대", "고층 세대", "복층 구조 집",
]

# 시간·계절·상황 재료
GEN_TITLE_TIME_POOL = [
    "새벽 시간대", "한밤중", "장마철", "한여름 냉방기 사용철",
    "겨울철 난방기 사용철", "외출 중", "주말", "평일 출근 시간대",
    "환절기", "명절 연휴 기간", "휴가철", "이른 아침",
    "퇴근 직후", "취침 직전", "손님 초대한 날", "제사·명절 음식 준비 중",
    "재택근무 하는 낮 시간", "학교·회사 다녀온 저녁",
]

# 원인·행동 재료
GEN_TITLE_CAUSE_HINT_POOL = [
    "특정 콘센트 사용 시", "에어컨과 다른 가전 동시 사용 시",
    "멀티탭 여러 개 꽂아 쓸 때", "세탁기·건조기 함께 돌릴 때",
    "전자레인지나 전기포트 사용 시", "충전기 여러 개 동시에 꽂을 때",
    "인덕션 사용 중", "헤어드라이기 사용 중", "김치냉장고 함께 돌릴 때",
    "전기장판 켜둔 채로", "가습기·제습기 같이 쓸 때", "믹서기·에어프라이어 사용 시",
]

# 뒷문구 "틀". 모든 틀이 최소 2개 재료(대상/시간/원인 중 2가지)를
# 함께 써서, 한 가지 재료만으로 생기는 좁은 조합 공간을 피합니다.
# {audience_igo}/{audience_ramyeon} 처럼 "_igo"(~이고), "_ramyeon"
# (~이라면/라면) 붙은 자리는 받침 유무에 따라 자동으로 "이고/고",
# "이라면/라면"을 붙인 완성형 문자열이 미리 들어갑니다(문법 자연스럽게).
GEN_TITLE_VARIABLE_STRUCTURES = [
    "{audience}에서 {time}에 반복된다면",
    "{audience}, {cause} 반복된다면",
    "{time}에 {cause} 겹치면 특히 주의하세요",
    "{audience_igo} {time}인 경우, 확인이 필요합니다",
    "{audience}에서 {cause} 겪으셨다면 확인할 부분",
    "{audience} 거주자가 {time}에 확인해야 할 부분",
    "{audience}에서 {cause} 유독 심하다면",
    "{time}, {audience_ramyeon} 더 위험할 수 있습니다",
    "{cause}, {time}에 반복된다면 원인 짚어보기",
    "{audience} 전기수리 사례로 보는 {cause} 원인",
]

# 그 자체로는 변수가 없는 "핵심 문구"들입니다. 이 문구들은 절대
# 단독으로 쓰지 않고, 아래 build_random_title_ending()에서 항상
# 서로 다른 종류의 재료 2개를 무작위로 앞에 붙여서만 사용합니다.
GEN_TITLE_CORE_PHRASES = [
    "원인과 조치",
    "언제부터 이상 징후였는지 되짚어 보는 체크포인트",
    "생활 패턴이 바뀐 뒤 전기 사용도 달라졌다면",
    "안전은 습관에서 시작된다는 전기 관리 이야기",
    "신축 입주 전 미리 알아두면 좋은 전기 점검 안내",
    "위층 아래층 모두 꺼지는 상황 분석",
    "자가진단 체크리스트",
    "노후 차단기 교체 시점 판단법",
    "이사 온 지 얼마 안 됐다면 확인할 것",
    "그냥 두면 안 되는 이유",
    "무조건 한 가지 원인은 아닙니다",
    "셀프로 확인 가능한 부분과 아닌 부분",
    "반복될 때 집에서 먼저 확인할 기준",
    "며칠째 같은 증상이라면 짚어봐야 할 부분",
    "방치하면 안 되는 신호일 수 있습니다",
]

# 핵심 문구 앞에 붙일 "한정어 두 개" 연결 방식들 (서로 다른 종류
# 재료 2개를 함께 붙여 조합 수를 크게 늘립니다). q1/q2 자리에는
# 대상·시간·원인 재료가 랜덤으로 들어가므로, 특정 재료 종류에만
# 맞는 조사("~에서" 등)는 쓰지 않고 항상 자연스러운 형태만 씁니다.
GEN_TITLE_QUALIFIER_CONNECTORS = [
    "{q1}, {q2_ramyeon} — {core}",
    "{q1_igo} {q2}인 경우, {core}",
    "{q1}, {q2} 겹칠 때 — {core}",
    "{q1}, {q2} 상황이라면 — {core}",
]

_GEN_TITLE_POOLS_BY_KIND = None


def _get_gen_title_pools_by_kind():
    global _GEN_TITLE_POOLS_BY_KIND
    if _GEN_TITLE_POOLS_BY_KIND is None:
        _GEN_TITLE_POOLS_BY_KIND = {
            "audience": GEN_TITLE_AUDIENCE_POOL,
            "time": GEN_TITLE_TIME_POOL,
            "cause": GEN_TITLE_CAUSE_HINT_POOL,
        }
    return _GEN_TITLE_POOLS_BY_KIND


def _korean_has_batchim(word):
    """
    한글 단어의 마지막 글자에 받침이 있는지 확인합니다.
    (받침 유무에 따라 "이라면/라면", "이고/고"를 자연스럽게 다르게
    붙이기 위해 씁니다. 예: "기간" → 받침 있음 → "기간이라면"(O),
    "기간라면"(X). "빌라" → 받침 없음 → "빌라라면"(O).)
    """
    if not word:
        return False
    last_char = word[-1]
    code = ord(last_char)
    if 0xAC00 <= code <= 0xD7A3:  # 완성형 한글 음절 범위
        return (code - 0xAC00) % 28 != 0
    return False  # 한글이 아니면(숫자 등) 안전하게 받침 없음으로 처리


def _josa_ramyeon(word):
    """~이라면 / ~라면 을 받침 유무에 맞게 자동으로 붙입니다."""
    return word + ("이라면" if _korean_has_batchim(word) else "라면")


def _josa_igo(word):
    """~이고 / ~고 를 받침 유무에 맞게 자동으로 붙입니다."""
    return word + ("이고" if _korean_has_batchim(word) else "고")


def build_random_title_ending():
    """
    뒷문구를 만듭니다.
    - 60% 확률: 이미 두 가지 재료가 함께 들어있는 틀
      (GEN_TITLE_VARIABLE_STRUCTURES)을 골라서 채웁니다.
    - 40% 확률: 변수 없는 핵심 문구(GEN_TITLE_CORE_PHRASES)를 고르되,
      서로 다른 종류의 재료 2개를 무작위로 앞에 붙여서만 사용합니다
      (핵심 문구가 맨몸으로 나가는 경우는 없습니다).
    재료 풀 자체도 크게 늘려서(대상 26개·시간 18개·원인 12개),
    같은 뒷문구가 서로 다른 동에서 완전히 똑같이 나올 확률이
    실질적으로 매우 낮아집니다. "~라면/이라면", "~고/이고"는 받침
    유무를 자동 판별해서 항상 자연스러운 조사로 붙습니다.
    """
    pools = _get_gen_title_pools_by_kind()

    if random.random() < 0.6:
        structure = random.choice(GEN_TITLE_VARIABLE_STRUCTURES)
        fmt = {}
        if "{audience" in structure:
            a = random.choice(pools["audience"])
            fmt["audience"] = a
            fmt["audience_igo"] = _josa_igo(a)
            fmt["audience_ramyeon"] = _josa_ramyeon(a)
        if "{time" in structure:
            t = random.choice(pools["time"])
            fmt["time"] = t
            fmt["time_igo"] = _josa_igo(t)
            fmt["time_ramyeon"] = _josa_ramyeon(t)
        if "{cause" in structure:
            c = random.choice(pools["cause"])
            fmt["cause"] = c
            fmt["cause_igo"] = _josa_igo(c)
            fmt["cause_ramyeon"] = _josa_ramyeon(c)
        return structure.format(**fmt)

    core = random.choice(GEN_TITLE_CORE_PHRASES)

    connector = random.choice(GEN_TITLE_QUALIFIER_CONNECTORS)

    # 연결 방식마다 자연스러운 재료 조합이 다릅니다.
    # - "~인 경우": 원인 재료(예: "전기포트 사용 시")가 걸리면
    #   "사용 시인 경우"("시인"=시를 쓰는 사람)처럼 엉뚱해지므로
    #   대상·시간 재료만 씁니다.
    # - "~겹칠 때", "~상황이라면": "겹치다/상황"은 시간·원인처럼
    #   "조건"끼리 맞물릴 때만 자연스럽고("장마철에 냉방기 사용
    #   겹치면"), "월세로 사는 집, 휴가철 겹칠 때"처럼 집 종류(대상
    #   재료)가 섞이면 어색해지므로 시간·원인 재료만 씁니다.
    if "인 경우" in connector:
        allowed_kinds = ["audience", "time"]
    elif "겹칠 때" in connector or "상황이라면" in connector:
        allowed_kinds = ["time", "cause"]
    else:
        allowed_kinds = ["audience", "time", "cause"]

    kind1, kind2 = random.sample(allowed_kinds, k=2)
    q1 = random.choice(pools[kind1])
    q2 = random.choice(pools[kind2])

    return connector.format(
        q1=q1, q2=q2, core=core,
        q1_igo=_josa_igo(q1), q1_ramyeon=_josa_ramyeon(q1),
        q2_igo=_josa_igo(q2), q2_ramyeon=_josa_ramyeon(q2),
    )


# 제목 맨 앞 "{구} {동}" 바로 뒤에 붙는 핵심 키워드 재료입니다.
# 이걸 랜덤으로 골라서 "차단기 내려감"으로만 고정되지 않게 합니다.
GEN_TITLE_KEYWORD_POOL = [
    "차단기 내려감",
    "차단기 자꾸 내려감",
    "차단기 레버 부러짐",
    "차단기 안 올라감",
    "메인차단기 내려감",
    "누전차단기 오작동",
    "두꺼비집 떨어짐",
    "두꺼비집 내려감",
    "두꺼비집 안 올라감",
    "분전반 차단기 고장",
    "콘센트 스파크",
    "콘센트 타는 냄새",
    "전기 끊김",
    "정전",
    "전기 수리 기사",
    "24시 전기수리업체",
    "긴급 전기수리",
    "누전수리 업체",
    "전기누전 점검",
    # 화재·탄화·계량기·인입선 관련 키워드
    "전기 화재",
    "배선 탄화",
    "콘센트 탄화",
    "분전반 화재",
    "분전반 탄화",
    "계량기 차단기 화재",
    "계량기 인입선 화재",
    "계량기 인입선 화재 끊김",
    "한전인입선 전선 화재",
    "한전인입선 화재",
]

# 작업유형(work_type)마다 실제 본문 내용과 어울리는 제목 키워드만
# 골라 쓰도록 30개 전부 하나하나 연결해둔 표입니다. 이 표가 없으면
# 제목 앞머리가 전체 키워드 풀에서 완전히 무작위로 뽑혀서, 본문은
# "인터폰 고장" 얘기인데 제목은 "계량기 인입선 화재"처럼 제목과
# 내용이 아예 안 맞는 글이 나올 수 있습니다. WORK_TYPES 30개
# 전부(무작위 선택에서 제외된 비상발전기 포함) 빠짐없이 매핑해뒀고,
# 혹시 나중에 새 work_type이 추가되는 경우에만 대비해
# GEN_TITLE_KEYWORD_DEFAULT_POOL(범용 문구)을 예비로 남겨둡니다.
GEN_TITLE_KEYWORD_DEFAULT_POOL = [
    "전기 수리 기사",
    "24시 전기수리업체",
    "긴급 전기수리",
    "누전수리 업체",
    "전기누전 점검",
]

GEN_TITLE_KEYWORD_MAP_BY_WORK_TYPE = {
    # 0. 차단기 내려감 누전 수리 및 원인 점검
    # ★ "차단기 내려감"류 표현을 웬만하면 우선적으로 쓰되(네이버가
    # 완전히 똑같은 문구만 계속 노출되는 것도 어뷰징으로 보기 때문에),
    # 나머지 변형 표현들도 섞어서 다양성을 확보합니다. random.choice는
    # 리스트 안에 같은 문구가 여러 번 들어있을수록 더 자주 뽑히는
    # 성질을 이용해, "차단기 내려감" 계열을 더 두껍게(가중치를 높게)
    # 넣어뒀습니다. 특정 문구 하나만 고정해서 쓰지는 않습니다.
    WORK_TYPES[0]: [
        "차단기 내려감", "차단기 내려감", "차단기 내려감", "차단기 내려감", "차단기 내려감", "차단기 내려감", "차단기 내려감",
        "차단기 자꾸 내려감", "차단기 자꾸 내려감",
        "메인차단기 내려감", "메인차단기 내려감",
        "차단기 수시로 내려감",
        "차단기 안 올라감", "차단기 안 올라감",
        "차단기 다시 안 올라감",
        "두꺼비집 떨어짐", "두꺼비집 떨어짐",
        "두꺼비집 내려감",
        "두꺼비집 안 올라감",
        "두꺼비집 떨어져서 안 올라감",
        "차단기 레버 부러짐",
        "차단기 고장 교체",
        "누전차단기 오작동",
        "차단기 자주 떨어짐",
        # ★ 전화 문의로 바로 이어지는 "서비스형" 키워드 — 증상 설명보다
        # "누가 봐도 업체에 연락해야 할 것 같다"는 느낌을 주는 문구들.
        # 이런 키워드는 스토리보다 상담·점검 자체를 앞세워 전화 전환을
        # 노립니다.
        "24시전기수리업체", "24시전기수리업체",
        "전기기사",
        "전업사",
        "누전점검", "누전점검",
        "누전검사",
        "누전수리",
        "누전공사",
        "전등누전수리",
    ],
    # 1. 분전반(두꺼비집) 탄화 및 탄 냄새 교체 수리
    WORK_TYPES[1]: ["두꺼비집 떨어짐", "두꺼비집 내려감", "두꺼비집 안 올라감", "분전반 차단기 고장", "분전반 화재", "분전반 탄화"],
    # 2. 특정 콘센트 쇼트 및 차단기 떨어짐 점검
    WORK_TYPES[2]: ["콘센트 스파크", "콘센트 타는 냄새", "콘센트 탄화", "차단기 내려감"],
    # 3. 노후 누전차단기 교체 및 전열 회로 수리
    WORK_TYPES[3]: ["차단기 안 올라감", "차단기 레버 부러짐", "누전차단기 오작동", "메인차단기 내려감"],
    # 4. 조명 및 스위치 고장 점검 및 교체
    WORK_TYPES[4]: ["조명 안 켜짐", "스위치 고장", "형광등 깜빡임", "조명 스위치 고장"],
    # 5. 배선 노후로 인한 부분 정전 점검
    WORK_TYPES[5]: ["배선 노후", "전기 끊김", "부분 정전", "배선 탄화"],
    # 6. 전기 증설 및 승압 공사 상담
    WORK_TYPES[6]: ["전기 증설", "전기 승압 공사", "계약전력 증설"],
    # 7. 접지 불량 및 감전 위험 점검
    WORK_TYPES[7]: ["접지 불량", "감전 위험", "누전 감전"],
    # 8. 멀티탭·연장선 과부하 및 발열 점검
    WORK_TYPES[8]: ["멀티탭 과열", "콘센트 타는 냄새", "멀티탭 발열"],
    # 9. 계량기·인입선 이상 및 전기 공급 점검
    WORK_TYPES[9]: ["계량기 차단기 화재", "계량기 인입선 화재", "계량기 인입선 화재 끊김", "한전인입선 전선 화재", "한전인입선 화재"],
    # 10. 인터폰·초인종 고장 점검 및 수리
    WORK_TYPES[10]: ["인터폰 고장", "초인종 고장", "인터폰 먹통"],
    # 11. 화재감지기·경보기 오작동 점검
    WORK_TYPES[11]: ["화재감지기 오작동", "화재경보기 오작동", "화재감지기 오류"],
    # 12. 옥상·외부 전기설비 누전 점검
    WORK_TYPES[12]: ["옥상 전기설비 누전", "외부 전기설비 누전", "옥외 배선 누전"],
    # 13. 승강기 전기설비 점검
    WORK_TYPES[13]: ["승강기 전기설비 고장", "엘리베이터 정전", "승강기 전기점검"],
    # 14. 냉난방기 전용 회로 신설 공사
    WORK_TYPES[14]: ["에어컨 전용 회로", "냉난방기 전용 배선", "에어컨 배선 공사"],
    # 15. 주차장 조명·전기설비 점검
    WORK_TYPES[15]: ["주차장 조명 고장", "주차장 전기설비 점검"],
    # 16. 상가 간판 전기공사 및 점검
    WORK_TYPES[16]: ["간판 전기 고장", "간판 조명 점검", "상가 간판 전기공사"],
    # 17. 태양광 연계 전기설비 점검
    WORK_TYPES[17]: ["태양광 전기설비 점검", "태양광 인버터 이상"],
    # 18. 비상발전기 연계 전기점검 (무작위 선택에서는 제외되지만 매핑은 남겨둠)
    WORK_TYPES[18]: ["비상발전기 점검", "발전기 절체 이상"],
    # 19. 옥내 배전반 정기 안전점검
    WORK_TYPES[19]: ["배전반 정기 점검", "배전반 안전점검"],
    # 20. 전기온수기 전용 배선 점검
    WORK_TYPES[20]: ["전기온수기 배선 점검", "전기온수기 전용회로"],
    # 21. 인덕션·전기레인지 전용 회로 신설
    WORK_TYPES[21]: ["인덕션 전용 회로", "전기레인지 배선 공사"],
    # 22. 전기자동차 충전기 설치 상담
    WORK_TYPES[22]: ["전기차 충전기 설치", "EV충전기 설치 상담"],
    # 23. 옥외 전등·가로등 고장 점검
    WORK_TYPES[23]: ["가로등 고장", "옥외 전등 고장"],
    # 24. 창고·공장 전기설비 정기점검
    WORK_TYPES[24]: ["공장 전기설비 점검", "창고 전기설비 점검"],
    # 25. 화장실·욕실 방수 콘센트 설치
    WORK_TYPES[25]: ["방수 콘센트 설치", "욕실 콘센트 설치"],
    # 26. 실내 배선 매립 공사 상담
    WORK_TYPES[26]: ["배선 매립 공사", "실내 배선 공사"],
    # 27. 스마트홈 전기배선 연동 공사
    WORK_TYPES[27]: ["스마트홈 배선 공사", "스마트홈 전기 연동"],
    # 28. 지하실·반지하 전기설비 습기 점검
    WORK_TYPES[28]: ["지하실 전기설비 습기", "반지하 전기 누전", "전기 끊김"],
    # 29. 신축·인테리어 전기 공사 총괄 상담
    WORK_TYPES[29]: ["신축 전기공사", "인테리어 전기공사"],
}


def get_title_keyword_pool_for_work_type(work_type):
    """
    이 work_type 본문 내용과 실제로 어울리는 제목 키워드 목록을
    돌려줍니다. 매핑이 없는 work_type(새로 추가된 경우 등)만
    범용 문구(전기 수리 기사, 24시 전기수리업체 등)로 대체합니다.
    """
    return GEN_TITLE_KEYWORD_MAP_BY_WORK_TYPE.get(
        work_type, GEN_TITLE_KEYWORD_DEFAULT_POOL
    )


def build_random_title(gu, dong, work_type=None, forced_keyword=None, max_tries=30, avoid_titles=None):
    """
    "{구} {동} {랜덤 키워드}, {랜덤 뒷문구}" 형태의 제목을 만듭니다.
    work_type을 넘겨주면, 그 작업유형의 실제 증상과 어울리는
    키워드 중에서만 골라서 제목과 본문 내용이 서로 어긋나지 않게
    합니다(예: 본문이 "인터폰 고장" 얘기인데 제목이 "계량기 인입선
    화재"로 나오는 것 방지). work_type을 안 넘기면 예전처럼 전체
    키워드 풀에서 뽑습니다.

    forced_keyword를 넘기면(예: WORK_TYPES[0]에서 본문 증상과 짝지어
    이미 정해둔 키워드가 있는 경우) 무작위로 고르지 않고 그 키워드를
    그대로 씁니다 — 제목과 본문이 항상 같은 구체적 상황을 가리키게
    하기 위함입니다.

    avoid_titles(이미 쓴 제목 집합)에 걸리면 다른 조합을 다시 뽑아서
    중복을 피합니다. (forced_keyword가 있을 때는 키워드는 고정하고
    뒷문구만 다시 뽑습니다.)
    """
    avoid_titles = avoid_titles or set()

    if forced_keyword is not None:
        for _ in range(max_tries):
            ending = build_random_title_ending()
            title = f"{gu} {dong} {forced_keyword}, {ending}"
            if title not in avoid_titles:
                return title
        return title

    if work_type is not None:
        keyword_pool = get_title_keyword_pool_for_work_type(work_type)
    else:
        keyword_pool = GEN_TITLE_KEYWORD_POOL

    for _ in range(max_tries):
        keyword = random.choice(keyword_pool)
        ending = build_random_title_ending()
        title = f"{gu} {dong} {keyword}, {ending}"
        if title not in avoid_titles:
            return title

    # max_tries 안에 새 조합을 못 찾으면(이론상 거의 없음) 마지막 걸 그대로 반환
    return title




# 유형별 현장 진단 문장(점검 순서 섹션 마지막 문단에서 재사용)
GEN_DIAGNOSIS_VARIANTS = {
    WORK_TYPES[0]: [
        "누전이 의심되는 경우에도 차단기 동작만으로 원인을 확정하지 않습니다. 연결된 전기제품을 구분하고 회로별 상태를 살펴보면서 문제가 발생하는 범위를 좁혀야 합니다.",
        "테스터기로 회로별 누설전류를 측정하며 원인을 좁혀가는 방식이 일반적입니다. 특정 구간에서 반복적으로 이상이 확인된다면 해당 부위를 중심으로 점검 범위를 정합니다.",
        "메인 차단기와 개별 회로 차단기를 구분해 어느 쪽에서 문제가 발생하는지부터 확인합니다. 배선 접속부와 콘센트 주변을 순서대로 살펴보면 원인 구간을 좁힐 수 있습니다.",
    ],
    WORK_TYPES[1]: [
        "탄 냄새가 나는 위치를 중심으로 분전반 내부를 하나씩 확인합니다. 접속 단자의 발열이나 미세한 스파크 흔적이 있는지 살펴보는 것이 우선입니다.",
        "분전반 내부 온도와 배선 상태를 함께 확인하면서, 특정 차단기 접점 부위에 열이 몰리고 있는지 점검합니다.",
        "차단기와 버스바 연결 부위를 순서대로 확인해, 접촉 불량으로 인한 국부 발열이 있는지 살펴봅니다.",
    ],
    WORK_TYPES[2]: [
        "문제가 되는 콘센트 내부 단자와 배선 상태를 확인하는 것이 우선입니다. 접속부에 쇼트 흔적이 있는지부터 살펴봅니다.",
        "해당 콘센트에 연결해 사용하던 제품과 배선 상태를 함께 확인하면서 원인 범위를 좁혀갑니다.",
        "테스터기로 전압과 저항을 측정하며 콘센트 회로를 점검해 정확한 이상 지점을 찾아냅니다.",
    ],
    WORK_TYPES[3]: [
        "차단기의 제조 연식과 작동 이력을 확인하고, 내부 부품의 노후화로 민감도가 떨어져 있는지 살펴봅니다.",
        "차단기 자체의 작동 테스트와 함께 연결된 전열 회로 배선 상태도 함께 점검합니다.",
        "차단기 트립 테스트를 진행해 정상 범위를 벗어난 반응이 있는지 확인하는 방식으로 노후 여부를 판단합니다.",
    ],
    WORK_TYPES[4]: [
        "조명기구와 스위치를 각각 분리해서 확인합니다. 조명기구만 교체해봐도 증상이 그대로라면 스위치나 배선 쪽으로 범위를 넓혀 살펴봅니다.",
        "스위치 접점 상태와 연결 배선을 순서대로 확인하며, 눌렀을 때 반응이 없는 원인이 접점인지 배선인지를 구분합니다.",
        "같은 회로에 물린 다른 조명들과 비교해, 특정 조명에만 국한된 문제인지 회로 전체의 문제인지를 확인합니다.",
    ],
    WORK_TYPES[5]: [
        "정전이 발생하는 공간과 분전반의 회로 구성을 대조해, 어느 분기 회로에 문제가 있는지부터 확인합니다.",
        "의심되는 구간의 배선 접속부를 순서대로 점검하며, 접촉 불량이나 피복 손상이 있는지 살펴봅니다.",
        "정전이 반복되는 시점과 사용 중이던 기기를 함께 확인해, 특정 조건과 겹치는 패턴이 있는지 살펴봅니다.",
    ],
    WORK_TYPES[6]: [
        "현재 계약전력과 실사용 전력량을 비교해 증설이 실제로 필요한 상황인지부터 확인합니다.",
        "기존 배선과 분전반이 늘어난 용량을 감당할 수 있는지 함께 검토합니다.",
        "단상에서 삼상으로의 승압이 필요한 사용 기기인지, 단순 계약전력 증설로 충분한지를 구분해 확인합니다.",
    ],
    WORK_TYPES[7]: [
        "접지선의 실제 연결 상태를 확인하고, 접지저항 값을 측정해 기준 범위 안에 있는지 살펴봅니다.",
        "습기 있는 공간과 가까운 회로부터 우선 확인하며, 접지 미비로 인한 영향이 있는지 살펴봅니다.",
        "건물 전체의 접지 공사 이력을 확인해, 부분적으로만 접지가 안 된 구간이 있는지 점검합니다.",
    ],
    WORK_TYPES[8]: [
        "멀티탭에 연결된 기기들의 총 소비전력을 합산해, 정격 용량을 초과하고 있는지부터 확인합니다.",
        "멀티탭 접속부와 내부 배선 상태를 확인해, 노후로 인한 접촉 저항 증가 여부를 살펴봅니다.",
        "연장선이 감겨 있는 상태로 사용되고 있었는지, 방열이 제대로 되고 있었는지를 함께 확인합니다.",
    ],
    WORK_TYPES[9]: [
        "계량기 연결 상태와 인입선 외관을 순서대로 확인해, 손상이나 노후 흔적이 있는지 살펴봅니다.",
        "전기 공급이 불안정한 시점과 주변 세대의 상황을 함께 확인해, 개별 문제인지 공용 설비 문제인지를 구분합니다.",
        "계량기 이전 구간과 이후 구간을 나눠서 점검해, 한전 관할 범위인지 내부 배선 범위인지를 확인합니다.",
    ],
    WORK_TYPES[10]: [
        "인터폰 본체와 단자함, 전원 공급 상태를 순서대로 확인하며 어느 구간의 문제인지 좁혀갑니다.",
        "화면과 음성 중 어느 쪽만 이상이 있는지 구분해, 관련 배선과 부품을 중심으로 점검합니다.",
    ],
    WORK_TYPES[11]: [
        "감지기 표시등과 테스트 버튼 반응을 확인해 개별 기기 문제인지 배선 문제인지부터 구분합니다.",
        "수신반과 개별 감지기 사이의 신호 전달 상태를 순서대로 점검합니다.",
    ],
    WORK_TYPES[12]: [
        "옥상·외부 배선함의 방수 상태와 내부 절연 상태를 순서대로 확인합니다.",
        "우천 시에만 증상이 나타나는지 여부를 확인해 습기 관련 원인을 좁혀갑니다.",
    ],
    WORK_TYPES[13]: [
        "승강기 전용 전원 공급 배선과 절체 스위치 상태를 순서대로 확인합니다.",
        "기계실 분전반의 상태를 점검해 전반적인 노후도와 연관이 있는지 살펴봅니다.",
    ],
    WORK_TYPES[14]: [
        "냉난방기의 소비전력과 현재 연결된 회로의 용량을 비교해 적합성을 확인합니다.",
        "동시 사용 중이던 다른 가전과의 관계를 확인해 부하 집중 여부를 살펴봅니다.",
    ],
    WORK_TYPES[15]: [
        "조명 개별 기구, 센서, 배선 순서로 문제 구간을 좁혀갑니다.",
        "습기가 많은 구역과 증상이 발생하는 위치가 겹치는지 확인합니다.",
    ],
    WORK_TYPES[16]: [
        "간판 전원 공급부와 안정기 상태를 우선 확인합니다.",
        "부분 점등 불량인지 전체 점등 불량인지 구분해 원인 범위를 좁힙니다.",
    ],
    WORK_TYPES[17]: [
        "인버터 표시 정보를 확인해 오류 신호나 발전량 이상 여부를 우선 점검합니다.",
        "태양광 연계 배선의 접속 상태를 순서대로 확인합니다.",
    ],
    WORK_TYPES[18]: [
        "절체 스위치의 자동·수동 전환 상태를 우선 확인합니다.",
        "발전기 자체의 시운전 상태와 배터리·연료 상태를 점검합니다.",
    ],
    WORK_TYPES[19]: [
        "배전반 내부 접속부 상태와 발열 여부를 육안·측정으로 확인합니다.",
        "회로별 부하 분산 상태를 점검해 특정 구간에 무리가 없는지 확인합니다.",
    ],
    WORK_TYPES[20]: [
        "온수기 소비전력과 현재 연결된 배선 용량을 비교해 적합성을 확인합니다.",
        "다른 가전과의 동시 사용 여부를 확인해 부하 집중 가능성을 살펴봅니다.",
    ],
    WORK_TYPES[21]: [
        "인덕션의 소비전력과 현재 연결된 회로·콘센트 용량을 비교해 확인합니다.",
        "특정 화구 조합에서만 증상이 나타나는지 확인해 부하 패턴을 살펴봅니다.",
    ],
    WORK_TYPES[22]: [
        "설치 위치의 계약전력과 배선 용량을 확인해 충전기 설치가 가능한지부터 검토합니다.",
        "완속·급속 충전 방식에 따라 필요한 전력과 공사 범위가 다르므로 사용 목적에 맞춰 확인합니다.",
    ],
    WORK_TYPES[23]: [
        "점멸기·센서의 작동 상태를 우선 확인해 자동 제어 문제인지 확인합니다.",
        "개별 조명, 배선, 전원 공급 순서로 문제 구간을 좁혀갑니다.",
    ],
    WORK_TYPES[24]: [
        "배전반·분전반 내부 상태와 부하 분산 여부를 순서대로 확인합니다.",
        "문제가 반복되는 라인과 설비를 특정해 원인 범위를 좁혀갑니다.",
    ],
    WORK_TYPES[25]: [
        "설치 희망 위치의 습기 노출 정도와 기존 배선 상태를 확인합니다.",
        "접지 연결 가능 여부를 함께 점검해 안전한 설치 방식을 결정합니다.",
    ],
    WORK_TYPES[26]: [
        "현재 배선 방식과 벽체 구조를 확인해 매립 가능 범위를 판단합니다.",
        "인테리어 계획에 맞춰 필요한 콘센트·스위치 위치를 함께 검토합니다.",
    ],
    WORK_TYPES[27]: [
        "기존 배선에 중성선이 있는지부터 확인해 설치 가능 여부를 판단합니다.",
        "설치하려는 스마트 기기의 종류와 필요한 배선 조건을 확인합니다.",
    ],
    WORK_TYPES[28]: [
        "습기가 집중되는 구역과 전기 이상이 발생하는 위치가 겹치는지 확인합니다.",
        "배선과 금속 부품의 부식·절연 상태를 점검합니다.",
    ],
    WORK_TYPES[29]: [
        "공간별 필요한 콘센트·조명 위치와 개수를 먼저 정리합니다.",
        "기존 배선과 분전반 상태를 확인해 재사용 가능 범위를 판단합니다.",
    ],
}

# 유형별 실제 조치 내용(교체/수리 섹션에서 재사용)
GEN_PROCESS_VARIANTS = {
    WORK_TYPES[0]: [
        "확인된 누전 구간의 배선을 정리하고, 손상된 절연 부위를 교체하는 방식으로 조치합니다.",
        "문제가 된 회로의 배선을 재정비하고 접속 단자를 새 제품으로 교체하는 것이 일반적인 조치입니다.",
        "누전이 확인된 부위를 절연 처리하고 필요한 배선 구간을 교체합니다.",
    ],
    WORK_TYPES[1]: [
        "탄화된 부위를 안전하게 절단하고 새 접속 단자로 교체하는 방식으로 조치합니다.",
        "손상된 접속 부위를 교체하고 분전반 전체의 접점 상태를 함께 점검합니다.",
        "탄화 흔적이 있는 차단기를 새 제품으로 교체하고, 분전반 내부 배선을 정리합니다.",
    ],
    WORK_TYPES[2]: [
        "문제가 된 콘센트를 새 제품으로 교체하고 배선 접속 상태를 재정비합니다.",
        "손상된 콘센트와 관련 배선을 함께 교체하고 접지 상태도 다시 점검합니다.",
        "콘센트 교체와 함께 주변 배선의 접속 상태를 재정비합니다.",
    ],
    WORK_TYPES[3]: [
        "노후된 차단기를 새 제품으로 교체하고, 연결된 배선 상태도 함께 정비합니다.",
        "차단기 교체와 함께 전열 회로 배선 일부를 재정비합니다.",
        "노후 차단기를 새 제품으로 교체하고, 관련 회로의 접속 상태를 함께 점검·정비합니다.",
    ],
    WORK_TYPES[4]: [
        "고장이 확인된 조명기구나 스위치를 새 제품으로 교체하고, 연결 배선 상태도 함께 정리합니다.",
        "스위치 접점을 교체하고, 필요한 경우 연결 배선의 접속 상태도 함께 재정비합니다.",
        "조명기구와 스위치를 함께 교체하고, 같은 회로에 연결된 다른 조명의 상태도 점검합니다.",
    ],
    WORK_TYPES[5]: [
        "손상이 확인된 배선 구간을 교체하고, 접속부를 재정비해 접촉 불량을 해소합니다.",
        "노후 배선을 필요한 범위만큼 새 배선으로 교체하고, 관련 분기 회로도 함께 점검합니다.",
        "접속 불량이 확인된 구간을 재시공하고, 전체 회로의 정상 작동 여부를 재확인합니다.",
    ],
    WORK_TYPES[6]: [
        "계약전력 증설에 필요한 서류 절차를 안내하고, 배선·분전반 보강이 필요한 부분을 함께 진행합니다.",
        "승압이 필요하다고 판단되면 관련 설비 교체와 함께 한전 협의 절차를 안내합니다.",
        "기존 배선 용량에 맞춰 증설 규모를 정하고, 필요한 분전반 보강 작업을 함께 진행합니다.",
    ],
    WORK_TYPES[7]: [
        "접지 상태가 미비한 구간에 접지 공사를 보강하고, 접지저항 값을 재측정해 확인합니다.",
        "접지선 연결이 느슨했던 부분을 재시공하고, 관련 회로의 안전 상태를 함께 점검합니다.",
        "누락돼 있던 접지 구간을 보강하고, 습기 있는 공간 주변 회로를 우선적으로 재점검합니다.",
    ],
    WORK_TYPES[8]: [
        "노후되거나 과부하가 확인된 멀티탭·연장선을 정격에 맞는 제품으로 교체하도록 안내합니다.",
        "고전력 기기는 별도 콘센트로 분산 연결하도록 정리하고, 문제가 된 멀티탭은 교체를 권장합니다.",
        "연장선 감김 상태를 해소하고, 필요한 경우 정격 용량이 더 높은 제품으로 교체를 안내합니다.",
    ],
    WORK_TYPES[9]: [
        "손상이 확인된 인입선 구간은 한전과 협의해 교체 절차를 안내하고, 내부 배선은 자체적으로 점검·정비합니다.",
        "계량기 자체에 이상이 있다면 한전 쪽 확인이 필요함을 안내하고, 내부 배선 상태는 별도로 점검합니다.",
        "내부 배선에서 원인이 확인된 경우 해당 구간을 정비하고, 외부 인입선 구간은 관련 기관 확인을 안내합니다.",
    ],
    WORK_TYPES[10]: [
        "단자함 접속 상태를 재정비하고, 필요한 경우 인터폰 본체를 교체합니다.",
        "전원 공급 배선을 점검·정비하고, 인터폰 정상 작동 여부를 재확인합니다.",
    ],
    WORK_TYPES[11]: [
        "센서가 오염되거나 수명이 다한 감지기를 교체합니다.",
        "배선 접속 불량이 확인된 구간을 정비하고, 전체 작동 여부를 재테스트합니다.",
    ],
    WORK_TYPES[12]: [
        "손상된 방수 처리를 보강하고 부식된 부품을 교체합니다.",
        "손상된 외부 배선 구간을 교체하고 절연 상태를 재점검합니다.",
    ],
    WORK_TYPES[13]: [
        "손상된 전원 공급 배선을 정비하고 절체 스위치 상태를 점검·조정합니다.",
        "기계실 분전반의 노후 부위를 정비하고 전체 전기설비 상태를 재점검합니다.",
    ],
    WORK_TYPES[14]: [
        "냉난방기 전용 회로를 신설하고 전용 콘센트로 연결을 정리합니다.",
        "기존 배선 용량이 부족하다면 필요한 구간을 보강 공사합니다.",
    ],
    WORK_TYPES[15]: [
        "고장 난 조명·센서를 교체하고 관련 배선 접속 상태를 정비합니다.",
        "습기로 인한 절연 저하가 확인된 구간의 배선을 보강·교체합니다.",
    ],
    WORK_TYPES[16]: [
        "고장 난 안정기나 조명 소자를 교체합니다.",
        "손상된 외부 배선을 보강하고 방수 처리를 다시 진행합니다.",
    ],
    WORK_TYPES[17]: [
        "이상이 확인된 인버터나 관련 부품을 점검·교체합니다.",
        "손상된 연계 배선을 정비하고 전체 시스템 작동을 재확인합니다.",
    ],
    WORK_TYPES[18]: [
        "절체 스위치를 점검·정비하고 자동 전환 기능을 재확인합니다.",
        "발전기 상태를 정비하고 연계 배선을 재점검합니다.",
    ],
    WORK_TYPES[19]: [
        "노후되거나 손상된 접속부를 정비·교체합니다.",
        "부하가 몰린 회로를 재정비하고 전체 배전반 상태를 정리합니다.",
    ],
    WORK_TYPES[20]: [
        "온수기 전용 배선을 신설하고 전용 콘센트로 정리합니다.",
        "기존 배선 용량이 부족하다면 필요한 구간을 보강 공사합니다.",
    ],
    WORK_TYPES[21]: [
        "인덕션 전용 회로를 신설하고 전용 콘센트로 정리합니다.",
        "기존 배선 용량이 부족하다면 필요한 구간을 보강 공사합니다.",
    ],
    WORK_TYPES[22]: [
        "필요한 전용 배선을 설치하고 충전기 연결부를 정비합니다.",
        "설치 후 정상 충전 여부와 전력 공급 안정성을 재확인합니다.",
    ],
    WORK_TYPES[23]: [
        "고장 난 점멸기·센서나 조명 소자를 교체합니다.",
        "손상된 실외 배선을 보강하고 방수 처리를 다시 진행합니다.",
    ],
    WORK_TYPES[24]: [
        "노후 배선과 접속부를 정비하고 부하가 몰린 구간을 재분배합니다.",
        "필요한 경우 분전반 용량을 보강하거나 증설을 함께 검토합니다.",
    ],
    WORK_TYPES[25]: [
        "방수 등급에 맞는 콘센트로 교체하거나 신규 설치합니다.",
        "필요한 경우 접지 보강과 함께 배선을 정비합니다.",
    ],
    WORK_TYPES[26]: [
        "매립 가능한 구간은 벽체 내부로 배선을 정리하고, 필요한 마감 작업을 진행합니다.",
        "매립이 어려운 구간은 몰딩 등 대안 방식으로 정리합니다.",
    ],
    WORK_TYPES[27]: [
        "필요한 경우 중성선을 포함한 배선을 보강하고 스마트 기기를 연동합니다.",
        "여러 기기를 계획적으로 배치해 배선과 통신 환경을 함께 정비합니다.",
    ],
    WORK_TYPES[28]: [
        "부식되거나 절연이 저하된 배선·부품을 교체합니다.",
        "필요한 경우 방수·방습 처리를 함께 진행합니다.",
    ],
    WORK_TYPES[29]: [
        "전체 배선 계획에 맞춰 필요한 구간을 신설·정비합니다.",
        "분전반을 필요한 용량에 맞게 보강하거나 교체합니다.",
    ],
}



def _gen_locations():
    return [
        (gu, dong)
        for data in (SEOUL_DATA, GYEONGGI_DATA)
        for gu, dongs in data.items()
        for dong in dongs
    ]


# =========================================================
# WORK_TYPES[0](차단기 내려가는 문제) 전용 — 증상 100가지 + 제목
# 키워드를 "짝"으로 묶은 표
# ---------------------------------------------------------
# 예전에는 본문 증상(GEN_SYMPTOM_KEYWORDS)과 제목 앞머리 키워드
# (GEN_TITLE_KEYWORD_MAP_BY_WORK_TYPE)를 서로 다른 풀에서 각각
# 무작위로 뽑았습니다. 둘 다 "work_type[0] 계열"이라는 것만
# 보장됐지, "제목은 두꺼비집 얘기인데 본문은 콘센트 얘기"처럼
# 세부 주제가 어긋나는 경우가 있었습니다.
#
# 이제는 work_type[0]일 때만 아래 100개 짝(symptom + title_keyword)
# 중 하나를 통째로 골라서, 제목과 본문이 항상 같은 구체적 상황을
# 가리키도록 만듭니다. (다른 29개 작업유형은 기존 방식 그대로.)
# =========================================================

GEN_WORKTYPE0_CASES = [
    # --- A. 특정 가전제품 사용 시 (1~20) ---
    {"symptom": "에어컨을 켜자마자 차단기가 바로 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "드라이기 사용 중 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "전자레인지 작동 중 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "인덕션 사용 중 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "전기밥솥 취사를 시작하면 차단기가 내려가는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "세탁기 탈수를 시작하면 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "청소기 사용 중 차단기가 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "전기장판을 켜두면 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "헤어드라이기와 고데기를 같이 쓰면 차단기가 내려가는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "전기포트로 물을 끓일 때 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "냉장고가 켜진 상태에서 다른 가전을 쓰면 차단기가 내려가는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "김치냉장고를 함께 돌리면 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "전기오븐 예열 중 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "식기세척기 작동 중 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "제습기를 켜두면 차단기가 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "에어프라이어 사용 중 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "전기그릴 사용 중 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "로봇청소기 충전 중 차단기가 내려가는 증상", "title_keyword": "누전점검"},
    {"symptom": "안마의자 사용 중 차단기가 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "전동 킥보드·전동자전거 충전 중 차단기가 내려가는 증상", "title_keyword": "누전검사"},

    # --- B. 시간대·계절별 (21~35) ---
    {"symptom": "새벽 시간대에만 차단기가 내려가는 증상", "title_keyword": "차단기 수시로 내려감"},
    {"symptom": "한밤중 자다가 차단기가 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "출근 준비 시간에 차단기가 내려가는 증상", "title_keyword": "차단기 수시로 내려감"},
    {"symptom": "퇴근 후 저녁 시간대에 유독 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "장마철에 유독 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "한여름 냉방기 사용철에 차단기가 내려가는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "겨울철 난방기 사용철에 차단기가 내려가는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "명절 연휴 음식 준비 중 차단기가 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "휴가철 집을 비웠다 돌아오니 차단기가 내려가 있던 증상", "title_keyword": "두꺼비집 내려감"},
    {"symptom": "환절기에 원인 모르게 차단기가 내려가는 증상", "title_keyword": "차단기 수시로 내려감"},
    {"symptom": "주말에만 유독 차단기가 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "손님을 초대한 날 차단기가 내려가는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "비가 오는 날만 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "태풍·강풍이 지나간 뒤 차단기가 내려가는 증상", "title_keyword": "차단기 자주 떨어짐"},
    {"symptom": "미세먼지가 심한 날 공기청정기를 켜면 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},

    # --- C. 위치·공간별 (36~50) ---
    {"symptom": "욕실 콘센트 사용 시 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "베란다 콘센트 사용 시 차단기가 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "주방 콘센트만 사용하면 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "특정 방 하나만 전기가 끊기는 증상", "title_keyword": "두꺼비집 안 올라감"},
    {"symptom": "2층만 전기가 끊기고 1층은 멀쩡한 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "거실 조명을 켜면 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "다용도실 콘센트 사용 시 차단기가 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "지하실 전등을 켜면 차단기가 내려가는 증상", "title_keyword": "두꺼비집 내려감"},
    {"symptom": "옥상 조명을 켜면 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "현관 센서등 작동 시 차단기가 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "창고방 콘센트 사용 시 차단기가 내려가는 증상", "title_keyword": "두꺼비집 떨어짐"},
    {"symptom": "세탁실 콘센트 사용 시 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "아이 방 콘센트 사용 시 차단기가 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "안방 에어컨만 켜면 차단기가 내려가는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "부엌과 거실을 동시에 쓰면 차단기가 내려가는 증상", "title_keyword": "메인차단기 내려감"},

    # --- D. 반복·빈도 패턴 (51~60) ---
    {"symptom": "하루에도 몇 번씩 차단기가 내려가는 증상", "title_keyword": "차단기 자주 떨어짐"},
    {"symptom": "일주일에 한 번꼴로 차단기가 내려가는 증상", "title_keyword": "누전점검"},
    {"symptom": "이사 온 뒤부터 차단기가 자주 내려가는 증상", "title_keyword": "누전차단기 오작동"},
    {"symptom": "며칠 전부터 갑자기 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "몇 달 전부터 서서히 심해지더니 차단기가 내려가는 증상", "title_keyword": "누전차단기 오작동"},
    {"symptom": "특정 요일에만 반복적으로 차단기가 내려가는 증상", "title_keyword": "누전검사"},
    {"symptom": "계절이 바뀔 때마다 차단기가 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "리모델링 공사 후부터 차단기가 자주 내려가는 증상", "title_keyword": "누전차단기 오작동"},
    {"symptom": "전기요금이 갑자기 오른 뒤 차단기까지 내려가는 증상", "title_keyword": "전기기사"},
    {"symptom": "정전 복구 후부터 차단기가 자주 내려가는 증상", "title_keyword": "누전차단기 오작동"},

    # --- E. 동반 증상 — 소리·냄새·시각적 (61~70) ---
    {"symptom": "차단기가 내려가면서 타는 냄새도 함께 나는 증상", "title_keyword": "두꺼비집 내려감"},
    {"symptom": "차단기가 내려갈 때 \"팟\" 소리가 나는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "차단기 주변이 뜨겁게 느껴지는 증상", "title_keyword": "전등누전수리"},
    {"symptom": "차단기가 내려간 자리에 그을음이 보이는 증상", "title_keyword": "두꺼비집 내려감"},
    {"symptom": "두꺼비집 뚜껑을 열면 탄 냄새가 나는 증상", "title_keyword": "두꺼비집 떨어짐"},
    {"symptom": "차단기가 내려갈 때 불꽃이 튀는 것을 본 증상", "title_keyword": "두꺼비집 떨어짐"},
    {"symptom": "차단기 스위치가 헐거워진 느낌이 드는 증상", "title_keyword": "차단기 레버 부러짐"},
    {"symptom": "분전반에서 웅웅거리는 소리가 나는 증상", "title_keyword": "차단기 고장 교체"},
    {"symptom": "차단기 레버가 뻑뻑해서 잘 안 움직이는 증상", "title_keyword": "차단기 레버 부러짐"},
    {"symptom": "차단기 레버가 부러져서 손잡이만 빠지는 증상", "title_keyword": "차단기 레버 부러짐"},

    # --- F. 정도·범위 — 부분/전체 (71~80) ---
    {"symptom": "집 전체 전기가 한꺼번에 나가는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "메인차단기까지 내려가서 온 집이 깜깜해지는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "특정 콘센트 한 곳만 전기가 안 들어오는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "절반은 켜지고 절반은 꺼진 상태로 유지되는 증상", "title_keyword": "두꺼비집 안 올라감"},
    {"symptom": "차단기를 올려도 몇 초 뒤 다시 내려가는 증상", "title_keyword": "차단기 다시 안 올라감"},
    {"symptom": "차단기를 올려도 아예 다시 안 올라가는 증상", "title_keyword": "차단기 안 올라감"},
    {"symptom": "손으로 세게 눌러야만 겨우 올라가는 차단기 증상", "title_keyword": "차단기 안 올라감"},
    {"symptom": "차단기가 중간에 걸려서 완전히 안 올라가는 증상", "title_keyword": "두꺼비집 안 올라감"},
    {"symptom": "여러 개 차단기 중 특정 하나만 자꾸 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "분전반 전체 차단기가 동시에 다 내려가는 증상", "title_keyword": "두꺼비집 떨어져서 안 올라감"},

    # --- G. 사용 패턴 변화 관련 (81~90) ---
    {"symptom": "재택근무를 시작한 뒤부터 차단기가 자주 내려가는 증상", "title_keyword": "전업사"},
    {"symptom": "가족이 늘어난 뒤부터 차단기가 자주 내려가는 증상", "title_keyword": "차단기 수시로 내려감"},
    {"symptom": "신혼집 입주 초기부터 차단기가 자주 내려가는 증상", "title_keyword": "전기기사"},
    {"symptom": "반려동물을 키우면서 히터를 자주 켜다 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "아이가 태어난 뒤 가전이 늘면서 차단기가 내려가는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "노부모님을 모시고 살면서 전기매트를 쓰다 차단기가 내려가는 증상", "title_keyword": "차단기 내려감"},
    {"symptom": "전세로 들어온 뒤부터 유독 차단기가 자주 내려가는 증상", "title_keyword": "누전차단기 오작동"},
    {"symptom": "월세로 들어온 뒤 차단기 문제를 처음 겪는 증상", "title_keyword": "전업사"},
    {"symptom": "1인 가구로 독립한 뒤 차단기가 자주 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "룸메이트와 같이 살면서 전기 사용량이 늘어 차단기가 내려가는 증상", "title_keyword": "메인차단기 내려감"},

    # --- H. 기타 특이 상황 (91~100) ---
    {"symptom": "여러 번 고쳤는데도 다시 차단기가 내려가는 증상", "title_keyword": "누전차단기 오작동"},
    {"symptom": "다른 업체에서 차단기만 교체했는데도 또 내려가는 증상", "title_keyword": "차단기 고장 교체"},
    {"symptom": "셀프로 차단기를 올렸다 내렸다 반복하고 있는 상황", "title_keyword": "전기기사"},
    {"symptom": "전기 계량기 옆 차단기가 자꾸 내려가는 증상", "title_keyword": "차단기 자꾸 내려감"},
    {"symptom": "한전 점검을 다녀간 뒤에도 차단기가 내려가는 증상", "title_keyword": "24시전기수리업체"},
    {"symptom": "옆집도 같이 전기가 나가는 것처럼 보이는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "건물 전체가 정전됐다가 복구된 뒤 우리 집만 안 들어오는 증상", "title_keyword": "메인차단기 내려감"},
    {"symptom": "차단기를 새 걸로 바꿨는데 며칠 만에 또 내려가는 증상", "title_keyword": "차단기 고장 교체"},
    {"symptom": "오래된 차단기라 교체 시기가 된 것 같은데 확신이 안 서는 상황", "title_keyword": "차단기 고장 교체"},
    {"symptom": "원인을 몰라 불안해서 상담받고 싶은 상황", "title_keyword": "24시전기수리업체"},
]


def pick_worktype0_case():
    """
    WORK_TYPES[0](차단기 내려가는 문제) 전용 — 증상과 제목 키워드를
    한 쌍으로 묶어서 뽑습니다. 이렇게 하면 제목 앞머리 키워드와
    본문 증상이 항상 같은 구체적 상황을 가리키게 됩니다.
    """
    return random.choice(GEN_WORKTYPE0_CASES)


# =========================================================
# 전화 유도형 마무리 문구 (경쟁사 "전기닥터" 글 구조 참고)
# ---------------------------------------------------------
# 예전 마무리는 "원인을 하나씩 짚어보자"는 정보성 문장으로만
# 끝나서 전화 전환이 약했습니다. 전기닥터 같은 실제 전기수리
# 업체 글은 마지막을 항상 "지금 전화하면 바로 방문해서 봐준다"는
# 직접적인 행동 유도 문장으로 마무리합니다. 이 패턴을 반영해,
# 본문 맨 끝에 항상 이 CTA(전화 유도) 문단을 붙입니다.
# =========================================================
GEN_CTA_CLOSING_VARIANTS = [
    (
        "전기는 방치할수록 생활과 안전에 바로 영향을 줍니다. "
        "{gu} {dong}에서 {symptom} 같은 증상이 있다면 오늘 보이는 상태부터 "
        "정리해두는 것이 안전합니다. 전화로 증상을 말씀해 주시면 "
        "가능한 시간에 맞춰 방문해 점검부터 작업까지 이어드립니다. "
        f"사진을 함께 보내주시면 판단이 더 빨라집니다. ☎ 지금 바로 상담: {PHONE_NUMBER}"
    ),
    (
        "{gu} {dong} {housing}에서 {symptom} 같은 문제는 혼자 판단해서 "
        "미루기보다 전문 전기기사의 확인을 받는 것이 안전합니다. "
        f"24시간 언제든 전화 주시면 출동 가능 시간과 대략적인 확인 범위를 안내해드립니다. "
        f"☎ 24시 긴급상담: {PHONE_NUMBER}"
    ),
    (
        "같은 증상이라도 원인은 집집마다 다를 수 있어, 눈으로 보는 것만으로는 "
        "정확한 판단이 어렵습니다. {gu} {dong}에서 {symptom} 문제로 불편하시다면 "
        f"지금 바로 전화 주세요. 현장에서 원인을 확인하고 필요한 작업만 안내해드립니다. ☎ {PHONE_NUMBER}"
    ),
    (
        "전기 문제는 시간이 지날수록 원인을 찾기 더 어려워지는 경우가 많습니다. "
        "{gu} {dong} {housing}에서 {symptom} 증상을 겪고 계시다면, "
        f"더 미루지 마시고 전화로 상황을 알려주세요. 방문 점검 후 필요한 조치를 바로 안내해드립니다. ☎ {PHONE_NUMBER}"
    ),
    (
        "차단기나 배선 문제는 눈에 보이는 증상보다 안 보이는 원인이 더 클 때가 많습니다. "
        "{gu} {dong}에서 {symptom} 때문에 불편하시다면 전화 한 통이면 충분합니다. "
        f"출동 가능 여부와 대략적인 확인 범위를 바로 안내해드리겠습니다. ☎ {PHONE_NUMBER}"
    ),
]


# =========================================================
# 소제목 표현 다양화 + 섹션 순서 랜덤화
# ---------------------------------------------------------
# 예전에는 모든 글이 "응급대응→체크리스트→원인→점검순서→교체
# 시점→점검후확인→주의사항→예방습관→FAQ→전화안내" 순서로 소제목도
# 항상 똑같이 고정돼 있어서, 문장 표현을 아무리 다양하게 섞어도
# 글의 "뼈대"가 매번 똑같아 AI가 쓴 템플릿처럼 보였습니다.
# 이제 소제목 문구 자체를 여러 개 중 랜덤으로 고르고, 중간 섹션
# 5개(점검순서/교체시점/점검후확인/주의사항/예방습관)의 등장
# 순서도 매번 랜덤으로 섞어서 글마다 구조가 달라지게 합니다.
# (응급대응은 항상 맨 앞, FAQ·전화안내는 항상 맨 뒤 — 실제 업체
# 글도 이 두 위치는 관례상 거의 고정되어 있어 그대로 둡니다.)
# =========================================================
GEN_HEADING_VARIANTS = {
    "emergency": [
        "지금 바로 확인해야 할 응급 대응",
        "당장 이렇게 대처하세요",
        "우선 이것부터 확인하세요",
        "응급 상황이라면 먼저 이렇게 하세요",
    ],
    "checklist": [
        "이런 증상이 함께 나타난다면 확인이 필요합니다",
        "다음 증상도 같이 있다면 점검이 필요합니다",
        "아래 중 해당되는 게 있는지 확인해보세요",
        "이런 신호가 같이 보인다면 주의가 필요합니다",
    ],
    "cause": [
        "{symptom}의 대표적인 원인 범위",
        "{symptom}, 어떤 원인이 있을까요",
        "원인으로 의심되는 부분들",
        "{symptom}이 발생하는 주요 원인",
    ],
    "process": [
        "점검은 어떤 순서로 진행할까",
        "점검은 이런 순서로 진행됩니다",
        "현장 점검 절차 안내",
        "점검 순서는 이렇게 정리됩니다",
    ],
    "replace": [
        "교체나 수리는 언제 고려할까",
        "교체가 필요한 시점은 언제일까",
        "수리와 교체, 판단 기준",
        "교체 시점을 정하는 기준",
    ],
    "postcheck": [
        "점검 후 확인해야 할 부분",
        "작업 후에도 이 부분은 확인해주세요",
        "점검이 끝난 뒤 체크할 것",
        "사후 확인이 필요한 사항",
    ],
    "caution": [
        "전기 이상이 반복될 때 주의할 점",
        "증상이 다시 나타난다면 주의하세요",
        "재발 시 유의할 점",
        "반복될 경우 확인할 부분",
    ],
    "prevention": [
        "재발을 막는 예방 습관",
        "다시 발생하지 않게 하는 습관",
        "예방을 위한 생활 습관",
        "재발 방지 체크포인트",
    ],
    "faq": [
        "자주 묻는 질문",
        "많이 물어보시는 질문",
        "자주 궁금해하시는 부분",
        "문의주시는 질문들",
    ],
    "cta": [
        "지금 바로 전화 주세요",
        "궁금하시면 바로 연락 주세요",
        "더 늦기 전에 전화 주세요",
        "지금 상담받아보세요",
    ],
}


def _pick_heading(key, fmt=None):
    heading = random.choice(GEN_HEADING_VARIANTS[key])
    return heading.format(**fmt) if fmt else heading


def _gen_build_case(gu, dong, work_type):
    housing = random.choice(GEN_HOUSING_TYPES)

    forced_title_keyword = None
    if work_type == WORK_TYPES[0]:
        case = pick_worktype0_case()
        symptom = case["symptom"]
        forced_title_keyword = case["title_keyword"]
    else:
        symptom = random.choice(GEN_SYMPTOM_KEYWORDS[work_type])

    fmt = dict(gu=gu, dong=dong, housing=housing, symptom=symptom)

    title = build_random_title(
        gu, dong, work_type=work_type, forced_keyword=forced_title_keyword
    )

    # 1) 도입부 (2문단)
    opening = random.choice(GEN_OPENING_VARIANTS).format(**fmt)
    context1 = random.choice(GEN_CONTEXT_VARIANTS).format(**fmt)
    context2 = random.choice(GEN_CONTEXT2_VARIANTS).format(**fmt)

    # 2) 증상 체크리스트 (5~6개 랜덤 추출)
    checklist_pool = GEN_SYMPTOM_CHECKLIST[work_type]
    checklist_n = min(len(checklist_pool), random.randint(5, 6))
    checklist_items = random.sample(checklist_pool, k=checklist_n)

    # 3) 원인 항목 (4개 중 3개 랜덤 추출)
    cause_pool = GEN_CAUSE_SECTIONS[work_type]
    cause_sections = random.sample(cause_pool, k=min(3, len(cause_pool)))

    # 4) 점검 순서 (일반 2문단 + 유형별 진단 1문단)
    process_step1 = random.choice(GEN_PROCESS_STEP1_VARIANTS).format(**fmt)
    process_step2 = random.choice(GEN_PROCESS_STEP2_VARIANTS).format(**fmt)
    process_step3 = random.choice(GEN_DIAGNOSIS_VARIANTS[work_type])

    # 5) 교체/수리 시점 (유형별 조치 1문단 + 일반 주의 1문단)
    main_cause_title = cause_sections[0][0]
    replace_intro = random.choice(GEN_REPLACE_INTRO_VARIANTS).format(cause_title=main_cause_title)
    replace_action = random.choice(GEN_PROCESS_VARIANTS[work_type])
    replace_caution = random.choice(GEN_REPLACE_CAUTION_VARIANTS)

    # 6) 점검 후 확인 / 7) 주의할 점
    post_check = random.choice(GEN_POST_CHECK_VARIANTS)
    caution = random.choice(GEN_CAUTION_VARIANTS)

    # 8) 지금 바로 확인해야 할 응급 대응 (매번 랜덤 순서로, 최대 4개까지만)
    #    예전엔 이 목록을 순서 그대로 전부 써서 같은 work_type인 글끼리
    #    문구가 토씨 하나 안 틀리고 완전히 똑같이 반복되는 문제가 있었습니다.
    emergency_pool = GEN_EMERGENCY_STEPS[work_type]
    emergency_items = random.sample(emergency_pool, k=min(4, len(emergency_pool)))

    # 9) 재발 방지 예방 습관 (5개 중 4개 랜덤 추출)
    prevention_pool = GEN_PREVENTION_TIPS[work_type]
    prevention_items = random.sample(prevention_pool, k=min(4, len(prevention_pool)))

    # 10) FAQ 4개
    faq_items = random.sample(GEN_FAQ_POOL, k=4)

    # 체크리스트/원인/FAQ 각 항목은 한 줄(\n)로 이어붙이되, 그 앞뒤로는
    # 반드시 빈 줄(\n\n)을 둬서 소제목이 내용을 삼키지 않도록 합니다.
    checklist_md = "\n".join(f"- {item}" for item in checklist_items)
    cause_md = "\n\n".join(
        f"### {i}. {c_title}\n\n{c_desc}"
        for i, (c_title, c_desc) in enumerate(cause_sections, start=1)
    )
    emergency_md = "\n".join(f"- {item}" for item in emergency_items)
    prevention_md = "\n".join(f"- {item}" for item in prevention_items)
    faq_md = "\n\n".join(f"### Q. {q}\n\n{a}" for q, a in faq_items)

    # 11) 마지막 전화 유도 문단 (CTA)
    cta_closing = random.choice(GEN_CTA_CLOSING_VARIANTS).format(**fmt)

    # 소제목은 매번 랜덤으로 고릅니다 (같은 섹션이어도 문구가 달라짐)
    h_emergency = _pick_heading("emergency")
    h_checklist = _pick_heading("checklist")
    h_cause = _pick_heading("cause", fmt)
    h_process = _pick_heading("process")
    h_replace = _pick_heading("replace")
    h_postcheck = _pick_heading("postcheck")
    h_caution = _pick_heading("caution")
    h_prevention = _pick_heading("prevention")
    h_faq = _pick_heading("faq")
    h_cta = _pick_heading("cta")

    # "점검순서/교체시점/점검후확인/주의사항/예방습관" 5개 섹션은
    # 서로 순서를 바꿔도 내용이 어색해지지 않으므로, 매번 순서를
    # 랜덤으로 섞어서 글마다 구조 자체가 달라지게 합니다. (응급대응은
    # 항상 맨 앞, 원인 설명 바로 뒤 / FAQ·전화안내는 항상 맨 뒤로 고정)
    middle_sections = [
        (h_process, f"{process_step1}\n\n{process_step2}\n\n{process_step3}"),
        (h_replace, f"{replace_intro} {replace_action}\n\n{replace_caution}"),
        (h_postcheck, post_check),
        (h_caution, caution),
        (h_prevention, prevention_md),
    ]
    random.shuffle(middle_sections)
    middle_md = "\n\n".join(f"## {h}\n\n{c}" for h, c in middle_sections)

    body = (
        f"## {gu} {dong} {symptom}\n\n{opening}\n\n{context1}\n\n{context2}\n\n"
        f"## {h_emergency}\n\n{emergency_md}\n\n"
        f"## {h_checklist}\n\n{checklist_md}\n\n"
        f"## {h_cause}\n\n{cause_md}\n\n"
        f"{middle_md}\n\n"
        f"## {h_faq}\n\n{faq_md}\n\n"
        f"## {h_cta}\n\n{cta_closing}"
    )

    return {
        "title": title,
        "location": f"{gu} {dong}",
        "housing": housing,
        "topic": symptom,
        "body": body,
        # 이 사례가 실제로 어떤 work_type으로 만들어졌는지 원본 그대로
        # 저장해 둡니다. 나중에 글을 고를 때 이 값으로 "정확히" 매칭해야
        # 제목/본문/ACF/카테고리가 서로 어긋나지 않습니다.
        "work_type": work_type,
    }


def generate_cases_txt(n=20000, out_path=None):
    """
    조합형으로 전기수리 사례 n건을 만들어 TXT 파일로 저장합니다.
    (경쟁사 글을 긁어오지 않고, 직접 준비한 문단 조각을 랜덤 조합합니다)
    """
    out_path = out_path or CASES_FILE
    locations = _gen_locations()
    used_titles = set()
    lines = []

    for i in range(n):
        gu, dong = random.choice(locations)
        work_type = pick_weighted_work_type()

        case = None
        for _ in range(20):
            candidate = _gen_build_case(gu, dong, work_type)
            if candidate["title"] not in used_titles:
                used_titles.add(candidate["title"])
                case = candidate
                break
        if case is None:
            case = candidate  # 20번 시도해도 겹치면 그냥 사용

        lines.append(f"[CHATGPT 사례 {i:04d}]")
        lines.append(f"제목 소재: {case['title']}")
        lines.append(f"지역: {case['location']}")
        lines.append(f"주거형태: {case['housing']}")
        lines.append(f"사례소재: {case['topic']}")
        # ★ 구조 변경 지점: 이 사례가 어떤 work_type으로 만들어졌는지
        # TXT 안에 그대로 남겨둡니다. 이 필드가 없으면(예전 TXT) 나중에
        # "지역만 같고 작업유형은 다른 사례"가 잘못 선택되어 제목/본문이
        # 등록하려는 작업유형과 어긋나는 문제가 생깁니다.
        lines.append(f"작업유형: {case['work_type']}")
        lines.append("[본문]")
        lines.append(case["body"])
        lines.append("=" * 40)
        lines.append("")

    Path(out_path).write_text("\n".join(lines), encoding="utf-8")

    print(f"🛠️ TXT 자동 생성 완료: {n}건 -> {out_path}")
    print(f"🛠️ 고유 제목 수: {len(used_titles)}")


def _parse_cases_txt(path):
    """
    [CHATGPT 사례 NNNN] 블록 형식의 TXT 한 개를 파싱해서
    사례 딕셔너리 리스트로 돌려줍니다.
    """
    text = path.read_text(encoding="utf-8")

    blocks = re.split(
        r"\[CHATGPT 사례\s+\d{4}\]\s*\n",
        text
    )

    cases = []

    for block in blocks[1:]:
        title_match = re.search(
            r"^제목 소재:\s*(.+)$",
            block,
            re.M
        )
        location_match = re.search(
            r"^지역:\s*(.+)$",
            block,
            re.M
        )
        housing_match = re.search(
            r"^주거형태:\s*(.+)$",
            block,
            re.M
        )
        topic_match = re.search(
            r"^사례소재:\s*(.+)$",
            block,
            re.M
        )
        work_type_match = re.search(
            r"^작업유형:\s*(.+)$",
            block,
            re.M
        )
        body_match = re.search(
            r"\[본문\]\s*\n(.*?)(?=\n={20,}\s*\Z)",
            block,
            re.S
        )

        if not title_match or not body_match:
            continue

        cases.append({
            "title": title_match.group(1).strip(),
            "location": location_match.group(1).strip() if location_match else "",
            "housing": housing_match.group(1).strip() if housing_match else "",
            "topic": topic_match.group(1).strip() if topic_match else "",
            # 예전 TXT(작업유형 필드가 없던 구조)와 호환되도록, 필드가
            # 없으면 빈 문자열로 둡니다. load_cases()에서 이 값이 비어
            # 있으면 자동으로 새 구조로 재생성을 시도합니다.
            "work_type": work_type_match.group(1).strip() if work_type_match else "",
            "body": body_match.group(1).strip(),
        })

    return cases


def load_cases():
    """
    TXT의 완성 본문을 읽습니다. (Gemini/OpenAI API 사용 안 함)
    CASES_FILE이 없으면 20,000건을 자동으로 새로 생성합니다.
    같은 폴더에 electric_case_new_cases_60.txt 가 있으면 그 안의
    사례들도 함께 합쳐서 사용합니다.
    """
    if not CASES_FILE.exists():
        print(f"⚠️ {CASES_FILE.name}이(가) 없어서 새로 20,000건을 생성합니다...")
        generate_cases_txt(n=20000, out_path=CASES_FILE)

    cases = _parse_cases_txt(CASES_FILE)

    # ★ 구조 변경에 따른 자동 마이그레이션: 예전 TXT는 "작업유형" 필드가
    # 없어서, 지역만 같고 작업유형은 전혀 다른 사례가 잘못 선택되며
    # "제목/본문이 실제로 등록하려는 작업유형과 어긋나는" 문제의 원인이
    # 됩니다. 첫 번째 사례에 work_type이 비어 있으면 예전 구조로 판단해
    # 같은 개수로 새 구조 TXT를 다시 만듭니다.
    if cases and not cases[0].get("work_type"):
        print("⚠️ 예전 구조(작업유형 필드 없음)의 TXT가 감지되어, 제목/본문 불일치 방지를 위해 새 구조로 다시 생성합니다...")
        generate_cases_txt(n=max(len(cases), 20000), out_path=CASES_FILE)
        cases = _parse_cases_txt(CASES_FILE)

    print(f"📄 완성 본문 TXT: {CASES_FILE}")
    print(f"📄 읽은 사례: {len(cases)}개")

    if NEW_CASES_FILE.exists():
        new_cases = _parse_cases_txt(NEW_CASES_FILE)
        cases.extend(new_cases)
        print(f"📄 추가 완성 본문 TXT: {NEW_CASES_FILE}")
        print(f"📄 추가로 읽은 사례: {len(new_cases)}개")

    if not cases:
        raise RuntimeError("TXT에서 완성 본문을 읽지 못했습니다.")

    print(f"📄 전체 합산 사례: {len(cases)}개")

    return cases


# MANUAL_300 / FIX_* / REMOVE_FEATURED_IMAGE_ALL 등은 이 20,000건
# 콤보 텍스트를 전혀 안 쓰는데도, 예전엔 이 줄이 모듈 로드 시점에
# 무조건 실행돼서 그런 모드를 돌릴 때도 매번 20,000건을 확인/생성
# 했습니다. 실제로 필요한 시점(get_txt_case_for_location 최초 호출)
# 에만 한 번 로드하도록 지연 로딩으로 바꿨습니다.
_CASES_CACHE = None


def _get_cases():
    global _CASES_CACHE
    if _CASES_CACHE is None:
        _CASES_CACHE = load_cases()
    return _CASES_CACHE


def get_txt_case_for_location(gu, dong, work_type, used_titles=None):
    """
    ★ 구조 변경: 예전에는 "구/동이 같은 사례"를 먼저 고른 뒤, 그 안에서
    work_type과 대략 비슷해 보이는 사례를 "키워드 토큰 겹침"이라는
    느슨한 방식으로만 걸러냈습니다. 토큰이 짧고 흔한 단어(예: "배선",
    "점검")라서 서로 다른 work_type끼리도 쉽게 겹쳤고, 겹치는 토큰이
    하나도 없으면 필터링 자체가 무력화되어 지역만 같은 "완전히 다른
    작업유형"의 사례가 그대로 뽑혔습니다. 그 결과 제목/본문은 (예:
    "인터폰 고장" 이야기인데, 실제 등록되는 카테고리·ACF는 "태양광 점검"
    이 되는 식으로) 서로 어긋난 글이 만들어졌습니다.

    새 구조에서는 TXT에 저장해 둔 "work_type" 필드로 정확히(==) 같은
    사례만 우선 후보로 삼고, 그 안에서만 지역 일치 → 전체 순으로
    좁혀갑니다. 지역은 "가산점" 역할만 하고, work_type 일치는 "필수
    조건"으로 바꾼 것이 핵심입니다.
    """
    location = f"{gu} {dong}"
    used_titles = used_titles or set()
    cases = _get_cases()

    def clean_title(case):
        return strip_gyeongu(clean_tuple_artifacts(case.get("title", "")))

    def exclude_used(cases):
        return [c for c in cases if clean_title(c) not in used_titles]

    # 0순위(필수 조건): work_type이 "정확히" 일치하는 사례만 모읍니다.
    exact_type_cases = [c for c in cases if c.get("work_type") == work_type]

    if exact_type_cases:
        # 1순위: 같은 지역 + 같은 작업유형 + 아직 안 쓴 제목
        same_location = [c for c in exact_type_cases if c.get("location", "") == location]
        pool = exclude_used(same_location)

        # 2순위: 작업유형은 같지만 지역은 다름 + 아직 안 쓴 제목
        if not pool:
            pool = exclude_used(exact_type_cases)

        # 3순위: 같은 작업유형 사례를 이미 다 써버림 → 제목 중복 허용
        # (그래도 work_type만큼은 절대 어긋나지 않습니다)
        if not pool:
            pool = exact_type_cases

        return random.choice(pool)

    # ---- 아래는 work_type 필드가 없는 예전 구조 TXT(예: 수동으로 만든
    # NEW_CASES_FILE)에 대한 예외 처리입니다. load_cases()가 CASES_FILE은
    # 자동으로 새 구조로 재생성하므로, 정상 운영 중에는 이 경로를 타는
    # 사례가 거의 없어야 합니다. 혹시라도 여기까지 오면 어떤 사례가
    # 사용됐는지 반드시 로그로 남겨 눈으로 확인할 수 있게 합니다. ----
    print(
        f"⚠️ '{work_type}'와 work_type이 정확히 일치하는 TXT 사례가 없습니다. "
        f"(NEW_CASES_FILE 등 예전 구조 사례일 수 있음 — 제목/본문이 이번 "
        f"작업유형과 안 맞을 수 있으니 해당 파일에도 '작업유형' 필드를 "
        f"추가하는 것을 권장합니다.)"
    )

    match_tokens = set()
    for phrase in GEN_SYMPTOM_KEYWORDS.get(work_type, []):
        for token in re.split(r"[·,\s]+", phrase):
            token = token.strip()
            if len(token) >= 2:
                match_tokens.add(token)

    no_type_cases = [c for c in cases if not c.get("work_type")]
    candidates = [c for c in no_type_cases if c.get("location", "") == location] or no_type_cases

    keyword_candidates = [
        c for c in candidates
        if any(
            token in (c.get("title", "") + " " + c.get("topic", "") + " " + c.get("body", ""))
            for token in match_tokens
        )
    ]

    if keyword_candidates:
        candidates = keyword_candidates

    pool = exclude_used(candidates) or exclude_used(no_type_cases) or candidates or cases
    return random.choice(pool)


def vary_text(text):
    """
    같은 TXT 사례가 여러 지역/여러 회차에 재사용되더라도
    자주 나오는 표현을 매번 임의의 동의어로 바꿔서
    문구가 완전히 똑같이 반복되지 않도록 합니다.
    """
    if not text:
        return text

    for group in GEN_SYNONYM_GROUPS:
        if any(phrase in text for phrase in group):
            replacement = random.choice(group)
            for phrase in group:
                if phrase != replacement:
                    text = text.replace(phrase, replacement)

    return text


GEN_SYNONYM_GROUPS = [
    ["반복해서 내려가는", "자꾸 떨어지는", "계속 내려가는", "몇 번이고 내려가는", "수시로 내려가는"],
    ["반복해서 발생하는", "자꾸 발생하는", "계속 반복되는", "여러 번 발생하는"],
    ["확인이 필요합니다", "점검이 필요합니다", "살펴봐야 합니다", "확인해 보는 것이 좋습니다"],
    ["점검을 진행했습니다", "확인 작업을 진행했습니다", "점검을 실시했습니다", "현장 점검을 했습니다"],
    ["노후화", "노후된 상태", "오래되어 낡은 상태", "사용 연한이 지난 상태"],
    ["기술자", "작업자", "현장 기사", "담당 기사"],
    ["안전을 위해", "안전한 사용을 위해", "사고 예방을 위해", "만일의 사고를 막기 위해"],
    ["교체 작업을 진행했습니다", "교체를 진행했습니다", "새 제품으로 교체했습니다", "교체 수리를 마쳤습니다"],
    ["원인을 파악했습니다", "원인을 확인했습니다", "원인을 찾아냈습니다", "원인을 짚어냈습니다"],
]


def strip_gyeongu(title):
    """
    제목에서 "경우"라는 단어를 자연스럽게 제거합니다.
    "경우가", "경우는" 처럼 조사가 바로 붙은 경우도 함께 제거합니다.
    """
    if not title:
        return title

    title = re.sub(r"경우(가|는|도|를|에|만)?\s*", " ", title)
    title = re.sub(r"\s{2,}", " ", title).strip()
    return title


def clean_tuple_artifacts(text):
    """
    TXT 사례 파일 안에 가끔 ('용산구', '청파동') 같은 파이썬 튜플
    형태 문자열이 그대로 섞여 들어있는 경우가 있어서(예: 제목이
    "('용산구', '청파동') 아파트 메인차단기가..." 로 저장되는 문제),
    이런 패턴을 자연스러운 "용산구 청파동" 형태로 정리합니다.

    곧은따옴표(' ")뿐 아니라 둥근(스마트) 따옴표(' ' " ")로 된
    경우도 함께 잡아냅니다 — 원고 파일이 워드프레스에 저장되면서
    ' → &#8216; / ' → &#8217; 로 표시되는 문제가 있었는데, 원인은
    원고 자체에 둥근따옴표로 된 튜플 표기가 남아있었기 때문입니다.

    괄호/따옴표가 없는 정상 텍스트는 건드리지 않습니다.
    """
    if not text:
        return text

    quote_chars = "['\"\u2018\u2019\u201c\u201d]"

    # ('구', '동') / ("구", "동") / ('구', '동') 등 → "구 동"
    text = re.sub(
        r"\(\s*" + quote_chars + r"([^'\"\u2018\u2019\u201c\u201d]+)" + quote_chars +
        r"\s*,\s*" + quote_chars + r"([^'\"\u2018\u2019\u201c\u201d]+)" + quote_chars + r"\s*\)",
        r"\1 \2",
        text,
    )

    return text


def build_meta_description_from_title(title, target_len=160):
    """
    SEO 메타 설명(_yoast_wpseo_metadesc)은 본문에서 문장을 뽑지 않고
    제목을 바탕으로 직접 만듭니다.

    이유: 본문은 opening/context 같은 작은 문구 풀에서 문장이
    뽑히는 구조라, 첫 문장이든 두 번째 문장이든 인용구 뒤에 붙는
    설명 문장이든 결국 어딘가에서 다른 글과 통째로 겹치는 문제가
    반복됐습니다. 반면 제목은 구/동/증상이 항상 다르게 조합되어
    있어(실제로 슬러그가 전부 다르다는 것으로 이미 확인됨) 이걸
    바탕으로 만들면 겹칠 걱정이 거의 없습니다.
    """
    title = re.sub(r"\s+", " ", title).strip()
    tail = " 관련 전기수리 현장 점검 사례입니다. 원인 확인부터 조치까지 확인해보세요."

    combined = title.rstrip(". ") + tail
    if len(combined) <= target_len:
        return combined

    return title[:target_len]


def pick_excerpt_skip_intro(plain_text, target_len=160):
    """
    발췌(excerpt)를 만들 때, 맨 앞 도입부 문장들을 건너뛰고 그
    글만의 구체적인 내용부터 시작하도록 뽑습니다.

    이유: 자동생성 글의 도입부는 작은 문구 풀(GEN_OPENING_VARIANTS,
    GEN_CONTEXT_VARIANTS 등)에서 뽑히는데, 이 풀의 가짓수가 많지
    않다 보니 서로 다른 구/동 글이라도 앞의 한두 문장이 통째로
    똑같이 겹치는 경우가 있습니다("...같은 상황을 살펴볼 때는
    증상이 언제, 어디에서..." 처럼). 문장 하나만 건너뛰는 것으로는
    부족해서, 아래 순서로 더 확실한 시작점을 찾습니다.

    1순위: 본문 안에 낫표(「」)로 감싼 구체적인 증상 문구가 있으면
           (예: 「누전차단기가 반복해서 떨어지는 경우」), 그 문장부터
           시작합니다. 이 낫표 문구는 100가지 증상 중 하나라 겹칠
           확률이 훨씬 낮습니다.
    2순위: 낫표 문구가 없으면, 앞의 두 문장을 건너뛰고 세 번째
           문장부터 시작합니다.
    3순위: 그래도 남은 글자가 너무 적으면 처음부터 그대로 사용합니다
           (손글처럼 도입부부터 이미 고유한 글도 이 경로로 처리됨).
    """
    plain_text = plain_text.strip()
    if not plain_text:
        return ""

    # 1순위: 낫표로 감싼 구체적인 증상 문구를 찾아 그 문장부터 시작
    quote_match = re.search(r"[^.!?」]*「[^」]+」[^.!?]*[.!?]", plain_text)
    if quote_match and len(plain_text) - quote_match.start() >= 40:
        return plain_text[quote_match.start():quote_match.start() + target_len]

    # 한국어 문장 종결(다./요./음./까?/음!) 뒤 공백을 문장 경계로 봅니다.
    sentence_ends = [m.end() for m in re.finditer(r"(?:다|요|음|까|죠)[.!?]\s+", plain_text)]

    # 2순위: 앞의 두 문장을 건너뛰고 세 번째 문장부터
    rest = ""
    if len(sentence_ends) >= 2:
        rest = plain_text[sentence_ends[1]:].strip()
    elif len(sentence_ends) == 1:
        rest = plain_text[sentence_ends[0]:].strip()

    # 3순위: 남은 글자 수가 너무 적으면(예: 본문이 짧은 글) 처음부터 사용
    if len(rest) < 40:
        rest = plain_text

    return rest[:target_len]


def build_txt_post(gu, dong, work_type, used_titles=None):
    """
    TXT 완성 본문을 워드프레스용 HTML로 변환합니다.
    """
    used_titles = used_titles or set()

    case = get_txt_case_for_location(
        gu,
        dong,
        work_type,
        used_titles=used_titles,
    )

    # 이 동에 맞는 사례를 못 찾아 다른 지역용 사례를 대신 쓰게 된 경우,
    # 제목/배너/본문에 남아있는 원래 지역명을 실제 등록 대상 지역명으로
    # 강제로 바꿔서 "제목은 A동, 배너는 B동"처럼 어긋나지 않게 합니다.
    target_location = f"{gu} {dong}"
    case_location = (case.get("location") or "").strip()

    raw_title = case["title"]
    raw_body_text = case["body"]

    if case_location and case_location != target_location:
        raw_title = raw_title.replace(case_location, target_location)
        raw_body_text = raw_body_text.replace(case_location, target_location)

        # "구/시" 이름만 따로 언급되는 문장도 있을 수 있어, 지역 앞부분(구·시)만
        # 따로도 한 번 더 바꿔줍니다. (예: "안성시" 단독 언급)
        case_gu = case_location.split(" ")[0] if case_location else ""
        if case_gu and case_gu != gu:
            raw_title = raw_title.replace(case_gu, gu)
            raw_body_text = raw_body_text.replace(case_gu, gu)

    title = strip_gyeongu(clean_tuple_artifacts(raw_title))
    title = vary_text(title)
    used_titles.add(title)

    # TXT 본문은 일반 텍스트 형식이므로 제목/본문을 HTML로 변환
    raw_body = clean_tuple_artifacts(raw_body_text.strip())
    raw_body = vary_text(raw_body)

    html_parts = []

    for paragraph in re.split(r"\n\s*\n", raw_body):
        paragraph = paragraph.strip()

        if not paragraph:
            continue

        if paragraph.startswith("## "):
            heading = html.escape(paragraph[3:].strip())
            html_parts.append(f"<h2>{heading}</h2>")

        elif paragraph.startswith("### "):
            heading = html.escape(paragraph[4:].strip())
            html_parts.append(f"<h3>{heading}</h3>")

        elif paragraph.startswith("- "):
            items = [
                html.escape(x[2:].strip())
                for x in paragraph.splitlines()
                if x.strip().startswith("- ")
            ]
            if items:
                html_parts.append(
                    "<ul>" +
                    "".join(f"<li>{item}</li>" for item in items) +
                    "</ul>"
                )

        else:
            # 긴 TXT 문단을 그대로 한 덩어리로 출력하지 않고,
            # 문장 2~3개 정도를 하나의 "읽기용 문단"으로 묶습니다.
            # 이렇게 하면 화면에서 문단 단위가 확실하게 보이고
            # 지나치게 긴 한 문단이 생기는 것을 막습니다.
            normalized = re.sub(r"\s+", " ", paragraph).strip()

            # 한국어 문장 종결부호 기준으로 문장을 분리하되
            # 약어/숫자 때문에 생기는 불필요한 분리는 최소화합니다.
            sentences = re.split(r"(?<=[.!?。！？])\s+", normalized)

            # 한국어 본문은 '다.' 뒤의 공백도 문장 경계로 취급
            if len(sentences) == 1:
                sentences = re.split(r"(?<=다\.)\s+", normalized)

            sentences = [s.strip() for s in sentences if s.strip()]

            groups = []
            current_group = []

            for sentence in sentences:
                current_group.append(sentence)

                # 문장 2개마다 새 문단.
                # 문장이 너무 긴 경우 1개만으로도 문단을 닫습니다.
                if len(current_group) >= 2 or len(" ".join(current_group)) >= 420:
                    groups.append(" ".join(current_group))
                    current_group = []

            if current_group:
                groups.append(" ".join(current_group))

            # 문장 분리가 안 되는 특수 블록은 원문 그대로 1문단 처리
            if not groups:
                groups = [normalized]

            for group in groups:
                escaped = html.escape(group)
                html_parts.append(
                    f'<p style="{BODY_PARAGRAPH_STYLE}">'
                    f"{escaped}</p>"
                )

    body = "".join(html_parts)

    # TXT의 지역/소재와 제목을 그대로 유지하되,
    # Python이 지역에 맞는 글을 선택하는 역할만 수행
    #
    # body는 이미 html.escape()를 거쳐 '(작은따옴표) 같은 문자가
    # &#x27; 같은 HTML 엔티티 "글자"로 박혀 있습니다. 태그만 지우고
    # 엔티티를 다시 원래 글자로 풀어주지 않으면, 네이버 검색결과
    # 요약이나 메타설명에 &#39;/&#x27; 같은 글자가 그대로 노출됩니다.
    excerpt = re.sub(r"<[^>]+>", " ", body)
    # 혹시라도 어딘가에서 이중으로 인코딩됐을 가능성까지 대비해서
    # 더는 안 바뀔 때까지 반복 해제합니다(안전장치).
    for _ in range(3):
        unescaped_once = html.unescape(excerpt)
        if unescaped_once == excerpt:
            break
        excerpt = unescaped_once
    excerpt = re.sub(r"\s+", " ", excerpt).strip()
    excerpt = pick_excerpt_skip_intro(excerpt)

    focus_keyword = case.get("topic") or work_type
    seo_title = title[:70]

    image_url = random.choice(BANNER_IMAGE_URLS)

    body_with_banners = insert_mid_banners(
        body,
        BANNER_IMAGE_URLS
    )

    full_content = (
        get_top_banner(gu, dong, image_url)
        + body_with_banners
        + build_related_tags_html(gu, dong)
        + get_bottom_banner(image_url)
    )

    slug = make_slug_from_title(title)

    return {
        "title": title,
        "slug": slug,
        "content": full_content,
        "excerpt": excerpt,
        "seo_title": seo_title,
        "meta_description": build_meta_description_from_title(title),
        "focus_keyword": focus_keyword[:80],
    }



# =========================================================
# 제목 → 한글 URL slug
# =========================================================

def make_slug_from_title(title):
    """
    WordPress에 맡기지 않고 Python에서 제목 기반 한글 slug를 확정한다.
    """
    title = str(title or "").strip()

    # URL에 쓰지 않을 문자를 공백으로 치환
    slug = re.sub(r"[^\w가-힣\s-]", " ", title, flags=re.UNICODE)

    # 공백/연속 하이픈 정리
    slug = re.sub(r"[\s_]+", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")

    if not slug:
        raise RuntimeError(
            f"제목에서 slug를 만들지 못했습니다: {title}"
        )

    return slug.lower()




# =========================================================
# 7. WordPress / Yoast
# =========================================================

def find_existing_case(slug, auth):
    """같은 slug가 있으면 ID와 링크를 반환."""
    try:
        response = requests.get(
            ELECTRIC_CASE_ENDPOINT,
            params={"slug": slug, "per_page": 1},
            auth=auth,
            timeout=30,
        )

        if response.status_code != 200:
            return None

        items = response.json()
        if items:
            return items[0]

    except requests.RequestException as e:
        print(f"⚠️ 기존 글 확인 실패: {e}")

    return None


# =========================================================
# 이미 올라간 글의 발췌/메타 설명만 다시 계산해서 고치기
# ---------------------------------------------------------
# 네이버가 "메타 설명이 여러 문서에서 동일하다"고 지적한 예전 글들을
# 위한 수리 도구입니다. 제목·본문·슬러그는 절대 건드리지 않고,
# 그 글의 실제 본문(배너 문구 제외)에서 발췌를 새로 뽑아
# excerpt / _yoast_wpseo_metadesc 두 필드만 다시 저장합니다.
# =========================================================

def _strip_balanced_div_block(text, start_marker_regex):
    """
    start_marker_regex와 매칭되는 <div ...> 여는 태그를 찾아서,
    그 div에 대응하는 </div>까지(중첩된 다른 div들 포함해서 정확히)
    통째로 제거합니다. 정규식만으로는 여러 겹으로 중첩된 div를
    정확히 잘라낼 수 없어서, 여는/닫는 태그 개수를 직접 세어
    짝을 맞춥니다.
    """
    m = re.search(start_marker_regex, text)
    if not m:
        return text

    start = m.start()
    # 시작 태그 자체의 끝(>) 위치부터 탐색 시작
    pos = m.end()
    depth = 1

    tag_re = re.compile(r"<(/?)div\b[^>]*>", re.I)

    for tm in tag_re.finditer(text, pos):
        if tm.group(1):  # 닫는 태그 </div>
            depth -= 1
        else:  # 여는 태그 <div ...>
            depth += 1

        if depth == 0:
            end = tm.end()
            return text[:start] + " " + text[end:]

    # 짝을 못 찾으면(비정상 HTML) 원본을 그대로 반환합니다.
    return text


def extract_body_text_only(html_content):
    """
    워드프레스에 저장된 완성 HTML(상단배너+4칸 아이콘+본문+태그+
    하단배너)에서 배너/아이콘/태그 부분을 제외한 "진짜 본문"만
    뽑아냅니다.

    이전 방식(특정 <p style="..."> 스타일만 찾기)은 예전에 다른
    방식으로 만들어진 글에서 매칭에 실패해, 결국 배너 문구가 그대로
    발췌에 섞여 들어가는 문제가 있었습니다. 이번 방식은 스타일에
    의존하지 않고, 상단/중간/하단 배너를 감싸는
    <a href="tel:...">...</a> 블록과 4칸 아이콘 그리드 div를
    (중첩 구조까지 정확히 짝을 맞춰) 통째로 제거하고, "관련 태그"
    섹션도 제거한 뒤 남은 부분만 사용합니다.
    """
    text = html_content

    # 1) 상단/중간/하단 배너: 전부 <a href="tel:...">...</a> 로 감싸져
    #    있으므로 이 블록들을 통째로 제거합니다.
    text = re.sub(
        r'<a href="tel:[^"]*"[^>]*>.*?</a>',
        " ",
        text,
        flags=re.S,
    )

    # 2) 4칸 아이콘 그리드(누전 출장 수리 / 차단기·배선 교체 등)도
    #    배너에 딸린 부분이라 함께 제거합니다. 여러 겹으로 중첩된
    #    div 구조라 여는/닫는 태그 짝을 직접 맞춰서 잘라냅니다.
    #    (예전 글은 "repeat(4,..." 최신 글은 "repeat(auto-fit,..."
    #    처럼 표기가 다를 수 있어 둘 다 매칭되게 합니다.)
    text = _strip_balanced_div_block(
        text,
        r'<div style="display:grid;grid-template-columns:repeat\((?:4|auto-fit)[^>]*>',
    )

    # 3) "관련 태그" 섹션(알약 모양 태그 목록)도 제거합니다.
    text = re.sub(
        r'<h[23][^>]*>\s*관련\s*태그\s*</h[23]>.*$',
        " ",
        text,
        flags=re.S,
    )

    # 4) 남은 HTML에서 태그만 지우고 텍스트만 남깁니다.
    text = re.sub(r"<[^>]+>", " ", text)

    for _ in range(3):
        unescaped_once = html.unescape(text)
        if unescaped_once == text:
            break
        text = unescaped_once

    return re.sub(r"\s+", " ", text).strip()


def fix_meta_description_by_slug(slug, auth):
    """
    slug로 기존 글을 찾아, excerpt와 Yoast 메타 설명을 업데이트합니다.
    제목/본문/슬러그는 그대로 유지됩니다(다른 필드를 payload에 안
    넣으면 워드프레스가 기존 값을 그대로 둡니다).

    - excerpt(카드 미리보기용): 본문에서 뽑은 자연스러운 문장
    - _yoast_wpseo_metadesc(검색결과용): 제목을 바탕으로 직접 생성
      (본문 문장은 재료 풀이 작아 다른 글과 겹치는 경우가 있었지만,
      제목은 구/동/증상이 항상 다르게 조합되어 있어 훨씬 안전합니다)
    """
    existing = find_existing_case(slug, auth)
    if not existing:
        print(f"❌ 못 찾음: {slug}")
        return False

    post_id = existing.get("id")
    raw_content = existing.get("content", {}).get("rendered", "")
    raw_title = existing.get("title", {}).get("rendered", "")
    title_text = re.sub(r"<[^>]+>", " ", raw_title)
    title_text = html.unescape(title_text)
    title_text = re.sub(r"\s+", " ", title_text).strip()

    body_text = extract_body_text_only(raw_content)
    if not body_text:
        # 혹시 본문 문단 스타일을 못 찾으면, 최후 수단으로 전체
        # content에서 태그만 지우고 사용합니다(배너 문구가 섞일 수 있음).
        body_text = re.sub(r"<[^>]+>", " ", raw_content)
        body_text = html.unescape(body_text)
        body_text = re.sub(r"\s+", " ", body_text).strip()

    new_excerpt = pick_excerpt_skip_intro(body_text)
    new_meta_description = build_meta_description_from_title(title_text or new_excerpt)

    payload = {
        "excerpt": new_excerpt,
        "meta": {
            "_yoast_wpseo_metadesc": new_meta_description,
        },
    }

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json=payload,
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 요청 실패: {slug} - {e}")
        return False

    if response.status_code in (200, 201):
        print(f"✅ 수정 완료: {slug}")
        print(f"   새 메타 설명: {new_meta_description[:60]}...")
        return True

    print(f"❌ 수정 실패 ({response.status_code}): {slug}")
    print(response.text[:500])
    return False


def fix_meta_description_by_post(post_summary, auth):
    """
    이미 REST API 목록 조회로 받아온 글 데이터(post_summary)를 그대로
    사용해서 발췌/메타 설명을 다시 계산해 저장합니다.
    fix_meta_description_by_slug와 로직은 같지만, 목록을 훑을 때
    한 건마다 다시 GET 요청을 보내지 않아도 되도록 만든 버전입니다.
    """
    post_id = post_summary.get("id")
    raw_content = post_summary.get("content", {}).get("rendered", "")
    raw_title = post_summary.get("title", {}).get("rendered", "")
    raw_meta = post_summary.get("meta", {}) or {}
    existing_metadesc = raw_meta.get("_yoast_wpseo_metadesc", "")

    title_text = re.sub(r"<[^>]+>", " ", raw_title)
    title_text = html.unescape(title_text)
    title_text = re.sub(r"\s+", " ", title_text).strip()

    body_text = extract_body_text_only(raw_content)
    if not body_text:
        body_text = re.sub(r"<[^>]+>", " ", raw_content)
        body_text = html.unescape(body_text)
        body_text = re.sub(r"\s+", " ", body_text).strip()

    new_excerpt = pick_excerpt_skip_intro(body_text)
    new_meta_description = build_meta_description_from_title(title_text or new_excerpt)

    # "이미 값이 있으면 무조건 건너뛴다"가 아니라, 지금 제목 기준으로
    # 다시 계산한 값과 실제 저장된 값이 완전히 같을 때만 건너뜁니다.
    # (예전에 제목이 "('구', '동') ..." 튜플 형태였을 때 만들어진
    # description이 나중에 제목만 FIX_TITLE_TUPLE_ALL로 정리되고
    # description은 그대로 남아있던 경우, 예전 방식은 "값이 있다"는
    # 이유로 영원히 건너뛰어서 튜플 잔재가 안 고쳐졌습니다. 값을
    # 비교해서 다르면 다시 저장하도록 바꿔 이런 경우도 잡습니다.)
    if existing_metadesc == new_meta_description:
        return "skip"

    payload = {
        "excerpt": new_excerpt,
        "meta": {
            "_yoast_wpseo_metadesc": new_meta_description,
        },
    }

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json=payload,
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 요청 실패 (ID {post_id}): {e}")
        return False

    if response.status_code in (200, 201):
        print(f"✅ 수정 완료 (ID {post_id}): {title_text[:40]}")
        return True

    print(f"❌ 수정 실패 (ID {post_id}, {response.status_code})")
    return False



def fix_featured_image_by_post(post_summary, auth):
    """
    글에 대표이미지(featured_media)가 없으면 기본 이미지
    (BANNER_IMAGE_URLS 중 하나)로 채웁니다. 이미 대표이미지가
    지정된 글은 건드리지 않고 건너뜁니다.
    """
    post_id = post_summary.get("id")
    raw_title = post_summary.get("title", {}).get("rendered", "")
    title_text = html.unescape(re.sub(r"<[^>]+>", " ", raw_title))
    title_text = re.sub(r"\s+", " ", title_text).strip()

    if post_summary.get("featured_media"):
        return "skip"

    media_id = resolve_default_featured_media_id(auth)
    if not media_id:
        return False

    payload = {"featured_media": int(media_id)}

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json=payload,
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 요청 실패 (ID {post_id}): {e}")
        return False

    if response.status_code in (200, 201):
        print(f"✅ 대표이미지 지정 완료 (ID {post_id}): {title_text[:40]}")
        return True

    print(f"❌ 대표이미지 지정 실패 (ID {post_id}, {response.status_code})")
    return False


def run_fix_featured_image_all():
    """
    electric_case 글 전체를 끝까지 훑으면서(페이지네이션) 대표이미지가
    없는 글에 기본 이미지를 대표이미지로 지정합니다. 이미 대표이미지가
    있는 글은 건드리지 않고 건너뜁니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    page = 1
    per_page = 50
    total_checked = 0
    total_fixed = 0
    total_skipped = 0

    print("==============================================")
    print("electric_case 글 전체를 훑으며 대표이미지가 없는 글을 고칩니다...")
    print("==============================================")

    while True:
        try:
            response = requests.get(
                ELECTRIC_CASE_ENDPOINT,
                params={
                    "per_page": per_page,
                    "page": page,
                    "status": "publish,future,draft",
                    "context": "edit",
                    "_fields": "id,title,featured_media",
                },
                auth=auth,
                timeout=45,
            )
        except requests.RequestException as e:
            print(f"❌ 목록 조회 실패 (page {page}): {e}")
            break

        if response.status_code == 400:
            break
        if response.status_code != 200:
            print(f"❌ 목록 조회 실패 (page {page}, {response.status_code})")
            break

        items = response.json()
        if not items:
            break

        for item in items:
            total_checked += 1
            result = fix_featured_image_by_post(item, auth)
            if result is True:
                total_fixed += 1
            elif result == "skip":
                total_skipped += 1
            time.sleep(0.8)

        print(f"--- {page}페이지 처리 완료 (지금까지 확인 {total_checked}개, 수정 {total_fixed}개) ---")
        page += 1

    print("==============================================")
    print(f"전체 완료: 확인 {total_checked}개 / 수정 {total_fixed}개 / 이미 대표이미지 있어서 건너뜀 {total_skipped}개")
    print("==============================================")


def fix_unique_thumbnail_by_post(post_summary, auth):
    """
    글마다 고유한 썸네일을 새로 만들어 대표이미지로 교체합니다.
    (배너 이미지 2장을 수백 개 글이 나눠 쓰던 걸, 글마다 다른
    이미지로 바꾸기 위한 일괄 작업입니다.) 기존에 붙어있던
    대표이미지가 있으면 새 걸로 교체한 뒤 미디어 라이브러리에서
    지워서 용량을 정리합니다. 제목에서 지역(구/동)을 못 찾으면
    건너뜁니다.
    """
    post_id = post_summary.get("id")
    raw_title = post_summary.get("title", {}).get("rendered", "")
    title_text = html.unescape(re.sub(r"<[^>]+>", " ", raw_title))
    title_text = re.sub(r"\s+", " ", title_text).strip()

    acf = post_summary.get("acf") or {}
    gu = (acf.get("district") or "").strip()
    dong = (acf.get("dong") or "").strip()
    if not (gu and dong):
        gu, dong = guess_gu_dong_from_title(title_text)
    if not gu:
        print(f"⚠️ 제목에서 지역을 못 찾아 건너뜀 (ID {post_id}): {title_text[:40]}")
        return "skip"

    old_media_id = post_summary.get("featured_media") or 0

    new_media_id = build_unique_featured_media_id(gu, dong, title_text, auth)
    if not new_media_id:
        print(f"❌ 썸네일 생성/업로드 실패 (ID {post_id})")
        return False

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json={"featured_media": int(new_media_id)},
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 대표이미지 교체 실패 (ID {post_id}): {e}")
        return False

    if response.status_code not in (200, 201):
        print(f"❌ 대표이미지 교체 실패 (ID {post_id}, {response.status_code})")
        return False

    # 기존 대표이미지가 있었고, 방금 새로 만든 이미지와 다르면(=공통
    # 배너가 아니라 예전에 생성됐던 이미지라면) 미디어 라이브러리에서
    # 지워서 용량을 정리합니다. 공통 배너 이미지(BANNER_IMAGE_URLS)는
    # 다른 글에서도 계속 쓰이므로 지우지 않습니다.
    if old_media_id and old_media_id != new_media_id:
        try:
            media_response = requests.get(
                f"{WP_URL}/wp-json/wp/v2/media/{old_media_id}",
                params={"_fields": "id,source_url"},
                auth=auth,
                timeout=30,
            )
            old_source_url = media_response.json().get("source_url") if media_response.status_code == 200 else None
        except requests.RequestException:
            old_source_url = None

        if old_source_url not in BANNER_IMAGE_URLS:
            try:
                requests.delete(
                    f"{WP_URL}/wp-json/wp/v2/media/{old_media_id}",
                    params={"force": "true"},
                    auth=auth,
                    timeout=30,
                )
            except requests.RequestException as e:
                print(f"⚠️ 기존 이미지 삭제 실패 (미디어ID {old_media_id}): {e}")

    print(f"✅ 고유 썸네일 교체 완료 (ID {post_id}): {title_text[:40]}")
    return True


def run_fix_unique_thumbnail_all():
    """
    electric_case 글 전체를 끝까지 훑으면서(페이지네이션) 모든 글의
    대표이미지를 글마다 고유한 새 썸네일로 교체합니다. 배너 이미지
    2장을 수백 개 글이 공유하던 문제를 해결하기 위한 일괄 작업입니다.
    (전체 글 수만큼 이미지를 새로 만들고 업로드하므로 시간이 오래
    걸릴 수 있습니다 — 글 1개당 몇 초씩 소요됩니다.)
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    page = 1
    per_page = 20
    total_checked = 0
    total_fixed = 0
    total_skipped = 0

    print("==============================================")
    print("electric_case 글 전체를 훑으며 고유 썸네일로 교체합니다...")
    print("(글 1개당 몇 초씩 걸립니다 — 시간이 꽤 걸릴 수 있어요)")
    print("==============================================")

    while True:
        try:
            response = requests.get(
                ELECTRIC_CASE_ENDPOINT,
                params={
                    "per_page": per_page,
                    "page": page,
                    "status": "publish,future,draft",
                    "context": "edit",
                    "_fields": "id,title,featured_media,acf",
                },
                auth=auth,
                timeout=45,
            )
        except requests.RequestException as e:
            print(f"❌ 목록 조회 실패 (page {page}): {e}")
            break

        if response.status_code == 400:
            break
        if response.status_code != 200:
            print(f"❌ 목록 조회 실패 (page {page}, {response.status_code})")
            break

        items = response.json()
        if not items:
            break

        for item in items:
            total_checked += 1
            result = fix_unique_thumbnail_by_post(item, auth)
            if result is True:
                total_fixed += 1
            elif result == "skip":
                total_skipped += 1

        print(f"--- {page}페이지 처리 완료 (지금까지 확인 {total_checked}개, 교체 {total_fixed}개) ---")
        page += 1

    print("==============================================")
    print(f"전체 완료: 확인 {total_checked}개 / 교체 {total_fixed}개 / 지역 못 찾아 건너뜀 {total_skipped}개")
    print("==============================================")


def remove_featured_image_by_post(post_summary, auth):
    """
    글에 대표이미지(featured_media)가 지정돼있으면 완전히 제거합니다
    (테마가 제목 위에 작게 표시하던 대표이미지를 없애기 위함).
    파일 자체는 미디어 라이브러리에서 지우지 않고, 그 글에서
    "대표이미지" 지정만 해제합니다. 원래부터 대표이미지가 없던
    글은 건드리지 않습니다.
    """
    post_id = post_summary.get("id")
    raw_title = post_summary.get("title", {}).get("rendered", "")
    title_text = html.unescape(re.sub(r"<[^>]+>", " ", raw_title))
    title_text = re.sub(r"\s+", " ", title_text).strip()

    featured_id = post_summary.get("featured_media") or 0

    # 매 글마다 실제로 읽은 featured_media 값을 그대로 찍습니다.
    # (이전에 "확인 200개 / 제거 0개"처럼 원인을 알 수 없던 상황을
    # 다시 겪지 않기 위해, 값이 있는지 없는지 눈으로 바로 보이게 함)
    print(f"   ID {post_id} featured_media={featured_id} : {title_text[:40]}")

    if not featured_id:
        return "skip"

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json={"featured_media": 0},
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 요청 실패 (ID {post_id}): {e}")
        return False

    if response.status_code in (200, 201):
        print(f"✅ 대표이미지 제거 완료 (ID {post_id}): {title_text[:40]}")
        return True

    print(f"❌ 대표이미지 제거 실패 (ID {post_id}, {response.status_code}): {response.text[:200]}")
    return False


def run_remove_featured_image_all():
    """
    electric_case 글 전체를 끝까지 훑으면서(페이지네이션) 대표이미지가
    지정된 글에서 그 지정을 전부 제거합니다. (테마가 제목 위에 작게
    표시하던 대표이미지 썸네일을 없애기 위함 — og:image는 다시
    사이트 로고로 대체됩니다.)

    status를 "publish,future,draft"로 한 번에 묶어서 조회하던 방식이
    일부 워드프레스 환경에서 제대로 안 걸러지는 경우가 있어(그래서
    "확인 200개 / 제거 0개"처럼 이상하게 나온 적이 있었습니다),
    이번엔 상태별로 완전히 따로따로 조회합니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    total_checked = 0
    total_fixed = 0
    total_skipped = 0

    print("==============================================")
    print("electric_case 글 전체를 훑으며 대표이미지를 제거합니다...")
    print("==============================================")

    for status in ("publish", "future", "draft"):
        page = 1
        per_page = 50
        print(f"\n### status={status} 조회 시작 ###")

        while True:
            try:
                response = requests.get(
                    ELECTRIC_CASE_ENDPOINT,
                    params={
                        "per_page": per_page,
                        "page": page,
                        "status": status,
                        "context": "edit",
                        "_fields": "id,title,featured_media",
                    },
                    auth=auth,
                    timeout=45,
                )
            except requests.RequestException as e:
                print(f"❌ 목록 조회 실패 (status={status}, page {page}): {e}")
                break

            if response.status_code == 400:
                break
            if response.status_code != 200:
                print(f"❌ 목록 조회 실패 (status={status}, page {page}, {response.status_code})")
                break

            items = response.json()
            if not items:
                break

            for item in items:
                total_checked += 1
                result = remove_featured_image_by_post(item, auth)
                if result is True:
                    total_fixed += 1
                elif result == "skip":
                    total_skipped += 1
                time.sleep(0.8)

            print(f"--- status={status} {page}페이지 처리 완료 (지금까지 확인 {total_checked}개, 제거 {total_fixed}개) ---")
            page += 1

    print("==============================================")
    print(f"전체 완료: 확인 {total_checked}개 / 제거 {total_fixed}개 / 원래 없어서 건너뜀 {total_skipped}개")
    print("==============================================")


# =========================================================
# 기존 글 전체 대표이미지를 새 로고 파일로 강제 지정
# ---------------------------------------------------------
# WPCode에 og:image 강제 고정 필터(wpseo_opengraph_image)를
# 이미 걸어뒀다면 이 스크립트 없이도 og:image는 정상 작동합니다.
# 이건 그거랑 별개로, 대표이미지(featured_media) 데이터 자체도
# 이 로고로 통일해두고 싶을 때 쓰는 "이중 방어"용입니다.
# =========================================================

TARGET_LOGO_URL = "https://24elecspeed.com/wp-content/uploads/2026/09/24elecspeed_로고_520x520.png"


@functools.lru_cache(maxsize=8)
def resolve_media_id_by_url(target_url, auth, wp_url=WP_URL):
    """
    target_url과 source_url이 정확히 일치하는 미디어 항목을
    id 오름차순으로 찾아서 미디어ID를 반환합니다. 못 찾으면
    None을 반환합니다.
    """
    media_endpoint = f"{wp_url}/wp-json/wp/v2/media"
    page = 1
    per_page = 100
    max_pages = 10
    total_scanned = 0

    while page <= max_pages:
        try:
            response = requests.get(
                media_endpoint,
                params={
                    "per_page": per_page,
                    "page": page,
                    "orderby": "id",
                    "order": "desc",  # 최근 업로드분이라 최신순으로 찾는 게 더 빠름
                    "_fields": "id,source_url",
                },
                auth=auth,
                timeout=30,
            )
        except requests.RequestException as e:
            print(f"⚠️ 미디어 조회 중 오류: {e}")
            break

        if response.status_code != 200:
            break

        items = response.json()
        if not items:
            break

        total_scanned += len(items)
        for item in items:
            if item.get("source_url") == target_url:
                return item.get("id")

        page += 1

    print(f"⚠️ 대상 이미지를 미디어 라이브러리에서 찾지 못했습니다 "
          f"(미디어 {total_scanned}개 확인함): {target_url}")
    return None


def set_logo_featured_image_by_post(post_summary, auth, media_id):
    """
    글의 대표이미지를 무조건 media_id로 덮어씁니다(이미 다른
    이미지가 있어도 교체합니다). 이미 그 로고로 되어있는 글은
    건너뜁니다.
    """
    post_id = post_summary.get("id")
    raw_title = post_summary.get("title", {}).get("rendered", "")
    title_text = html.unescape(re.sub(r"<[^>]+>", " ", raw_title))
    title_text = re.sub(r"\s+", " ", title_text).strip()

    if post_summary.get("featured_media") == media_id:
        return "skip"

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json={"featured_media": int(media_id)},
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 요청 실패 (ID {post_id}): {e}")
        return False

    if response.status_code in (200, 201):
        print(f"✅ 로고로 대표이미지 지정 완료 (ID {post_id}): {title_text[:40]}")
        return True

    print(f"❌ 지정 실패 (ID {post_id}, {response.status_code}): {response.text[:200]}")
    return False


def run_set_logo_featured_image_all():
    """
    electric_case 글 전체(publish/future/draft)를 훑으면서,
    대표이미지를 전부 TARGET_LOGO_URL(로고 파일)로 강제 통일합니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    print("==============================================")
    print("로고 이미지의 미디어ID를 찾는 중...")
    print("==============================================")
    media_id = resolve_media_id_by_url(TARGET_LOGO_URL, auth)
    if not media_id:
        print("❌ 로고 이미지를 미디어 라이브러리에서 못 찾아서 중단합니다.")
        return
    print(f"✅ 로고 미디어ID: {media_id}\n")

    total_checked = 0
    total_fixed = 0
    total_skipped = 0

    for status in ("publish", "future", "draft"):
        page = 1
        per_page = 50
        print(f"### status={status} 조회 시작 ###")

        while True:
            try:
                response = requests.get(
                    ELECTRIC_CASE_ENDPOINT,
                    params={
                        "per_page": per_page,
                        "page": page,
                        "status": status,
                        "context": "edit",
                        "_fields": "id,title,featured_media",
                    },
                    auth=auth,
                    timeout=45,
                )
            except requests.RequestException as e:
                print(f"❌ 목록 조회 실패 (status={status}, page {page}): {e}")
                break

            if response.status_code == 400:
                break
            if response.status_code != 200:
                print(f"❌ 목록 조회 실패 (status={status}, page {page}, {response.status_code})")
                break

            items = response.json()
            if not items:
                break

            for item in items:
                total_checked += 1
                result = set_logo_featured_image_by_post(item, auth, media_id)
                if result is True:
                    total_fixed += 1
                elif result == "skip":
                    total_skipped += 1
                time.sleep(0.8)

            print(f"--- status={status} {page}페이지 처리 완료 (지금까지 확인 {total_checked}개, 지정 {total_fixed}개) ---")
            page += 1

    print("==============================================")
    print(f"전체 완료: 확인 {total_checked}개 / 지정 {total_fixed}개 / 이미 로고라서 건너뜀 {total_skipped}개")
    print("==============================================")


# =========================================================
# 예전 글을 "새로 쓴 글"과 똑같은 방식으로 맞추기 (본문은 안 건드림)
# ---------------------------------------------------------
# 새 글을 만들 때 py가 실제로 채우는 것: 대표이미지, Yoast 메타설명,
# ACF 지역(district/dong). 이 세 가지를 예전 글에도 그대로 적용
# 합니다. 본문(content)은 절대 안 건드립니다.
# =========================================================

def sync_post_like_new(post_summary, auth, logo_media_id):
    """
    글 하나에 대해 대표이미지 → 메타설명 → ACF 지역 순서로
    새 글과 동일한 값을 채웁니다. 이미 다 맞으면 "skip".
    본문(content)은 전혀 건드리지 않습니다.
    """
    post_id = post_summary.get("id")
    raw_title = post_summary.get("title", {}).get("rendered", "")
    title_text = html.unescape(re.sub(r"<[^>]+>", " ", raw_title))
    title_text = re.sub(r"\s+", " ", title_text).strip()

    changed_parts = []

    # 1) 대표이미지
    if logo_media_id and post_summary.get("featured_media") != logo_media_id:
        changed_parts.append("대표이미지")

    # 2) 메타설명
    raw_content = post_summary.get("content", {}).get("rendered", "")
    raw_meta = post_summary.get("meta", {}) or {}
    existing_metadesc = raw_meta.get("_yoast_wpseo_metadesc", "")

    body_text = extract_body_text_only(raw_content)
    if not body_text:
        body_text = re.sub(r"<[^>]+>", " ", raw_content)
        body_text = html.unescape(body_text)
        body_text = re.sub(r"\s+", " ", body_text).strip()

    new_excerpt = pick_excerpt_skip_intro(body_text)
    new_meta_description = build_meta_description_from_title(title_text or new_excerpt)
    if existing_metadesc != new_meta_description:
        changed_parts.append("메타설명")

    # 3) ACF 지역
    acf = post_summary.get("acf") or {}
    district = (acf.get("district") or "").strip()
    dong = (acf.get("dong") or "").strip()
    gu_guess, dong_guess = (None, None)
    if not (district and dong):
        gu_guess, dong_guess = guess_gu_dong_from_title(title_text)
        if gu_guess:
            changed_parts.append("ACF지역")

    if not changed_parts:
        return "skip"

    payload = {}
    if "대표이미지" in changed_parts:
        payload["featured_media"] = int(logo_media_id)
    if "메타설명" in changed_parts:
        payload["excerpt"] = new_excerpt
        payload["meta"] = {"_yoast_wpseo_metadesc": new_meta_description}
    if "ACF지역" in changed_parts:
        payload["acf"] = {"district": gu_guess, "dong": dong_guess}

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json=payload,
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 요청 실패 (ID {post_id}): {e}")
        return False

    if response.status_code in (200, 201):
        print(f"✅ [{', '.join(changed_parts)}] 동기화 완료 (ID {post_id}): {title_text[:40]}")
        return True

    print(f"❌ 동기화 실패 (ID {post_id}, {response.status_code}): {response.text[:200]}")
    return False


def run_sync_all_like_new():
    """
    electric_case 글 전체를 훑으며, 대표이미지/메타설명/ACF 지역을
    "새로 쓴 글"과 같은 기준으로 맞춥니다. 본문(content)은 절대
    안 건드립니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    print("==============================================")
    print("로고 이미지의 미디어ID를 찾는 중...")
    print("==============================================")
    logo_media_id = resolve_media_id_by_url(TARGET_LOGO_URL, auth)
    if not logo_media_id:
        print("⚠️ 로고 이미지를 못 찾았습니다 — 대표이미지 항목은 이번엔 건너뜁니다.")
    else:
        print(f"✅ 로고 미디어ID: {logo_media_id}\n")

    page = 1
    per_page = 50
    total_checked = 0
    total_fixed = 0
    total_skipped = 0

    print("==============================================")
    print("electric_case 글 전체를 훑으며 새 글 기준으로 동기화합니다...")
    print("(본문 내용은 전혀 안 건드립니다)")
    print("==============================================")

    while True:
        try:
            response = requests.get(
                ELECTRIC_CASE_ENDPOINT,
                params={
                    "per_page": per_page,
                    "page": page,
                    "status": "publish,future,draft",
                    "context": "edit",
                    "_fields": "id,title,content,featured_media,acf,meta",
                },
                auth=auth,
                timeout=45,
            )
        except requests.RequestException as e:
            print(f"❌ 목록 조회 실패 (page {page}): {e}")
            break

        if response.status_code == 400:
            break
        if response.status_code != 200:
            print(f"❌ 목록 조회 실패 (page {page}, {response.status_code})")
            break

        items = response.json()
        if not items:
            break

        for item in items:
            total_checked += 1
            result = sync_post_like_new(item, auth, logo_media_id)
            if result is True:
                total_fixed += 1
            elif result == "skip":
                total_skipped += 1
            time.sleep(0.8)

        print(f"--- {page}페이지 처리 완료 (지금까지 확인 {total_checked}개, 동기화 {total_fixed}개) ---")
        page += 1

    print("==============================================")
    print(f"전체 완료: 확인 {total_checked}개 / 동기화 {total_fixed}개 / 이미 최신이라 건너뜀 {total_skipped}개")
    print("==============================================")


def run_fix_all_meta_descriptions():
    """
    네이버가 지적한 24개뿐 아니라, electric_case 글 타입 전체를
    끝까지 훑으면서(페이지네이션) 발췌/메타 설명이 비어있거나
    배너 문구("365일"로 시작)로 되어있는 글을 전부 찾아 고칩니다.
    이미 고유한 메타 설명이 저장된 글(이 도구로 이미 고쳐졌거나
    처음부터 정상이었던 글)은 건너뜁니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    page = 1
    per_page = 50
    total_checked = 0
    total_fixed = 0
    total_skipped = 0

    print("==============================================")
    print("electric_case 글 전체를 훑으며 메타 설명을 점검합니다...")
    print("==============================================")

    while True:
        try:
            response = requests.get(
                ELECTRIC_CASE_ENDPOINT,
                params={
                    "per_page": per_page,
                    "page": page,
                    "status": "publish,future,draft",
                    "_fields": "id,title,content,meta",
                },
                auth=auth,
                timeout=45,
            )
        except requests.RequestException as e:
            print(f"❌ 목록 조회 실패 (page {page}): {e}")
            break

        if response.status_code == 400:
            # 마지막 페이지를 넘어가면 워드프레스가 400을 돌려줍니다.
            break
        if response.status_code != 200:
            print(f"❌ 목록 조회 실패 (page {page}, {response.status_code})")
            break

        items = response.json()
        if not items:
            break

        for item in items:
            total_checked += 1
            result = fix_meta_description_by_post(item, auth)
            if result is True:
                total_fixed += 1
            elif result == "skip":
                total_skipped += 1
            time.sleep(0.8)

        print(f"--- {page}페이지 처리 완료 (지금까지 확인 {total_checked}개, 수정 {total_fixed}개) ---")
        page += 1

    print("==============================================")
    print(f"전체 완료: 확인 {total_checked}개 / 수정 {total_fixed}개 / 이미 정상이라 건너뜀 {total_skipped}개")
    print("==============================================")


# =========================================================
# 기존에 이미 등록된 글의 본문 가독성(문단 스타일)을 일괄로 고치는 도구
# -----------------------------------------------------------
# run_fix_all_meta_descriptions()와 같은 방식(REST API 페이지네이션)
# 으로 electric_case 글 전체를 훑되, 메타 설명이 아니라 본문 안의
# <p ...> 문단 태그 스타일 자체를 BODY_PARAGRAPH_STYLE 값으로
# 통일해서 다시 저장합니다. 배너/아이콘/태그 영역은 전부 <div>나
# <a href="tel:...">로 감싸져 있어 <p> 태그를 쓰지 않으므로,
# "<p ...>" 여는 태그만 골라 바꿔도 본문 문단만 안전하게 바뀝니다.
# =========================================================

_P_OPEN_TAG_RE = re.compile(r"<p(?:\s+[^>]*)?>", re.I)


def enhance_paragraph_readability(html_content):
    """
    본문 HTML 안의 모든 <p ...> 여는 태그를 BODY_PARAGRAPH_STYLE로
    통일합니다(스타일이 이미 있든 없든 전부 같은 값으로 교체).
    반환값은 (새 HTML, 실제로 뭔가 바뀌었는지 여부) 튜플입니다.
    """
    def repl(_m):
        return f'<p style="{BODY_PARAGRAPH_STYLE}">'

    new_content, count = _P_OPEN_TAG_RE.subn(repl, html_content)
    changed = count > 0 and new_content != html_content
    return new_content, changed


def fix_readability_by_post(post_summary, auth):
    """
    목록 조회로 이미 받아온 글 데이터(post_summary)의 본문 문단
    스타일을 BODY_PARAGRAPH_STYLE로 통일해서 저장합니다.
    바꿀 <p> 태그가 없거나 이미 최신 스타일이면 건드리지 않고
    "skip"을 돌려줍니다.
    """
    post_id = post_summary.get("id")
    raw_title = post_summary.get("title", {}).get("rendered", "")
    title_text = html.unescape(re.sub(r"<[^>]+>", " ", raw_title))
    title_text = re.sub(r"\s+", " ", title_text).strip()

    content_field = post_summary.get("content", {}) or {}
    # context=edit로 조회했다면 raw(원본, 아직 wpautop 등을 안 거친
    # 저장값)가 더 정확하므로 우선 쓰고, 없으면 rendered를 씁니다.
    raw_content = content_field.get("raw") or content_field.get("rendered", "")

    if "<p" not in raw_content.lower():
        return "skip"

    new_content, changed = enhance_paragraph_readability(raw_content)
    if not changed:
        return "skip"

    payload = {"content": new_content}

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json=payload,
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 요청 실패 (ID {post_id}): {e}")
        return False

    if response.status_code in (200, 201):
        print(f"✅ 가독성 수정 완료 (ID {post_id}): {title_text[:40]}")
        return True

    print(f"❌ 가독성 수정 실패 (ID {post_id}, {response.status_code})")
    print(response.text[:300])
    return False


def run_fix_readability_all():
    """
    electric_case 글 전체를 끝까지 훑으면서(페이지네이션) 본문 안의
    <p> 문단 스타일을 전부 BODY_PARAGRAPH_STYLE로 통일합니다.
    이미 최신 스타일인 글은 건드리지 않고 건너뜁니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    page = 1
    per_page = 50
    total_checked = 0
    total_fixed = 0
    total_skipped = 0

    print("==============================================")
    print("electric_case 글 전체를 훑으며 본문 가독성(문단 스타일)을 고칩니다...")
    print("==============================================")

    while True:
        try:
            response = requests.get(
                ELECTRIC_CASE_ENDPOINT,
                params={
                    "per_page": per_page,
                    "page": page,
                    "status": "publish,future,draft",
                    "context": "edit",
                    "_fields": "id,title,content",
                },
                auth=auth,
                timeout=45,
            )
        except requests.RequestException as e:
            print(f"❌ 목록 조회 실패 (page {page}): {e}")
            break

        if response.status_code == 400:
            break
        if response.status_code != 200:
            print(f"❌ 목록 조회 실패 (page {page}, {response.status_code})")
            break

        items = response.json()
        if not items:
            break

        for item in items:
            total_checked += 1
            result = fix_readability_by_post(item, auth)
            if result is True:
                total_fixed += 1
            elif result == "skip":
                total_skipped += 1
            time.sleep(0.8)

        print(f"--- {page}페이지 처리 완료 (지금까지 확인 {total_checked}개, 수정 {total_fixed}개) ---")
        page += 1

    print("==============================================")
    print(f"전체 완료: 확인 {total_checked}개 / 수정 {total_fixed}개 / 이미 최신이라 건너뜀 {total_skipped}개")
    print("==============================================")


# =========================================================
# 본문 중간 "전화연결 배너"(get_mid_banner) 문구/스타일 통일
# -----------------------------------------------------------
# get_mid_banner()의 문구("전기 문제가 반복된다면 / 현장 점검이
# 필요합니다")가 예전에는 다른 문구("혼자 판단하기 어렵다면 / 현장
# 점검이 가장 정확합니다" 등)였던 적이 있어서, 그때 만들어진 글은
# 지금도 예전 문구+예전 스타일 그대로 저장돼 있습니다. 그중 일부는
# 문구가 길어 박스 아래로 글자가 삐져나오는 문제도 있었습니다.
#
# data-electric-mid-banner="1" 속성으로 이 블록만 정확히 찾아서,
# 배경 이미지는 그대로 두고 문구와 스타일만 지금의 get_mid_banner()
# 결과로 통째로 새로 갈아 끼웁니다.
# =========================================================

_MID_BANNER_START_RE = re.compile(
    r'<a\b[^>]*href="tel:[^"]*"[^>]*>\s*<div\b[^>]*data-electric-mid-banner="1"[^>]*>',
    re.I,
)
_DIV_TAG_RE = re.compile(r"<(/?)div\b[^>]*>", re.I)


def rebuild_mid_banners_in_content(content):
    """
    본문 안의 모든 본문-중간 전화연결 배너 블록을 찾아 최신
    get_mid_banner() 마크업으로 교체합니다. 원래 쓰던 배경 이미지
    URL은 그대로 유지합니다. 반환값은 (새 본문, 변경 여부)입니다.
    """
    result_parts = []
    pos = 0
    changed = False

    while True:
        m = _MID_BANNER_START_RE.search(content, pos)
        if not m:
            result_parts.append(content[pos:])
            break

        block_start = m.start()
        div_open_end = m.end()

        style_match = re.search(r"url\('([^']+)'\)", content[block_start:div_open_end + 400])
        image_url = style_match.group(1) if style_match else random.choice(BANNER_IMAGE_URLS)

        depth = 1
        end_of_divs = None
        for tm in _DIV_TAG_RE.finditer(content, div_open_end):
            depth += -1 if tm.group(1) else 1
            if depth == 0:
                end_of_divs = tm.end()
                break

        if end_of_divs is None:
            result_parts.append(content[pos:m.end()])
            pos = m.end()
            continue

        close_a_match = re.match(r"\s*</a>", content[end_of_divs:end_of_divs + 20], re.I)
        if not close_a_match:
            result_parts.append(content[pos:m.end()])
            pos = m.end()
            continue

        block_end = end_of_divs + close_a_match.end()

        result_parts.append(content[pos:block_start])
        replacement = get_mid_banner(image_url).replace(
            '<a href="tel:',
            '<a data-mid-electric-banner="1" href="tel:',
            1,
        )
        result_parts.append(replacement)
        pos = block_end
        changed = True

    return "".join(result_parts), changed


def fix_mid_banner_by_post(post_summary, auth):
    """
    본문 중간 전화연결 배너 블록을 최신 문구/스타일로 통일해서
    저장합니다. 그런 블록이 없거나 이미 최신이면 "skip".
    """
    post_id = post_summary.get("id")
    raw_title = post_summary.get("title", {}).get("rendered", "")
    title_text = html.unescape(re.sub(r"<[^>]+>", " ", raw_title))
    title_text = re.sub(r"\s+", " ", title_text).strip()

    content_field = post_summary.get("content", {}) or {}
    raw_content = content_field.get("raw") or content_field.get("rendered", "")

    if 'data-electric-mid-banner="1"' not in raw_content and 'data-mid-electric-banner="1"' not in raw_content:
        return "skip"

    new_content, changed = rebuild_mid_banners_in_content(raw_content)
    if not changed:
        return "skip"

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json={"content": new_content},
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 요청 실패 (ID {post_id}): {e}")
        return False

    if response.status_code in (200, 201):
        print(f"✅ 중간 배너 통일 완료 (ID {post_id}): {title_text[:40]}")
        return True

    print(f"❌ 중간 배너 통일 실패 (ID {post_id}, {response.status_code})")
    print(response.text[:300])
    return False


def run_fix_mid_banner_all():
    """
    electric_case 글 전체를 훑으며 본문 중간 전화연결 배너의
    문구/스타일을 전부 지금의 get_mid_banner()로 통일합니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    page = 1
    per_page = 50
    total_checked = 0
    total_fixed = 0
    total_skipped = 0

    print("==============================================")
    print("electric_case 글 전체를 훑으며 중간 배너 문구를 통일합니다...")
    print("==============================================")

    while True:
        try:
            response = requests.get(
                ELECTRIC_CASE_ENDPOINT,
                params={
                    "per_page": per_page,
                    "page": page,
                    "status": "publish,future,draft",
                    "context": "edit",
                    "_fields": "id,title,content",
                },
                auth=auth,
                timeout=45,
            )
        except requests.RequestException as e:
            print(f"❌ 목록 조회 실패 (page {page}): {e}")
            break

        if response.status_code == 400:
            break
        if response.status_code != 200:
            print(f"❌ 목록 조회 실패 (page {page}, {response.status_code})")
            break

        items = response.json()
        if not items:
            break

        for item in items:
            total_checked += 1
            result = fix_mid_banner_by_post(item, auth)
            if result is True:
                total_fixed += 1
            elif result == "skip":
                total_skipped += 1
            time.sleep(0.8)

        print(f"--- {page}페이지 처리 완료 (지금까지 확인 {total_checked}개, 수정 {total_fixed}개) ---")
        page += 1

    print("==============================================")
    print(f"전체 완료: 확인 {total_checked}개 / 수정 {total_fixed}개 / 이미 최신이라 건너뜀 {total_skipped}개")
    print("==============================================")


# =========================================================
# 예전 글의 4칸 아이콘 그리드(누전 출장 수리 / 차단기·배선 교체 등)가
# "repeat(4,minmax(0,1fr))"로 고정돼 있어서, 좁은 모바일 화면에서도
# 4칸을 억지로 유지하다가 글자가 이상하게 줄바꿈되는 문제가
# 있었습니다. 지금 코드는 "repeat(auto-fit,minmax(130px,1fr))"를 써서
# 화면이 좁으면 자동으로 2×2로 재배치되는데, 예전 글은 여전히 옛날
# 값 그대로 저장되어 있어 이 모드로 일괄 교체합니다.
# =========================================================

def fix_icon_grid_by_post(post_summary, auth):
    """
    글 본문에 옛날 방식("repeat(4,minmax(0,1fr))")의 아이콘 그리드가
    있으면 지금 방식("repeat(auto-fit,minmax(130px,1fr))")으로
    바꿉니다. 이미 최신 방식이면 건드리지 않고 건너뜁니다.
    """
    post_id = post_summary.get("id")
    raw_title = post_summary.get("title", {}).get("rendered", "")
    title_text = html.unescape(re.sub(r"<[^>]+>", " ", raw_title))
    title_text = re.sub(r"\s+", " ", title_text).strip()

    content = post_summary.get("content", {}).get("rendered", "")

    old_pattern = "display:grid;grid-template-columns:repeat(4,minmax(0,1fr))"
    new_pattern = "display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))"

    if old_pattern not in content:
        return "skip"

    new_content = content.replace(old_pattern, new_pattern)

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json={"content": new_content},
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 요청 실패 (ID {post_id}): {e}")
        return False

    if response.status_code in (200, 201):
        print(f"✅ 아이콘 그리드 반응형으로 교체 완료 (ID {post_id}): {title_text[:40]}")
        return True

    print(f"❌ 교체 실패 (ID {post_id}, {response.status_code}): {response.text[:200]}")
    return False


def run_fix_icon_grid_all():
    """
    electric_case 글 전체를 훑으며 예전 방식(repeat(4,...))의 4칸
    아이콘 그리드를 지금 방식(repeat(auto-fit,...))으로 전부 교체합니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    page = 1
    per_page = 50
    total_checked = 0
    total_fixed = 0
    total_skipped = 0

    print("==============================================")
    print("electric_case 글 전체를 훑으며 아이콘 그리드를 반응형으로 교체합니다...")
    print("==============================================")

    while True:
        try:
            response = requests.get(
                ELECTRIC_CASE_ENDPOINT,
                params={
                    "per_page": per_page,
                    "page": page,
                    "status": "publish,future,draft",
                    "context": "edit",
                    "_fields": "id,title,content",
                },
                auth=auth,
                timeout=45,
            )
        except requests.RequestException as e:
            print(f"❌ 목록 조회 실패 (page {page}): {e}")
            break

        if response.status_code == 400:
            break
        if response.status_code != 200:
            print(f"❌ 목록 조회 실패 (page {page}, {response.status_code})")
            break

        items = response.json()
        if not items:
            break

        for item in items:
            total_checked += 1
            result = fix_icon_grid_by_post(item, auth)
            if result is True:
                total_fixed += 1
            elif result == "skip":
                total_skipped += 1
            time.sleep(0.8)

        print(f"--- {page}페이지 처리 완료 (지금까지 확인 {total_checked}개, 수정 {total_fixed}개) ---")
        page += 1

    print("==============================================")
    print(f"전체 완료: 확인 {total_checked}개 / 수정 {total_fixed}개 / 이미 최신이라 건너뜀 {total_skipped}개")
    print("==============================================")


# =========================================================
# ACF to REST API 플러그인 설치 전에 만들어진 글들은 district/dong
# (구/동) ACF 필드가 비어있습니다. 제목이 항상 "{구} {동} ..." 형태로
# 시작하므로, SEOUL_DATA/GYEONGGI_DATA에 있는 모든 (구,동) 조합과
# 제목 맨 앞을 대조해서 구/동을 알아낸 뒤 그 값으로 채웁니다.
# =========================================================

_ALL_LOCATIONS_FOR_TITLE_MATCH = None


def _get_all_locations_sorted_desc():
    """
    (구, 동) 조합 전체를, 제목과 대조할 때 쓸 문자열
    "{구} {동}"의 길이가 긴 것부터 먼저 검사하도록 정렬해서 돌려줍니다.
    ("성남시 분당구"처럼 구 이름 자체가 긴 경우를 짧은 다른 구/동
    조합이 먼저 걸려 잘못 매칭하는 일을 막기 위함입니다.)
    """
    global _ALL_LOCATIONS_FOR_TITLE_MATCH
    if _ALL_LOCATIONS_FOR_TITLE_MATCH is None:
        combos = []
        for gu, dongs in SEOUL_DATA.items():
            for dong in dongs:
                combos.append((gu, dong))
        for gu, dongs in GYEONGGI_DATA.items():
            for dong in dongs:
                combos.append((gu, dong))
        combos.sort(key=lambda gd: -len(f"{gd[0]} {gd[1]}"))
        _ALL_LOCATIONS_FOR_TITLE_MATCH = combos
    return _ALL_LOCATIONS_FOR_TITLE_MATCH


def guess_gu_dong_from_title(title_text):
    """
    "{구} {동} ..."로 시작하는 제목에서 구/동을 알아냅니다.
    못 찾으면 (None, None)을 돌려줍니다.
    """
    for gu, dong in _get_all_locations_sorted_desc():
        if title_text.startswith(f"{gu} {dong}"):
            return gu, dong
    return None, None


def fix_acf_fields_by_post(post_summary, auth):
    """
    district/dong ACF 필드가 비어있는 글을, 제목에서 알아낸 구/동
    값으로 채웁니다. 이미 둘 다 채워져 있으면 "skip".
    (symptom/cause/service는 제목만으로는 정확히 되짚어낼 수 없어
    이 도구에서는 건드리지 않습니다 — 새 글부터는 정상 저장됩니다.)
    """
    post_id = post_summary.get("id")
    raw_title = post_summary.get("title", {}).get("rendered", "")
    title_text = html.unescape(re.sub(r"<[^>]+>", " ", raw_title))
    title_text = re.sub(r"\s+", " ", title_text).strip()

    acf = post_summary.get("acf") or {}
    district = (acf.get("district") or "").strip()
    dong = (acf.get("dong") or "").strip()

    if district and dong:
        return "skip"

    gu, dong_guess = guess_gu_dong_from_title(title_text)
    if not gu:
        print(f"⚠️ 제목에서 지역을 못 찾음 (ID {post_id}): {title_text[:40]}")
        return "skip"

    payload = {"acf": {"district": gu, "dong": dong_guess}}

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json=payload,
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 요청 실패 (ID {post_id}): {e}")
        return False

    if response.status_code in (200, 201):
        print(f"✅ 지역 채움 완료 (ID {post_id}): {gu} {dong_guess} — {title_text[:30]}")
        return True

    print(f"❌ 지역 채움 실패 (ID {post_id}, {response.status_code})")
    print(response.text[:300])
    return False


def run_fix_acf_fields_all():
    """
    electric_case 글 전체를 훑으며, district/dong ACF 필드가 비어있는
    글에 제목에서 알아낸 구/동 값을 채워 넣습니다.
    (ACF to REST API 플러그인이 활성화되어 있어야 실제로 저장됩니다.)
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    page = 1
    per_page = 50
    total_checked = 0
    total_fixed = 0
    total_skipped = 0

    print("==============================================")
    print("electric_case 글 전체를 훑으며 빈 구/동 ACF 필드를 채웁니다...")
    print("==============================================")

    while True:
        try:
            response = requests.get(
                ELECTRIC_CASE_ENDPOINT,
                params={
                    "per_page": per_page,
                    "page": page,
                    "status": "publish,future,draft",
                    "context": "edit",
                    "_fields": "id,title,acf",
                },
                auth=auth,
                timeout=45,
            )
        except requests.RequestException as e:
            print(f"❌ 목록 조회 실패 (page {page}): {e}")
            break

        if response.status_code == 400:
            break
        if response.status_code != 200:
            print(f"❌ 목록 조회 실패 (page {page}, {response.status_code})")
            break

        items = response.json()
        if not items:
            break

        for item in items:
            total_checked += 1
            result = fix_acf_fields_by_post(item, auth)
            if result is True:
                total_fixed += 1
            elif result == "skip":
                total_skipped += 1
            time.sleep(0.8)

        print(f"--- {page}페이지 처리 완료 (지금까지 확인 {total_checked}개, 수정 {total_fixed}개) ---")
        page += 1

    print("==============================================")
    print(f"전체 완료: 확인 {total_checked}개 / 수정 {total_fixed}개 / 이미 채워져 있어 건너뜀 {total_skipped}개")
    print("==============================================")


# =========================================================
# 제목에 파이썬 튜플 문자열이 그대로 섞여 들어간 글(예: 원고 텍스트
# 자체에 "('성동구', '금호동') 주택 메인차단기가..."처럼 남아있던
# 경우) 전체를 훑어서 제목을 정리합니다. build_manual_post()가
# clean_tuple_artifacts를 안 거치던 시절 등록된 글들이 대상입니다.
# =========================================================

def fix_title_tuple_by_post(post_summary, auth):
    """
    제목에 튜플 문자열 흔적이 있으면 clean_tuple_artifacts +
    strip_gyeongu로 정리해서 저장합니다. 흔적이 없으면 "skip".
    """
    post_id = post_summary.get("id")
    raw_title = post_summary.get("title", {}).get("rendered", "")
    title_text = html.unescape(raw_title)

    fixed_title = strip_gyeongu(clean_tuple_artifacts(title_text))
    fixed_title = re.sub(r"\s+", " ", fixed_title).strip()
    title_text_normalized = re.sub(r"\s+", " ", title_text).strip()

    if fixed_title == title_text_normalized:
        return "skip"

    payload = {"title": fixed_title}

    try:
        response = requests.post(
            f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
            json=payload,
            auth=auth,
            timeout=45,
        )
    except requests.RequestException as e:
        print(f"❌ 요청 실패 (ID {post_id}): {e}")
        return False

    if response.status_code in (200, 201):
        print(f"✅ 제목 정리 완료 (ID {post_id}): {title_text_normalized[:35]} → {fixed_title[:35]}")
        return True

    print(f"❌ 제목 정리 실패 (ID {post_id}, {response.status_code})")
    print(response.text[:300])
    return False


def run_fix_title_tuple_all():
    """
    electric_case 글 전체를 훑으며, 제목에 남아있는 파이썬 튜플
    문자열 흔적("('구', '동') ...")을 정리합니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    page = 1
    per_page = 50
    total_checked = 0
    total_fixed = 0
    total_skipped = 0

    print("==============================================")
    print("electric_case 글 전체를 훑으며 제목의 튜플 흔적을 정리합니다...")
    print("==============================================")

    while True:
        try:
            response = requests.get(
                ELECTRIC_CASE_ENDPOINT,
                params={
                    "per_page": per_page,
                    "page": page,
                    "status": "publish,future,draft",
                    "_fields": "id,title",
                },
                auth=auth,
                timeout=45,
            )
        except requests.RequestException as e:
            print(f"❌ 목록 조회 실패 (page {page}): {e}")
            break

        if response.status_code == 400:
            break
        if response.status_code != 200:
            print(f"❌ 목록 조회 실패 (page {page}, {response.status_code})")
            break

        items = response.json()
        if not items:
            break

        for item in items:
            total_checked += 1
            result = fix_title_tuple_by_post(item, auth)
            if result is True:
                total_fixed += 1
            elif result == "skip":
                total_skipped += 1
            time.sleep(0.8)

        print(f"--- {page}페이지 처리 완료 (지금까지 확인 {total_checked}개, 수정 {total_fixed}개) ---")
        page += 1

    print("==============================================")
    print(f"전체 완료: 확인 {total_checked}개 / 수정 {total_fixed}개 / 정상이라 건너뜀 {total_skipped}개")
    print("==============================================")


# 네이버 서치어드바이저가 "동일한 설명문"으로 지적했던 24개 글의 슬러그.
# (전체를 자동으로 훑는 run_fix_all_meta_descriptions()를 만든 뒤로는
# 이 목록 대신 그쪽을 쓰는 것을 권장합니다. 특정 몇 개만 다시
# 확인하고 싶을 때는 이 목록을 계속 활용할 수 있습니다.)
DUPLICATE_META_SLUGS = [
    "노원구-공릉동-빌라-누전차단기가-반복해서-떨어지",
    "강동구-천호동-아파트-분전반-내부에서-탄-냄새가-나",
    "강서구-방화동-아파트-두꺼비집-교체가-필요한-경우",
    "성동구-성수동-주택-콘센트에서-타는-냄새와-열이-느",
    "수원시-권선구-곡선동-상가-콘센트-사용-중-전기가-끊",
    "노원구-중계동-빌라-집-일부-콘센트가-동시에-안-되는",
    "송파구-문정동-빌라-콘센트-합선이-의심되는-경우-원",
    "고양시-주교동-아파트-욕실-콘센트-누전이-의심되는",
    "강동구-성내동-주택-전선-접속부-탄화가-의심되는-경",
    "서대문구-연희동-주택-누전검사로-문제-회로를-확인",
    "구로구-오류동-주택-노후-두꺼비집-교체를-검토하는",
    "강서구-등촌동-아파트-노후-전기선-상태를-점검하는",
    "관악구-신림동-주택-에어컨-전용-차단기가-안-올라가",
    "강동구-천호동-아파트-세탁기-사용-중-차단기가-내려",
    "성동구-금호동-주택-메인차단기가-반복해서-내려가",
    "중랑구-묵동-분전반-내부-그을림-문제-관련-현장-점검",
    "마포구-성산동-전기가-갑자기-끊기는-증상-점검-및-수",
    "성북구-안암동-주택-누전검사로-문제-회로를-확인하",
    "마포구-서교동-주택-메인차단기가-반복해서-내려가",
    "용산구-후암동-빌라-주방-콘센트에서-이상-냄새가-나",
    "광진구-광장동-빌라-두꺼비집-교체를-검토하는-경우",
    "용산구-청파동-아파트-메인차단기가-반복해서-내려",
    "테스트-경기도",
    "강남구-압구정동-주택-전선-피복이-오래된-경우-원인",
]


def run_fix_duplicate_meta_descriptions():
    """
    DUPLICATE_META_SLUGS에 있는 24개 글을 순서대로 고칩니다.
    실행 전 WPCode에 excerpt/메타필드 REST 등록 스니펫을 먼저
    적용해두어야 실제로 저장이 됩니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    success = 0
    for slug in DUPLICATE_META_SLUGS:
        if fix_meta_description_by_slug(slug, auth):
            success += 1
        time.sleep(1)

    print(f"\n완료: {success}/{len(DUPLICATE_META_SLUGS)}개 수정")


# =========================================================
# 손으로 직접 쓴 글 등록 (텍스트 조합 생성이 아니라, 미리
# 써둔 기사를 그대로 읽어서 올리는 모드)
# ---------------------------------------------------------
# manual_articles_selected.txt 안에 [001]~[NNN] 형식으로 저장된
# "구/동/제목/본문"을 그대로 읽어서, 기존 배너·태그·SEO 처리
# 파이프라인에 실어 워드프레스에 등록합니다. 무작위 조합으로
# 새 문장을 만들어내는 게 아니라 사람이 직접 쓴 완성된 글을
# 그대로 사용한다는 점만 build_txt_post와 다릅니다.
# =========================================================

MANUAL_ARTICLES_FILE = Path(__file__).with_name(
    "manual_articles_selected.txt"
)

MANUAL_PROGRESS_FILE = Path(__file__).with_name(
    "manual_progress.json"
)


def load_manual_articles(path=None):
    """
    manual_articles_selected.txt를 읽어서
    [{"gu":..., "dong":..., "title":..., "body":...}, ...] 리스트로 반환합니다.
    각 항목은 파일 안의 "[001]" ~ "[300]" 블록 하나에 대응합니다.
    """
    path = path or MANUAL_ARTICLES_FILE
    if not path.exists():
        print(f"❌ {path.name} 파일을 찾을 수 없습니다.")
        return []

    text = path.read_text(encoding="utf-8")
    # "[001]" ~ "[300]" 같은 번호 표시를 기준으로 나눕니다. 배치 파일을
    # 이어 붙이는 과정에서 "---" 구분선이 몇몇 경계에 빠져 있어도
    # (예: 020번↔021번 사이) 이 방식은 영향을 받지 않습니다.
    blocks = re.split(r"\n(?=\[\d{3}\])", text)

    articles = []
    for block in blocks:
        block = block.strip()
        if not block:
            continue

        gu_m = re.search(r"^구:\s*(.+)$", block, re.M)
        dong_m = re.search(r"^동:\s*(.+)$", block, re.M)
        title_m = re.search(r"^제목:\s*(.+)$", block, re.M)
        body_m = re.search(r"^본문:\s*\n(.*)$", block, re.M | re.S)

        if not (gu_m and dong_m and title_m and body_m):
            continue

        body_text = body_m.group(1).strip()
        # 블록 끝에 다음 글과의 구분선("---")이 그대로 붙어 나오는
        # 경우가 있어(특히 배치 파일 경계), 있다면 잘라냅니다.
        body_text = re.sub(r"\n-{3,}\s*$", "", body_text).strip()

        articles.append({
            "gu": gu_m.group(1).strip(),
            "dong": dong_m.group(1).strip(),
            "title": title_m.group(1).strip(),
            "body": body_text,
        })

    return articles


def load_manual_progress_index():
    if not MANUAL_PROGRESS_FILE.exists():
        return 0
    try:
        with open(MANUAL_PROGRESS_FILE, "r", encoding="utf-8") as f:
            return int(json.load(f).get("next_index", 0))
    except (json.JSONDecodeError, OSError, ValueError):
        print("⚠️ manual_progress.json을 읽지 못해 처음부터 시작합니다.")
        return 0


def save_manual_progress_index(next_index):
    with open(MANUAL_PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump({"next_index": int(next_index)}, f, ensure_ascii=False, indent=2)


def _extract_symptom_from_manual_title(gu, dong, title):
    """
    손글 제목 "{구} {동} {증상 키워드}, {나머지}"에서 증상 키워드
    부분만 뽑아냅니다. 못 찾으면 무난한 기본 문구를 씁니다.
    """
    prefix = f"{gu} {dong} "
    rest = title[len(prefix):] if title.startswith(prefix) else title
    symptom = rest.split(",")[0].strip()
    return symptom or "차단기가 내려가는 증상"


def _extract_housing_from_manual_body(raw_body):
    """본문 안에 이미 언급된 주거형태가 있으면 그걸 그대로 씁니다."""
    for housing in GEN_HOUSING_TYPES:
        if housing in raw_body:
            return housing
    return random.choice(GEN_HOUSING_TYPES)


def build_manual_extra_sections(gu, dong, raw_title, raw_body):
    """
    손글 이야기 뒤에 덧붙일 "체크리스트 / 원인 / 점검순서 / 교체시점 /
    점검후확인 / 주의사항 / 예방습관 / FAQ / 전화안내" 섹션들을,
    이미 만들어둔 조합형 생성기(WORK_TYPES[0]용 재료 풀)에서
    매번 다르게 뽑아 만듭니다. 문구 자체는 기존 손글과 겹치지
    않고 매번 랜덤으로 조합되기 때문에, 같은 문단이 여러 글에
    그대로 반복되는 일이 없습니다.
    """
    work_type = WORK_TYPES[0]
    symptom = _extract_symptom_from_manual_title(gu, dong, raw_title)
    housing = _extract_housing_from_manual_body(raw_body)
    fmt = dict(gu=gu, dong=dong, housing=housing, symptom=symptom)

    checklist_pool = GEN_SYMPTOM_CHECKLIST[work_type]
    checklist_items = random.sample(checklist_pool, k=min(5, len(checklist_pool)))

    cause_pool = GEN_CAUSE_SECTIONS[work_type]
    cause_sections = random.sample(cause_pool, k=min(3, len(cause_pool)))

    process_step1 = random.choice(GEN_PROCESS_STEP1_VARIANTS).format(**fmt)
    process_step2 = random.choice(GEN_PROCESS_STEP2_VARIANTS).format(**fmt)
    process_step3 = random.choice(GEN_DIAGNOSIS_VARIANTS[work_type])

    main_cause_title = cause_sections[0][0]
    replace_intro = random.choice(GEN_REPLACE_INTRO_VARIANTS).format(cause_title=main_cause_title)
    replace_action = random.choice(GEN_PROCESS_VARIANTS[work_type])
    replace_caution = random.choice(GEN_REPLACE_CAUTION_VARIANTS)

    post_check = random.choice(GEN_POST_CHECK_VARIANTS)
    caution = random.choice(GEN_CAUTION_VARIANTS)

    prevention_pool = GEN_PREVENTION_TIPS[work_type]
    prevention_items = random.sample(prevention_pool, k=min(4, len(prevention_pool)))

    faq_items = random.sample(GEN_FAQ_POOL, k=3)

    checklist_md = "\n".join(f"- {item}" for item in checklist_items)
    cause_md = "\n\n".join(
        f"### {i}. {c_title}\n\n{c_desc}"
        for i, (c_title, c_desc) in enumerate(cause_sections, start=1)
    )
    prevention_md = "\n".join(f"- {item}" for item in prevention_items)
    faq_md = "\n\n".join(f"### Q. {q}\n\n{a}" for q, a in faq_items)
    cta_closing = random.choice(GEN_CTA_CLOSING_VARIANTS).format(**fmt)

    h_checklist = _pick_heading("checklist")
    h_cause = _pick_heading("cause", fmt)
    h_process = _pick_heading("process")
    h_replace = _pick_heading("replace")
    h_postcheck = _pick_heading("postcheck")
    h_caution = _pick_heading("caution")
    h_prevention = _pick_heading("prevention")
    h_faq = _pick_heading("faq")
    h_cta = _pick_heading("cta")

    # 순서를 바꿔도 자연스러운 5개 섹션은 매번 랜덤하게 섞습니다.
    middle_sections = [
        (h_process, f"{process_step1}\n\n{process_step2}\n\n{process_step3}"),
        (h_replace, f"{replace_intro} {replace_action}\n\n{replace_caution}"),
        (h_postcheck, post_check),
        (h_caution, caution),
        (h_prevention, prevention_md),
    ]
    random.shuffle(middle_sections)
    middle_md = "\n\n".join(f"## {h}\n\n{c}" for h, c in middle_sections)

    extra = (
        f"## {h_checklist}\n\n{checklist_md}\n\n"
        f"## {h_cause}\n\n{cause_md}\n\n"
        f"{middle_md}\n\n"
        f"## {h_faq}\n\n{faq_md}\n\n"
        f"## {h_cta}\n\n{cta_closing}"
    )

    return extra


def build_manual_post(gu, dong, raw_title, raw_body):
    """
    손으로 쓴 제목/본문(줄글 텍스트)을 build_txt_post와 동일한 방식으로
    HTML로 변환하고, 배너·관련태그를 붙여 워드프레스에 올릴 데이터를
    완성합니다. 손글 이야기 자체는 그대로 쓰되(문장 생성 없음), 그
    뒤에 체크리스트·원인·FAQ 등 조합형 섹션을 추가로 붙여서 본문을
    더 충실하게 만듭니다(경쟁사처럼 똑같은 문단이 반복되지 않도록,
    이 추가 섹션은 매번 다른 조합으로 새로 뽑습니다).
    """
    title = strip_gyeongu(clean_tuple_artifacts(raw_title.strip()))

    extra_sections_text = build_manual_extra_sections(gu, dong, raw_title, raw_body)
    full_raw_body = raw_body.strip() + "\n\n" + extra_sections_text

    html_parts = []
    for paragraph in re.split(r"\n\s*\n", full_raw_body):
        paragraph = paragraph.strip()
        if not paragraph:
            continue

        if paragraph.startswith("## "):
            heading = html.escape(paragraph[3:].strip())
            html_parts.append(f"<h2>{heading}</h2>")
        elif paragraph.startswith("### "):
            heading = html.escape(paragraph[4:].strip())
            html_parts.append(f"<h3>{heading}</h3>")
        elif paragraph.startswith("- "):
            items = [
                html.escape(x[2:].strip())
                for x in paragraph.splitlines()
                if x.strip().startswith("- ")
            ]
            if items:
                html_parts.append(
                    "<ul>" + "".join(f"<li>{item}</li>" for item in items) + "</ul>"
                )
        else:
            # (기존에는 손글 문단을 통째로 <p> 하나에 넣어서, 문단이
            # 길면 화면에서 "글자 벽"처럼 보여 가독성이 떨어졌습니다.
            # 랜덤조합 생성 쪽과 동일하게 문장 2개 단위로 끊어
            # 여러 개의 짧은 <p>로 나눕니다.)
            normalized = re.sub(r"\s+", " ", paragraph).strip()

            sentences = re.split(r"(?<=[.!?。！？])\s+", normalized)
            if len(sentences) == 1:
                sentences = re.split(r"(?<=다\.)\s+", normalized)
            sentences = [s.strip() for s in sentences if s.strip()]

            groups = []
            current_group = []
            for sentence in sentences:
                current_group.append(sentence)
                if len(current_group) >= 2 or len(" ".join(current_group)) >= 420:
                    groups.append(" ".join(current_group))
                    current_group = []
            if current_group:
                groups.append(" ".join(current_group))
            if not groups:
                groups = [normalized]

            for group in groups:
                escaped = html.escape(group)
                html_parts.append(
                    f'<p style="{BODY_PARAGRAPH_STYLE}">'
                    f"{escaped}</p>"
                )

    body = "".join(html_parts)

    excerpt = re.sub(r"<[^>]+>", " ", body)
    for _ in range(3):
        unescaped_once = html.unescape(excerpt)
        if unescaped_once == excerpt:
            break
        excerpt = unescaped_once
    excerpt = re.sub(r"\s+", " ", excerpt).strip()
    excerpt = pick_excerpt_skip_intro(excerpt)

    seo_title = title[:70]
    image_url = random.choice(BANNER_IMAGE_URLS)

    body_with_banners = insert_mid_banners(body, BANNER_IMAGE_URLS)

    full_content = (
        get_top_banner(gu, dong, image_url)
        + body_with_banners
        + build_related_tags_html(gu, dong)
        + get_bottom_banner(image_url)
    )

    slug = make_slug_from_title(title)

    return {
        "title": title,
        "slug": slug,
        "content": full_content,
        "excerpt": excerpt,
        "seo_title": seo_title,
        "meta_description": build_meta_description_from_title(title),
        "focus_keyword": f"{gu} {dong} 전기수리"[:80],
    }


def create_or_update_manual_case(gu, dong, title, body_text, auth, publish_dt=None, force_status=None):
    """
    손으로 쓴 글 하나를 워드프레스에 등록/업데이트합니다.
    create_or_update_electric_case와 흐름은 같지만, 본문을
    build_manual_post로 만든다는 점과 작업유형을 항상 "차단기
    내려감"(WORK_TYPES[0]) 계열로 고정한다는 점만 다릅니다.
    """
    print(f"\n[작업 중 - 손글 등록] {gu} {dong} - {title}")

    work_type = WORK_TYPES[0]

    data = build_manual_post(gu, dong, title, body_text)

    acf_fields = make_case_fields(gu, dong, work_type)
    slug = data["slug"]

    case_type_slug = CASE_TYPE_MAP.get(work_type)
    if not case_type_slug:
        print(f"❌ case_type 매핑이 없습니다: {work_type}")
        return False, None

    case_type_id = get_or_create_case_type(case_type_slug, auth)
    if not case_type_id:
        print(f"❌ case_type ID를 가져오지 못했습니다: {case_type_slug}")
        return False, None

    if force_status:
        status = force_status
    elif publish_dt is not None:
        status = "future" if publish_dt > datetime.now() else "publish"
    else:
        status = POST_STATUS

    payload = build_wp_payload(
        title=data["title"],
        content=data["content"],
        excerpt=data["excerpt"],
        acf_fields=acf_fields,
        seo=data,
        case_type_id=case_type_id,
        slug=slug,
        status=status,
        publish_dt=publish_dt,
        featured_media=resolve_media_id_by_url(TARGET_LOGO_URL, auth),
    )

    try:
        existing = find_existing_case(slug, auth)

        if existing:
            post_id = existing.get("id")
            response = requests.post(
                f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
                json=payload,
                auth=auth,
                timeout=45,
            )
        else:
            response = requests.post(
                ELECTRIC_CASE_ENDPOINT,
                json=payload,
                auth=auth,
                timeout=45,
            )

        if response.status_code in (200, 201):
            result = response.json()
            post_id = result.get("id")
            post_link = result.get("link")

            if post_id and post_link:
                requests.post(
                    f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
                    json={"meta": {"_yoast_wpseo_canonical": post_link}},
                    auth=auth,
                    timeout=30,
                )

            print("==============================================")
            print("✅ 손글 등록/업데이트 성공")
            print(f"제목: {data['title']}")
            print(f"URL: {result.get('link')}")
            if publish_dt is not None:
                print(f"예약 발행 시각: {publish_dt.strftime('%Y-%m-%d %H:%M')} ({status})")
            print("==============================================")

            return True, data["title"]

        print(f"❌ 손글 등록 실패 ({response.status_code})")
        print(response.text[:1500])
        return False, None

    except requests.RequestException as e:
        print(f"❌ 워드프레스 연결 오류: {e}")
        return False, None


def run_manual_articles_poster(count=POSTS_PER_DAY):
    """
    manual_articles_selected.txt에 있는 손글 중, 저장된 진행
    위치부터 이어서 하루 count개씩(기본 30개) 등록합니다.
    - 발행 시각은 오늘 하루 안에서 무작위로 뽑아 오름차순 배정합니다.
    - 전체를 모두 등록하면 자동으로 멈춥니다(별도 조치 불필요).
    - 진행 위치는 manual_progress.json에 저장되어 다음 실행 때
      자동으로 이어집니다.
    - 이미 같은 동(洞)에 한 번 썼던 제목은 다시 쓰지 않습니다
      (used_titles_by_dong.json, DAILY 모드와 같은 이력 파일을
      공유해서 확인합니다). 겹치는 글은 건너뛰고 다음 글로
      넘어갑니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    articles = load_manual_articles()
    if not articles:
        print("❌ 등록할 손글이 없습니다. manual_articles_selected.txt를 확인하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)
    start_index = load_manual_progress_index()

    if start_index >= len(articles):
        print(f"🎉 손글 {len(articles)}개 전체 등록이 이미 완료되었습니다.")
        return

    title_history = load_title_history()

    # 이번 배치에서 실제로 발행할(중복 제목이 아닌) 글만 먼저 골라내고,
    # 발행 시각은 그 개수만큼만 만듭니다.
    candidates = articles[start_index:start_index + count]
    to_publish = []
    skipped = []

    for article in candidates:
        location_key = f"{article['gu']} {article['dong']}"
        if article["title"] in title_history.get(location_key, set()):
            skipped.append(article)
        else:
            to_publish.append(article)

    publish_times = generate_random_publish_times(len(to_publish))

    success = 0
    processed = 0  # 성공+중복스킵 합계 (진행 인덱스를 이만큼 전진시킴)

    print("==============================================")
    print(f"오늘 목표: {len(candidates)}개 확인 (이 중 중복 제목 {len(skipped)}개는 건너뜀)")
    print(f"발행 시각대: {DAILY_PUBLISH_WINDOW_START_HOUR}시~{DAILY_PUBLISH_WINDOW_END_HOUR}시 사이 무작위")
    print("==============================================")

    for article in skipped:
        print(f"⏭️ 건너뜀 (같은 동에서 이미 쓴 제목): {article['gu']} {article['dong']} - {article['title']}")
        processed += 1
        save_manual_progress_index(start_index + processed)

    for article, publish_dt in zip(to_publish, publish_times):
        ok, title = create_or_update_manual_case(
            article["gu"],
            article["dong"],
            article["title"],
            article["body"],
            auth,
            publish_dt=publish_dt,
        )

        processed += 1

        if ok:
            success += 1
            location_key = f"{article['gu']} {article['dong']}"
            title_history.setdefault(location_key, set()).add(title)
            save_title_history(title_history)
            save_manual_progress_index(start_index + processed)

        time.sleep(1.5)

    print(f"\n🎉 오늘 등록 완료: {success}개 발행 / {len(skipped)}개 중복 스킵")
    if success:
        print(f"   발행 예정 시각: {publish_times[0].strftime('%H:%M')} ~ {publish_times[success-1].strftime('%H:%M')}")
    print(f"   다음 실행 시작 위치: {start_index + processed}번째 글부터 (전체 {len(articles)}개 중)")
    if start_index + processed >= len(articles):
        print(f"   🎉 손글 {len(articles)}개 전체 등록이 완료되었습니다!")


def build_wp_payload(title, content, excerpt, acf_fields, seo, case_type_id, slug, status=None, publish_dt=None, featured_media=None):
    """
    전기수리 사례 + case_type + ACF + Yoast SEO meta를 한 번에 보냅니다.
    publish_dt가 주어지면 그 시각에 예약 발행(future)되도록 date를 함께 보냅니다.
    featured_media가 주어지면 그 미디어 ID를 대표이미지로 지정합니다
    (네이버/구글 검색결과 썸네일(og:image)에 쓰입니다).
    """
    payload = {
        "title": title,
        "slug": slug,
        "content": content,
        "excerpt": excerpt,
        "status": status or POST_STATUS,

        # 작업유형 taxonomy
        "case_type": [int(case_type_id)],

        # ACF
        "acf": acf_fields,

        # Yoast SEO
        "meta": {
            "_yoast_wpseo_title": seo["seo_title"],
            "_yoast_wpseo_metadesc": seo["meta_description"],
            "_yoast_wpseo_focuskw": seo["focus_keyword"],
            "_yoast_wpseo_canonical": "",
        },
    }

    if featured_media:
        payload["featured_media"] = int(featured_media)

    if publish_dt is not None:
        # 워드프레스 REST API는 사이트 로컬시간 기준 "YYYY-MM-DDTHH:MM:SS" 포맷을 씁니다.
        payload["date"] = publish_dt.strftime("%Y-%m-%dT%H:%M:%S")

    return payload


def create_or_update_electric_case(gu, dong, work_type, auth, used_titles=None, publish_dt=None, force_status=None):
    print(f"\n[작업 중] {gu} {dong} - {work_type}")

    data = build_txt_post(gu, dong, work_type, used_titles=used_titles)
    if not data:
        return False, None

    title = data["title"]
    content = data["content"]
    excerpt = data["excerpt"]

    acf_fields = make_case_fields(gu, dong, work_type)
    slug = make_slug_from_title(title)

    # 작업유형에 맞는 case_type slug와 term ID 확보
    case_type_slug = CASE_TYPE_MAP.get(work_type)

    if not case_type_slug:
        print(f"❌ case_type 매핑이 없습니다: {work_type}")
        return False, None

    case_type_id = get_or_create_case_type(case_type_slug, auth)

    if not case_type_id:
        print(f"❌ case_type ID를 가져오지 못했습니다: {case_type_slug}")
        return False, None

    # force_status가 지정되면 그걸 그대로 사용 (예: 즉시 공개용 "publish")
    if force_status:
        status = force_status
    elif publish_dt is not None:
        status = "future" if publish_dt > datetime.now() else "publish"
    else:
        status = POST_STATUS

    payload = build_wp_payload(
        title=title,
        content=content,
        excerpt=excerpt,
        acf_fields=acf_fields,
        seo=data,
        case_type_id=case_type_id,
        slug=slug,
        status=status,
        publish_dt=publish_dt,
        featured_media=resolve_media_id_by_url(TARGET_LOGO_URL, auth),
    )

    try:
        # 같은 slug가 이미 있으면 새 글을 계속 만들지 않고 업데이트
        existing = find_existing_case(slug, auth)

        if existing:
            post_id = existing.get("id")
            update_endpoint = f"{ELECTRIC_CASE_ENDPOINT}/{post_id}"

            print(f"ℹ️ 같은 slug 발견 → 기존 글 업데이트 (ID: {post_id})")

            response = requests.post(
                update_endpoint,
                json=payload,
                auth=auth,
                timeout=45,
            )
        else:
            response = requests.post(
                ELECTRIC_CASE_ENDPOINT,
                json=payload,
                auth=auth,
                timeout=45,
            )

        if response.status_code in (200, 201):
            result = response.json()

            # 글이 생성된 뒤 실제 URL을 받아 canonical을 정확하게 저장
            post_id = result.get("id")
            post_link = result.get("link")

            if post_id and post_link:
                canonical_payload = {
                    "meta": {
                        "_yoast_wpseo_canonical": post_link
                    }
                }

                requests.post(
                    f"{ELECTRIC_CASE_ENDPOINT}/{post_id}",
                    json=canonical_payload,
                    auth=auth,
                    timeout=30,
                )

            print("==============================================")
            print("✅ 전기수리 사례 등록/업데이트 성공")
            print(f"제목: {title}")
            print(f"ID: {result.get('id')}")
            print(f"URL: {result.get('link')}")
            print(f"지정 slug: {data.get('slug', '')}")
            print(f"작업유형: {case_type_slug} (ID: {case_type_id})")
            print(f"Yoast 제목: {data['seo_title']}")
            print(f"Yoast 설명: {data['meta_description']}")
            print(f"핵심 키워드: {data['focus_keyword']}")
            if publish_dt is not None:
                print(f"예약 발행 시각: {publish_dt.strftime('%Y-%m-%d %H:%M')} ({status})")
            print("==============================================")

            return True, title

        if response.status_code == 404:
            print("❌ electric_case REST API 주소가 없습니다.")
            print("WPCode에서 CPT의 REST API 표시(show_in_rest)를 확인하세요.")
            print(f"요청 주소: {ELECTRIC_CASE_ENDPOINT}")
            print(f"응답: {response.text[:700]}")
            return False, None

        print(f"❌ 전기수리 사례 등록 실패 ({response.status_code})")
        print(response.text[:1500])
        return False, None

    except requests.RequestException as e:
        print(f"❌ 워드프레스 연결 오류: {e}")
        return False, None


# =========================================================
# 8. 실행
# =========================================================

LOCATION_ORDER_FILE = Path(__file__).with_name(
    "location_order.json"
)


def build_seoul_then_gyeonggi_locations():
    """
    서울 지역을 랜덤 순서로 전부 나열한 뒤, 그 뒤에 경기 지역을
    또 다른 랜덤 순서로 이어 붙입니다(ㄱㄴㄷ 순서 아님). 서울을
    전부 채우기 전에는 경기로 넘어가지 않습니다.

    한 번 정해진 랜덤 순서는 location_order.json에 저장해두고,
    다음 실행부터는 그 저장된 순서를 그대로 다시 씁니다. 실행할
    때마다 순서가 바뀌면 location_progress.json에 저장해둔
    "몇 번째까지 등록했는지" 인덱스가 엉뚱한 지역을 가리키게
    되므로, 순서 자체는 최초 1회만 랜덤으로 정하고 계속 고정해서
    씁니다.
    """
    if LOCATION_ORDER_FILE.exists():
        try:
            with open(LOCATION_ORDER_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return [tuple(pair) for pair in data]
        except (json.JSONDecodeError, OSError, ValueError, TypeError):
            print("⚠️ 저장된 지역 순서 파일을 읽지 못해 새로 랜덤 순서를 만듭니다.")

    seoul_locations = [
        (gu, dong)
        for gu, dongs in SEOUL_DATA.items()
        for dong in dongs
    ]
    gyeonggi_locations = [
        (gu, dong)
        for gu, dongs in GYEONGGI_DATA.items()
        for dong in dongs
    ]

    random.shuffle(seoul_locations)
    random.shuffle(gyeonggi_locations)

    locations = seoul_locations + gyeonggi_locations

    with open(LOCATION_ORDER_FILE, "w", encoding="utf-8") as f:
        json.dump(locations, f, ensure_ascii=False, indent=2)

    return locations


def generate_random_publish_times(count, start_hour=DAILY_PUBLISH_WINDOW_START_HOUR,
                                   end_hour=DAILY_PUBLISH_WINDOW_END_HOUR):
    """
    항상 "지금 이 순간보다 미래"인 무작위 시각만 count개 뽑아
    오름차순으로 정렬해 반환합니다.

    - 지금이 오늘 발행 시간대(start_hour~end_hour) 이전이면:
      오늘 시간대 전체에서 뽑습니다.
    - 지금이 오늘 발행 시간대 안이면:
      지금(+5분 여유)부터 오늘 시간대 끝까지에서 뽑습니다.
    - 지금이 오늘 발행 시간대를 이미 지났으면:
      내일 같은 시간대에서 뽑습니다.

    이렇게 하면 뽑힌 시각이 절대 "이미 지난 시각"이 되지 않아서,
    워드프레스에 항상 정상적으로 "예약(future)" 상태로 등록됩니다.
    (예약 대신 임시저장으로 뒤바뀌는 문제 방지)
    """
    now = datetime.now()
    today_start = now.replace(hour=start_hour, minute=0, second=0, microsecond=0)
    today_end = now.replace(hour=end_hour, minute=59, second=59, microsecond=0)

    if now < today_start:
        window_start, window_end = today_start, today_end
    elif now <= today_end:
        window_start = now + timedelta(minutes=5)
        window_end = today_end
        if window_start >= window_end:
            tomorrow = now.date() + timedelta(days=1)
            window_start = datetime.combine(tomorrow, datetime.min.time()).replace(hour=start_hour)
            window_end = datetime.combine(tomorrow, datetime.min.time()).replace(hour=end_hour, minute=59, second=59)
    else:
        tomorrow = now.date() + timedelta(days=1)
        window_start = datetime.combine(tomorrow, datetime.min.time()).replace(hour=start_hour)
        window_end = datetime.combine(tomorrow, datetime.min.time()).replace(hour=end_hour, minute=59, second=59)

    span_seconds = max(int((window_end - window_start).total_seconds()), 1)

    times = [
        window_start + timedelta(seconds=random.randint(0, span_seconds))
        for _ in range(count)
    ]
    times.sort()
    return times


def run_daily_scheduled_poster_v2(count=POSTS_PER_DAY):
    """
    서울 → 경기 순서로 이어서 하루 count개씩 등록합니다.
    - 이미 등록된 동은 건너뛰고, 저장된 진행 인덱스부터 이어서 진행합니다.
    - 서울 지역을 전부 채우기 전에는 경기로 넘어가지 않습니다.
    - 발행 시각은 오늘 하루(DAILY_PUBLISH_WINDOW_START_HOUR~END_HOUR)
      안에서 무작위로 뽑아 오름차순으로 배정합니다(고정 간격 아님).
    - 실행 후 진행 인덱스를 저장해서, 다음 날 실행할 때 그다음
      동부터 자동으로 이어집니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    can_run, remaining_limit = check_post_limit_before_run()
    if not can_run:
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    locations = build_seoul_then_gyeonggi_locations()
    start_index = load_location_progress_index()

    if start_index >= len(locations):
        print("🎉 서울+경기 전 지역 등록이 이미 완료되었습니다.")
        print("   더 등록하려면 location_progress.json을 삭제하거나 인덱스를 조정하세요.")
        return

    # 하루 목표(count)와, 300개 누적 상한 중 남은 개수 중 더 작은 쪽만큼만 등록합니다.
    count = min(count, remaining_limit)

    selected = locations[start_index:start_index + count]
    publish_times = generate_random_publish_times(len(selected))

    title_history = load_title_history()
    used_titles = set()
    success = 0

    print("==============================================")
    print(f"오늘 목표: {len(selected)}개 (전체 {len(locations)}개 중 {start_index + 1}번째부터)")
    print(f"발행 시각대: {DAILY_PUBLISH_WINDOW_START_HOUR}시~{DAILY_PUBLISH_WINDOW_END_HOUR}시 사이 무작위")
    print("==============================================")

    for (gu, dong), publish_dt in zip(selected, publish_times):
        work_type = pick_weighted_work_type()
        location_key = f"{gu} {dong}"

        combined_used = used_titles | title_history.get(location_key, set())

        ok, title = create_or_update_electric_case(
            gu,
            dong,
            work_type,
            auth,
            used_titles=combined_used,
            publish_dt=publish_dt,
        )

        if ok:
            success += 1
            used_titles.add(title)
            title_history.setdefault(location_key, set()).add(title)
            save_title_history(title_history)
            # 하나 성공할 때마다 진행 인덱스를 갱신 저장해서,
            # 중간에 스크립트가 멈춰도 이미 등록한 동을 다시 반복하지 않습니다.
            save_location_progress_index(start_index + success)

        time.sleep(1.5)

    print(f"\n🎉 오늘 등록 완료: {success}/{len(selected)}개")
    if success:
        print(f"   발행 예정 시각: {publish_times[0].strftime('%H:%M')} ~ {publish_times[success-1].strftime('%H:%M')}")
    print(f"   다음 실행 시작 위치: {start_index + success}번째 지역부터 (전체 {len(locations)}개 중)")

    record_posts_made(success)
    updated_state = load_post_limit_state()
    total_so_far = updated_state.get("total_posted", 0)
    print(f"   누적 등록: {total_so_far}/{TOTAL_POST_LIMIT}개")
    if total_so_far >= TOTAL_POST_LIMIT:
        print(f"   ⚠️ 다음 실행부터는 {CASES_FILE.name}을 새로 만들기 전까지 등록이 막힙니다.")


def build_interleaved_locations():
    """
    서울/경기 지역 리스트를 각각 섞은 뒤 번갈아(서울 1 - 경기 1 - 서울 1 - ...)
    배치합니다. 그냥 합쳐서 섞으면 지역 수가 훨씬 많은 서울이 하루 목록을
    거의 다 차지할 수 있어서, 서울/경기가 골고루 한 번씩 나오도록 합니다.
    """
    seoul_locations = [
        (gu, dong)
        for gu, dongs in SEOUL_DATA.items()
        for dong in dongs
    ]
    gyeonggi_locations = [
        (gu, dong)
        for gu, dongs in GYEONGGI_DATA.items()
        for dong in dongs
    ]

    random.shuffle(seoul_locations)
    random.shuffle(gyeonggi_locations)

    interleaved = []
    max_len = max(len(seoul_locations), len(gyeonggi_locations))

    for i in range(max_len):
        if i < len(seoul_locations):
            interleaved.append(seoul_locations[i])
        if i < len(gyeonggi_locations):
            interleaved.append(gyeonggi_locations[i])

    return interleaved


def run_auto_poster(max_posts=1):
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    locations = build_interleaved_locations()

    title_history = load_title_history()
    success = 0
    used_titles = set()

    for gu, dong in locations:
        work_type = pick_weighted_work_type()
        location_key = f"{gu} {dong}"

        # 이번 실행에서 이미 쓴 제목 + 이 동에서 과거에 쓴 제목을 모두 피해서 선택
        combined_used = used_titles | title_history.get(location_key, set())

        ok, title = create_or_update_electric_case(
            gu,
            dong,
            work_type,
            auth,
            used_titles=combined_used,
        )

        if ok:
            success += 1
            used_titles.add(title)
            title_history.setdefault(location_key, set()).add(title)
            save_title_history(title_history)

        if success >= max_posts:
            break

        time.sleep(2)

    print(f"\n🎉 완료: 전기수리 사례 {success}개 등록/업데이트 (제목 {len(used_titles)}개 사용)")


# =========================================================
# 9. 시작
# =========================================================
#
# 실행 모드는 아래 RUN_MODE 값 하나로 정합니다. 원하는 모드만
# 문자열로 바꿔서 실행하면 됩니다.
#
#   "TEST_ONE"  → 딱 1개만 즉시 "공개(publish)"로 테스트 등록하고 끝냅니다.
#                 (지역/작업유형은 랜덤으로 골라서 씁니다)
#                 결과를 바로 사이트에서 눈으로 확인하고 싶을 때 씁니다.
#
#   "DAILY"     → 하루 POSTS_PER_DAY(기본 30)개를, 서울→경기 순서로
#                 이어서, 무작위 발행 시각(DAILY_PUBLISH_WINDOW_*)으로
#                 예약 발행(future) 등록하고 종료합니다.
#                 서울 전 지역을 다 채우기 전에는 경기로 넘어가지
#                 않으며, 진행 위치는 location_progress.json에 저장돼
#                 다음 실행 때 자동으로 이어집니다. (실제 운영용)
#
#   "DRAFT_N"   → MAX_POSTS_PER_RUN개를 간격 없이 임시저장(draft)으로
#                 등록합니다. (예전 방식)
#
#   "MANUAL_300" → manual_articles_selected.txt에 있는(현재 서울+고양시+김포시,
#                 랜덤 순서로 저장됨), 사람이 직접 쓴 글을 저장된 진행 위치부터 하루
#                 POSTS_PER_DAY(기본 30)개씩 등록합니다. 무작위 조합
#                 생성이 아니라 파일에 있는 글을 그대로 씁니다.
#                 발행 시각은 DAILY 모드와 동일하게 하루 안에서
#                 무작위로 뽑아 예약 발행합니다. 전체를 다 등록하면
#                 자동으로 멈춥니다.
#
#   "FIX_READABILITY_ALL" → 이미 등록된 electric_case 글 전체를 훑으며
#                 본문 <p> 문단 스타일을 BODY_PARAGRAPH_STYLE로
#                 통일합니다(줄간격/글자크기/여백 개선). 이미 최신
#                 스타일인 글은 건드리지 않고 건너뜁니다.
#
#   "FIX_MID_BANNER_ALL" → 이미 등록된 electric_case 글 전체를 훑으며
#                 본문 중간 전화연결 배너(data-electric-mid-banner)의
#                 문구/스타일을 지금의 get_mid_banner() 하나로
#                 통일합니다. 예전 문구("혼자 판단하기 어렵다면...")로
#                 만들어진 글과 글자가 박스 밖으로 삐져나오던 문제를
#                 한 번에 고칩니다. 배경 이미지는 그대로 유지됩니다.
#
#   "FIX_ACF_FIELDS_ALL" → ACF to REST API 플러그인 설치 전에 만들어져
#                 구/동(district/dong) ACF 필드가 비어있는 글들에,
#                 제목("{구} {동} ...")에서 뽑아낸 값을 채워 넣습니다.
#                 이미 채워진 글은 건드리지 않습니다.
#
#   "FIX_TITLE_TUPLE_ALL" → 제목에 "('구', '동') ..."처럼 파이썬
#                 튜플 문자열이 그대로 남아있는 글들의 제목을
#                 "구 동 ..." 형태로 정리합니다. 곧은따옴표/둥근
#                 따옴표 둘 다 인식합니다.
# =========================================================

RUN_MODE = "MANUAL_300"

# RUN_MODE = "DRAFT_N" 일 때 등록할 개수
MAX_POSTS_PER_RUN = 1


def run_single_test_post():
    """
    테스트용: 서울/경기 전체 지역 중 하나를 랜덤으로 골라
    딱 1개만 "임시저장(draft)"으로 등록합니다.
    - 동별 제목 이력(used_titles_by_dong.json)도 그대로 반영되므로,
      이미 그 동에서 쓴 제목은 이번 테스트에서도 다시 안 나옵니다.
    - 실제 운영(DAILY 모드)에 영향을 주지 않는 순수 테스트 실행입니다.
    - 임시저장 상태라 사이트에는 공개되지 않고, 워드프레스 관리자
      화면(전기수리 사례 → 임시글)에서만 확인할 수 있습니다.
    """
    if not WP_APP_PASSWORD or WP_APP_PASSWORD.startswith("여기에_"):
        print("❌ 코드 상단 WP_APP_PASSWORD에 워드프레스 앱 비밀번호를 입력하세요.")
        return

    auth = (WP_USER, WP_APP_PASSWORD)

    locations = build_interleaved_locations()
    gu, dong = random.choice(locations)
    work_type = pick_weighted_work_type()

    title_history = load_title_history()
    location_key = f"{gu} {dong}"
    combined_used = title_history.get(location_key, set())

    print("==============================================")
    print(f"[테스트] {gu} {dong} / {work_type}")
    print("이 글은 '임시저장(draft)' 상태로 등록됩니다 (사이트에 공개 안 됨).")
    print("==============================================")

    ok, title = create_or_update_electric_case(
        gu,
        dong,
        work_type,
        auth,
        used_titles=combined_used,
        force_status="draft",
    )

    if ok:
        title_history.setdefault(location_key, set()).add(title)
        save_title_history(title_history)
        print("\n✅ 테스트 등록 완료 — 워드프레스 관리자에서 확인해보세요.")
    else:
        print("\n❌ 테스트 등록 실패 — 위 로그를 확인해주세요.")


if __name__ == "__main__":
    print("==============================================")
    print("전기수리 사례(electric_case) + TXT 본문 + Yoast 자동 등록")
    print("==============================================")
    print(f"등록 주소: {ELECTRIC_CASE_ENDPOINT}")
    print(f"실행 모드: {RUN_MODE}")

    if RUN_MODE == "TEST_ONE":
        run_single_test_post()
    elif RUN_MODE == "DAILY":
        run_daily_scheduled_poster_v2(count=POSTS_PER_DAY)
    elif RUN_MODE == "DRAFT_N":
        print(f"상태: {POST_STATUS}")
        print(f"전기수리 사례 {MAX_POSTS_PER_RUN}개를 등록합니다.")
        print("==============================================")
        run_auto_poster(max_posts=MAX_POSTS_PER_RUN)
    elif RUN_MODE == "MANUAL_300":
        run_manual_articles_poster(count=POSTS_PER_DAY)
    elif RUN_MODE == "FIX_META":
        run_fix_duplicate_meta_descriptions()
    elif RUN_MODE == "FIX_META_ALL":
        run_fix_all_meta_descriptions()
    elif RUN_MODE == "FIX_READABILITY_ALL":
        run_fix_readability_all()
    elif RUN_MODE == "FIX_MID_BANNER_ALL":
        run_fix_mid_banner_all()
    elif RUN_MODE == "FIX_ICON_GRID_ALL":
        run_fix_icon_grid_all()
    elif RUN_MODE == "FIX_ACF_FIELDS_ALL":
        run_fix_acf_fields_all()
    elif RUN_MODE == "FIX_TITLE_TUPLE_ALL":
        run_fix_title_tuple_all()
    elif RUN_MODE == "FIX_FEATURED_IMAGE_ALL":
        run_fix_featured_image_all()
    elif RUN_MODE == "FIX_UNIQUE_THUMBNAIL_ALL":
        run_fix_unique_thumbnail_all()
    elif RUN_MODE == "REMOVE_FEATURED_IMAGE_ALL":
        run_remove_featured_image_all()
    elif RUN_MODE == "SET_LOGO_FEATURED_ALL":
        run_set_logo_featured_image_all()
    elif RUN_MODE == "SYNC_ALL_LIKE_NEW":
        run_sync_all_like_new()
    else:
        print(f"❌ 알 수 없는 RUN_MODE입니다: {RUN_MODE!r}")
        print('   "TEST_ONE" / "DAILY" / "DRAFT_N" / "MANUAL_300" / "FIX_META" / "FIX_META_ALL" / "FIX_READABILITY_ALL" / "FIX_MID_BANNER_ALL" / "FIX_ICON_GRID_ALL" / "FIX_ACF_FIELDS_ALL" / "FIX_TITLE_TUPLE_ALL" / "FIX_FEATURED_IMAGE_ALL" / "FIX_UNIQUE_THUMBNAIL_ALL" / "REMOVE_FEATURED_IMAGE_ALL" / "SET_LOGO_FEATURED_ALL" / "SYNC_ALL_LIKE_NEW" 중 하나로 설정해주세요.')