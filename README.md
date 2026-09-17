# 워드프레스 수동등록 앱 작업 이어받기

기존 Codex 작업의 대화 기록과 구현 자료를 복사한 폴더입니다.
사이드바에서 원래 대화의 프로젝트 소속을 변경한 것은 아닙니다.

**가장 먼저 outputs/인수인계-v1.8-필수검색순서.md를 읽으세요.** (검색 지시문을 프롬프트 맨 앞
필수 절차로 바꾼 내용 + v1.7에서 넘어온 미완료 항목 — 4개 카테고리 개편안, 40인 작가 스타일
다양화가 아직 코드에 반영 안 됐습니다.)
그다음 v1.7 → v1.6 → v1.5 → v1.4-마이그레이션 → v1.3 → v1.2 → 인수인계서.md → 대화기록.md 순으로 봅니다.

**참고**: 이 프로젝트와 별개로 `C:\Users\manowar\Desktop\ElectricBlogClipboard_AndroidProject\`에
"ElectricBlogClipboard"(네이버 블로그용, 완전히 다른 Android 프로젝트)가 있습니다. 둘 다 같은
작업 종류/카테고리 프리셋 데이터를 쓰고 있어서 지시문에 프로젝트 이름이 안 적혀 있으면 헷갈리기
쉽습니다 — v1.7 문서의 "6. 오늘 있었던 혼동" 참고.

- 최신 APK: outputs/elecspeed-chatgpt.apk (v1.2 / versionCode 3, 카테고리·ChatGPT 연동 +
  실제 로고 아이콘 + 편집 화면 상단 "글 초기화" 버튼 포함)
  - 이전 로그인 전용 버전: outputs/elecspeed-manual-login.apk (v1.1, 카테고리 기능 없음)
- 소스: work/android/src (MainActivity, ArticleCodec, CategorySettings, Ui, WorkType, WritingCategory)
- 빌드 스크립트: work/android/build.ps1 (PowerShell에서 `.\build.ps1` 실행)
- 배너: work/android/assets
- 원본 자료: references/tot.py 및 references/app-debug-icon.apk
- 개발용 서명 키: work/android/signing.jks
- 마이그레이션 전 v1.0 백업: migration-backups/2026-09-13-v1.0/

Android SDK/JDK는 이 PC(Android Studio 설치 경로)에 이미 있는 것을 그대로 사용합니다.
`work/android/android.jar`는 `platforms/android-35/android.jar`를 복사해 넣었습니다(용량이 커서
저장소에는 포함하지 않는 편이 좋습니다). 이 폴더에서 빌드하면 인수인계서에 적혀 있던 javac
`AccessDeniedException`이 재현되지 않았습니다 — 자세한 내용은 v1.4 문서 참고.

실기기 및 실제 로그인·업로드는 미검증입니다.
원본 파이썬 게시글 폼과 아직 다른 부분은 인수인계서를 확인하세요.

원본 작업 ID: 01a096cf-4400-79e2-a4fb-d4cd5b687122
원본 작업 제목: py 폼 그대로 수동 업로드