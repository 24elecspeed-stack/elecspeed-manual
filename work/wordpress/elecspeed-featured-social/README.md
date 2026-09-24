# 대표사진 기준 Yoast 이미지 통일

2026-09-24 준비한 서버 적용 전 수정안. 실제 서버 설치·실행 및 PHP 런타임 검증은 아직 하지 않았습니다.

## 동작

electric_case 글의 현재 WordPress 대표사진을 Yoast Open Graph 및 X 이미지로 사용합니다. 이미지 주소, 실제 원본 너비·높이, MIME 형식을 함께 맞추며 Yoast REST 응답도 같은 글의 모델을 기준으로 처리합니다. 대표사진을 바꾸면 다음 생성 응답부터 새 사진을 사용합니다.

대표사진 자체나 본문, DB의 기존 Yoast 설정은 덮어쓰지 않습니다. 대표사진이 없는 글은 기존 동작을 유지합니다. 홈페이지·카테고리·조직 로고는 대상이 아닙니다. 기존 대표사진 URL 교체 스니펫과 충돌 여부는 설치 시 확인해야 합니다.

## 적용 및 검증

1. WordPress 플러그인 업로드에서 배포 ZIP을 설치·활성화합니다.
2. 페이지 캐시·서버 캐시·CDN 캐시가 있다면 삭제합니다.
3. 사례 3018 및 3169의 HTML과 REST 응답을 각각 확인합니다. og:image는 해당 글 대표사진이고, 현재 사진 기준 크기는 1200×630, 형식은 image/jpeg여야 합니다. X 이미지가 출력되면 같은 URL이어야 합니다.
4. 전체 315개 글을 다시 검사하고 본문 대표사진·OG·구조화데이터의 페이지 대표이미지 일치 여부를 확인합니다.
5. 필요하면 Yoast SEO 도구에서 SEO 데이터 최적화를 실행하고 사이트맵·검색도구 재수집 상태를 확인합니다. 검색 결과 반영 시점과 썸네일 선택은 검색엔진이 결정합니다.

되돌리기: 이 플러그인을 비활성화하고 캐시를 삭제합니다. DB 변경이 없어 이전 출력 동작으로 돌아갑니다.

## 진단 근거

- 전체 공개 사례 315개, 모두 대표사진 보유. 고유 대표사진은 50개.
- Yoast REST 이미지가 대표사진과 다른 글 297개. 이 중 285개는 520×520 로고, 12개는 다른 사이트 로고.
- 실제 HTML 표본은 사진 URL이 이미 대표사진이지만 오래된 크기·형식이 남았습니다. 예: 3018은 elecfeatured-09.jpg를 가리키면서 520×520, image/png 출력. URL만 교체하는 서버 처리 가능성이 있으나 관리자 코드 확인 전에는 원인 구현을 단정할 수 없습니다.
- robots.txt는 업로드 경로를 차단하지 않으며 확인한 페이지는 max-image-preview:large를 출력합니다.
- 확인 당시 사례 사이트맵은 299 URL 및 299 이미지 항목을 포함했습니다. REST 공개 글 수와 차이가 나는 이유는 별도 색인 설정 확인이 필요합니다.
- API 진단: outputs/thumbnail-audit-2026-09-24.json

네이버는 반복 이미지·로고·홍보 배너를 대표 썸네일로 사용하지 않을 수 있다고 안내합니다. 글마다 현장 내용을 나타내는 고유 사진을 사용하는 것이 추가 개선 방향입니다. 이 패치는 검색 노출을 보장하지 않습니다.

공식 참고:
- https://developer.yoast.com/features/opengraph/api/wpseo-opengraph-images/
- https://developer.yoast.com/customization/apis/metadata-api/
- https://searchadvisor.naver.com/guide/markup-content
- https://developers.google.com/search/docs/appearance/google-images
