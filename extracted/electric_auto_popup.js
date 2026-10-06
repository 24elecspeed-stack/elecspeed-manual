// 전기수리 자동발행 탭 UI 로직. popup.js의 기존 코드는 건드리지 않고 독립적으로 동작한다.
(function () {
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, resp => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error("백그라운드로부터 응답이 없습니다."));
        resolve(resp);
      });
    });
  }

  function $(id) {
    return document.getElementById(id);
  }

  // confirm()/alert()는 확장 팝업/사이드패널을 블러시켜 꺼지게 만들 수 있어서 쓰지 않는다.
  // 대신 로그 줄에 그대로 찍는다.
  function logLine(text) {
    const el = $("ea-log");
    el.textContent += (el.textContent ? "\n" : "") + text;
    el.scrollTop = el.scrollHeight;
  }

  async function refreshLogAndState() {
    try {
      const resp = await sendMessage({ action: "electricGetState" });
      if (resp.success) {
        $("ea-log").textContent = (resp.data.log || []).join("\n");
        $("ea-log").scrollTop = $("ea-log").scrollHeight;
      }
    } catch (e) {
      // 팝업이 열릴 때 서비스워커가 아직 깨어나는 중일 수 있음 - 조용히 무시
    }
  }

  async function loadSettingsIntoForm() {
    const resp = await sendMessage({ action: "electricGetSettings" });
    if (!resp.success) return;
    const s = resp.data;
    $("ea-wp-url").value = s.wpSiteUrl || "";
    $("ea-wp-user").value = s.wpUsername || "";
    $("ea-wp-pass").value = s.wpAppPassword || "";
    $("ea-main-keyword").value = s.mainKeyword || "전기수리";
    $("ea-posts-per-day").value = s.postsPerDay || 1;
    $("ea-window-start").value = s.windowStartHour ?? 9;
    $("ea-window-end").value = s.windowEndHour ?? 21;
    $("ea-publish-live").checked = s.publishStatus === "publish";
  }

  function collectSettingsFromForm() {
    return {
      wpSiteUrl: $("ea-wp-url").value.trim(),
      wpUsername: $("ea-wp-user").value.trim(),
      wpAppPassword: $("ea-wp-pass").value,
      mainKeyword: $("ea-main-keyword").value.trim() || "전기수리",
      postsPerDay: Math.max(1, parseInt($("ea-posts-per-day").value, 10) || 1),
      windowStartHour: Math.min(23, Math.max(0, parseInt($("ea-window-start").value, 10) || 9)),
      windowEndHour: Math.min(23, Math.max(0, parseInt($("ea-window-end").value, 10) || 21)),
      publishStatus: $("ea-publish-live").checked ? "publish" : "draft"
    };
  }

  function init() {
    const tabButton = document.querySelector('.tab-btn[data-tab="electric-auto"]');
    if (tabButton) tabButton.addEventListener("click", () => { loadSettingsIntoForm(); refreshLogAndState(); });

    $("ea-save-settings").addEventListener("click", async () => {
      const settings = collectSettingsFromForm();
      await sendMessage({ action: "electricSaveSettings", settings });
      logLine("설정을 저장했습니다.");
    });

    $("ea-preview-keywords").addEventListener("click", async () => {
      $("ea-keyword-preview").textContent = "불러오는 중...";
      try {
        await sendMessage({ action: "electricSaveSettings", settings: collectSettingsFromForm() });
        const resp = await sendMessage({ action: "electricPreviewKeywords", count: 10 });
        if (!resp.success) throw new Error(resp.error);
        if (resp.data.length === 0) {
          $("ea-keyword-preview").textContent = "저경쟁 키워드가 없습니다. '키워드 분석' 탭에서 전기수리 관련 키워드를 먼저 분석해주세요.";
        } else {
          $("ea-keyword-preview").textContent = resp.data
            .map((k, i) => `${i + 1}. ${k.keyword} (경쟁:${k.competition}, 검색량:${k.totalSearch}, 비율:${k.competitionRatio})`)
            .join("\n");
        }
      } catch (e) {
        $("ea-keyword-preview").textContent = `오류: ${e.message}`;
      }
    });

    let currentDraft = null;

    function showDraft(draft) {
      currentDraft = draft;
      $("ea-draft-box").style.display = "block";
      $("ea-draft-title").textContent = draft.title;
      $("ea-draft-summary").textContent = draft.summary;
      $("ea-draft-body").innerHTML = draft.html;
      $("ea-confirm-publish").checked = false;
      $("ea-publish-warning").textContent = "";
    }

    $("ea-generate-draft").addEventListener("click", async () => {
      $("ea-draft-box").style.display = "none";
      $("ea-generate-draft").disabled = true;
      logLine("초안 생성 시작... (경쟁글 크롤링 + Gemini API 호출, 몇 초~수십 초 걸릴 수 있습니다)");
      try {
        await sendMessage({ action: "electricSaveSettings", settings: collectSettingsFromForm() });
        const resp = await sendMessage({ action: "electricGenerateDraft" });
        if (!resp.success) throw new Error(resp.error);
        showDraft(resp.data);
        logLine(`초안 완료: ${resp.data.title} - 아래 미리보기를 확인하세요.`);
      } catch (e) {
        logLine(`실패: ${e.message}`);
      }
      $("ea-generate-draft").disabled = false;
      refreshLogAndState();
    });

    $("ea-publish-draft").addEventListener("click", async () => {
      if (!currentDraft) return;
      if (!$("ea-confirm-publish").checked) {
        $("ea-publish-warning").textContent = "먼저 위 체크박스로 내용을 확인했다고 표시해주세요.";
        return;
      }
      $("ea-publish-warning").textContent = "";
      logLine("발행 중...");
      try {
        await sendMessage({ action: "electricSaveSettings", settings: collectSettingsFromForm() });
        const resp = await sendMessage({ action: "electricPublishDraft", article: currentDraft });
        if (!resp.success) throw new Error(resp.error);
        logLine(`완료: ${resp.data.title} -> ${resp.data.link} (${resp.data.status})`);
        $("ea-draft-box").style.display = "none";
        currentDraft = null;
      } catch (e) {
        logLine(`실패: ${e.message}`);
      }
      refreshLogAndState();
    });

    $("ea-start-auto").addEventListener("click", async () => {
      const settings = collectSettingsFromForm();
      await sendMessage({ action: "electricSaveSettings", settings });
      const resp = await sendMessage({ action: "electricStartAuto" });
      if (resp.success) {
        logLine(
          `자동발행이 시작되었습니다 (매일 ${settings.windowStartHour}시~${settings.windowEndHour}시 사이 랜덤, ${settings.postsPerDay}개, 상태: ${settings.publishStatus === "publish" ? "실제 발행" : "임시글"}).`
        );
      }
      refreshLogAndState();
    });

    $("ea-stop-auto").addEventListener("click", async () => {
      await sendMessage({ action: "electricStopAuto" });
      logLine("자동발행을 중지했습니다.");
      refreshLogAndState();
    });

    loadSettingsIntoForm();
    refreshLogAndState();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
