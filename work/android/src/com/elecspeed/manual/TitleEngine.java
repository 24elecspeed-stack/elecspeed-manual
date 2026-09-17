package com.elecspeed.manual;

import android.content.Context;
import org.json.JSONArray;
import java.util.*;

/**
 * ElectricBlogClipboard(전기 블로그 복사 앱)의 TitleEngine.kt를 이 프로젝트(elecspeed-manual)용
 * Java로 그대로 옮긴 것입니다. "지역 + 차단기 내려감" 같은 고정 패턴이 반복되던 문제를 고치기
 * 위한 로직으로, 실제 글쓰기는 ChatGPT에 맡기되 "이번 글은 이 서비스 키워드 + 이 문장 구조로
 * 제목을 쓰라"는 지시를 앱이 직접 정해서 프롬프트에 못박아 넣습니다.
 *
 * ArticleCodec.java는 "No Android or network dependencies"를 원칙으로 하므로, Context가 필요한
 * 이력 관리(TitleHistory, plan())는 이 클래스에 두고, ArticleCodec에는 Context 없이 쓸 수 있는
 * 순수 텍스트 조립 메서드(titleGuidanceBlock 등)만 넘겨줍니다. MainActivity가 plan()으로 이번 글의
 * 조합을 미리 뽑아 ArticleCodec.prompt()에 Selection으로 전달하는 구조입니다.
 */
public final class TitleEngine {
    private TitleEngine() {}

    public enum ServiceGroup {
        GISA("전기기사형", "전기기사"),
        LEAK_GISA("누전전기기사형", "전기누전 전기기사", "누전전기기사"),
        REPAIR_CO("전기수리업체형", "전기수리업체"),
        LEAK_REPAIR_CO("누전수리업체형", "누전수리업체", "전기누전수리업체"),
        DISPATCH("전기출장형", "전기출장", "전기출장수리", "누전출장", "출장전기기사"),
        BREAKDOWN_REPAIR("전기고장수리형", "전기고장수리"),
        LEAK_REPAIR("누전수리형", "누전수리", "전기누전수리"),
        PARTIAL_OUTAGE("부분정전수리형", "부분정전수리"),
        SYMPTOM_REPAIR("증상수리형", "전기수리기사", "콘센트수리", "전기배선수리");

        public final String label;
        public final List<String> keywords;
        ServiceGroup(String label, String... keywords) { this.label = label; this.keywords = Arrays.asList(keywords); }
    }

    public enum SymptomClass { BREAKER_DOWN, TOAD_HOUSE, LEAK, OUTLET, WIRING, BURN, GENERAL }

    /** 작업 종류(WorkType.LABELS) 문자열을 증상 갈래로 분류합니다. "누전"이 들어간 차단기 증상은
     * BREAKER_DOWN보다 LEAK을 우선합니다(누전 전용 서비스 키워드가 더 정확하므로). */
    public static SymptomClass classify(String symptom) {
        if (symptom == null) return SymptomClass.GENERAL;
        if (symptom.contains("누전")) return SymptomClass.LEAK;
        if (symptom.contains("탄내") || symptom.contains("타는 냄새") || symptom.contains("스파크")
            || symptom.contains("소리남") || symptom.contains("발열")) return SymptomClass.BURN;
        if (symptom.contains("두꺼비집")) return SymptomClass.TOAD_HOUSE;
        if (symptom.contains("차단기")) return SymptomClass.BREAKER_DOWN;
        if (symptom.contains("콘센트") || symptom.contains("부분정전") || symptom.contains("정전 복구")
            || symptom.contains("스위치") || symptom.contains("조명") || symptom.contains("전등")) return SymptomClass.OUTLET;
        if (symptom.contains("배선") || symptom.contains("분전반") || symptom.contains("전용선")
            || symptom.contains("접지") || symptom.contains("증설")) return SymptomClass.WIRING;
        return SymptomClass.GENERAL;
    }

    /** 증상 갈래마다 자연스러운 서비스 키워드 그룹만 허용합니다 — 배선 공사 글에 "부분정전수리"를 쓰지 않음. */
    public static List<ServiceGroup> allowedGroups(SymptomClass sc) {
        switch (sc) {
            case BREAKER_DOWN: return Arrays.asList(ServiceGroup.GISA, ServiceGroup.REPAIR_CO, ServiceGroup.DISPATCH, ServiceGroup.BREAKDOWN_REPAIR, ServiceGroup.LEAK_REPAIR);
            case TOAD_HOUSE: return Arrays.asList(ServiceGroup.GISA, ServiceGroup.REPAIR_CO, ServiceGroup.DISPATCH, ServiceGroup.BREAKDOWN_REPAIR);
            case LEAK: return Arrays.asList(ServiceGroup.LEAK_GISA, ServiceGroup.LEAK_REPAIR_CO, ServiceGroup.DISPATCH, ServiceGroup.LEAK_REPAIR);
            case OUTLET: return Arrays.asList(ServiceGroup.GISA, ServiceGroup.REPAIR_CO, ServiceGroup.DISPATCH, ServiceGroup.BREAKDOWN_REPAIR, ServiceGroup.PARTIAL_OUTAGE, ServiceGroup.SYMPTOM_REPAIR);
            case WIRING: return Arrays.asList(ServiceGroup.REPAIR_CO, ServiceGroup.SYMPTOM_REPAIR, ServiceGroup.BREAKDOWN_REPAIR, ServiceGroup.DISPATCH);
            case BURN: return Arrays.asList(ServiceGroup.GISA, ServiceGroup.REPAIR_CO, ServiceGroup.DISPATCH, ServiceGroup.BREAKDOWN_REPAIR);
            default: return Arrays.asList(ServiceGroup.GISA, ServiceGroup.REPAIR_CO, ServiceGroup.DISPATCH, ServiceGroup.BREAKDOWN_REPAIR);
        }
    }

    /** 증상 갈래별로 본문에서 우선 활용할 표현 — 배선 공사 글에 "두꺼비집" 같은 무관한 표현이 안 섞이게. */
    public static List<String> bodyExpressions(SymptomClass sc) {
        switch (sc) {
            case BREAKER_DOWN: return Arrays.asList("차단기가 자꾸 떨어짐", "분전반 점검", "절연저항 검사", "차단기 노후");
            case TOAD_HOUSE: return Arrays.asList("두꺼비집 안 올라감", "두꺼비집 떨어짐", "분전반 점검", "절연저항 검사");
            case LEAK: return Arrays.asList("누설전류", "절연저항 검사", "누전 차단기", "전기선 탄화");
            case OUTLET: return Arrays.asList("콘센트 전기 안됨", "부분정전", "접속 불량", "전기선 경화");
            case WIRING: return Arrays.asList("전기선 교체", "배선 노후", "절연저항 검사", "접속부 확인");
            case BURN: return Arrays.asList("분전반 탄내", "타는 냄새", "전기선 탄화", "스파크");
            default: return Arrays.asList("전기 안전점검", "절연저항 검사", "분전반 점검");
        }
    }

    public enum TitleGrammar {
        A("지역+서비스+증상", "지역 이름 다음에 서비스 검색어, 그 다음에 실제 증상을 붙이는 구조"),
        B("지역+증상+서비스", "지역 이름 다음에 실제 증상, 그 다음에 서비스 검색어를 붙이는 구조"),
        C("증상+지역+서비스", "실제 증상으로 문장을 시작하고, 지역과 서비스 검색어를 뒤에 붙이는 구조"),
        D("서비스+지역+구체적고장", "서비스 검색어로 문장을 시작하고, 지역과 구체적인 고장 상황을 뒤에 붙이는 구조"),
        E("질문+지역", "증상을 질문 형태로 던지고 지역과 서비스 검색어를 뒤에 붙이는 구조"),
        F("현상중심", "서비스 검색어 없이 눈에 보이는 현상을 먼저 설명하고 지역·서비스는 뒤에 자연스럽게 붙이는 구조");

        public final String label, description;
        TitleGrammar(String label, String description) { this.label = label; this.description = description; }

        /** ChatGPT에게 "형태만 참고하라"고 보여줄 예시. place가 비어 있으면(구/동 미입력) 지역 없이 이어집니다. */
        public String exampleTitle(String place, String service, String symptom) {
            String p = place == null ? "" : place.trim();
            boolean blank = p.isEmpty();
            switch (this) {
                case A: return blank ? service+", "+symptom+" 확인이 필요한 경우" : p+" "+service+", "+symptom+" 확인이 필요한 경우";
                case B: return blank ? symptom+", "+service+" 점검이 필요한 경우" : p+" "+symptom+", "+service+" 점검이 필요한 경우";
                case C: return blank ? symptom+" 증상이 있다면 "+service+" 점검" : symptom+" 증상이 있다면, "+p+" "+service+" 점검";
                case D: return blank ? service+", "+symptom+" 확인이 필요한 상황" : service+" "+p+", "+symptom+" 확인이 필요한 상황";
                case E: return blank ? symptom+", 원인이 뭘까요? "+service+" 점검" : symptom+", 원인이 뭘까요? "+p+" "+service+" 점검";
                default: return blank ? symptom+" 증상이 있다면, "+service+" 문의가 많습니다" : symptom+" 증상이 있다면, "+p+" 에서 "+service+" 문의가 많습니다";
            }
        }
    }

    /** 매번 증상->원인->절연저항->배선->안전주의 순서로만 쓰지 않도록 본문 전개 방식을 8가지로 순환합니다. */
    public enum BodyFlow {
        ON_SITE("현장 증상 흐름형", "현장에서 실제로 벌어진 증상을 시간 순서대로 따라가며 설명"),
        LOCATE("고장 위치 추적형", "고장이 발생한 위치를 하나씩 좁혀가며 추적하는 방식으로 설명"),
        COMPARE("원인 비교형", "가능한 원인 여러 개를 나란히 비교하며 설명"),
        OUTAGE_SCOPE("정전 범위 추적형", "정전이 집 전체인지 일부인지 범위를 기준으로 추적하며 설명"),
        APPLIANCE("가전제품 사용 상황형", "가전제품 사용 상황과 연결지어 설명"),
        WIRING_OUTLET("배선·콘센트 중심형", "배선·콘센트 상태를 중심으로 설명"),
        BREAKER_FOCUS("차단기 중심형", "차단기 자체 상태(노후, 접촉 불량, 용량 부족)를 중심으로 설명"),
        ANOMALY("이상징후 중심형", "냄새·소리·열감 같은 평소와 다른 이상징후를 중심으로 설명");

        public final String label, description;
        BodyFlow(String label, String description) { this.label = label; this.description = description; }
    }

    // "여성 20명 남성 20명, 매번 문체를 다르게" 요구사항. 실명·자기소개를 지어내라는 뜻이 아니라
    // 문체/어투만 빌리는 용도라 personaGuidanceBlock에 그 단서를 같이 넣습니다.
    private static final String[] FEMALE_PERSONAS = {
        "20대 여성, 발랄하고 친근한 다정한 문체",
        "20대 여성, 꼼꼼하게 설명하는 친절한 존댓말",
        "20대 여성, 담백하고 군더더기 없는 말투",
        "20대 여성, 논리적이고 정리된 설명체",
        "20대 여성, 솔직 담백한 후기형 말투",
        "30대 여성, 차분하고 다정한 설명체",
        "30대 여성, 야무지고 똑 부러지는 말투",
        "30대 여성, 육아맘 느낌의 실생활 공감형 말투",
        "30대 여성, 친구에게 설명하듯 편안한 말투",
        "30대 여성, 유쾌하고 가벼운 유머가 섞인 말투",
        "30대 여성, 바쁜 워킹맘의 간결한 말투",
        "40대 여성, 신중하고 꼼꼼한 살림형 말투",
        "40대 여성, 다정하지만 단호한 조언형 말투",
        "40대 여성, 살짝 걱정 섞인 세심한 말투",
        "40대 여성, 신뢰감 있는 전문가형 말투",
        "40대 여성, 알기 쉽게 풀어주는 선생님 같은 말투",
        "50대 여성, 경험 많은 이웃 같은 편안한 말투",
        "50대 여성, 정중하고 예의 바른 존댓말",
        "50대 여성, 손윗사람 같은 다독이는 말투",
        "50대 여성, 느긋하고 여유 있는 말투"
    };

    private static final String[] MALE_PERSONAS = {
        "20대 남성, 간결하고 직설적인 말투",
        "20대 남성, 친근하고 편안한 말투",
        "20대 남성, 효율적이고 요점만 짚는 말투",
        "20대 남성, 담백하고 군더더기 없는 말투",
        "30대 남성, 차분하고 논리적인 설명체",
        "30대 남성, 무뚝뚝하지만 성실한 말투",
        "30대 남성, 꼼꼼하게 근거를 짚어주는 말투",
        "30대 남성, 친절하지만 단정적인 말투",
        "30대 남성, 초보자 눈높이에 맞춰 설명하는 말투",
        "30대 남성, 유쾌하고 편안한 말투",
        "40대 남성, 경험 많은 선배 같은 조언형 말투",
        "40대 남성, 신뢰감 있는 전문가형 말투",
        "40대 남성, 담담하고 절제된 말투",
        "40대 남성, 현장 경험을 강조하는 실무형 말투",
        "40대 남성, 꼼꼼하고 세심한 말투",
        "40대 남성, 안전을 강조하는 신중한 말투",
        "50대 남성, 점잖고 정중한 존댓말",
        "50대 남성, 연륜이 느껴지는 차분한 말투",
        "50대 남성, 느긋하고 여유 있는 말투",
        "50대 남성, 이웃 아저씨 같은 편안한 말투"
    };

    private static final List<String> WRITER_PERSONAS;
    static {
        List<String> all = new ArrayList<>();
        all.addAll(Arrays.asList(FEMALE_PERSONAS));
        all.addAll(Arrays.asList(MALE_PERSONAS));
        WRITER_PERSONAS = Collections.unmodifiableList(all);
    }

    public static final class Selection {
        public final ServiceGroup group; public final String keyword; public final TitleGrammar grammar;
        public final BodyFlow flow; public final String persona;
        Selection(ServiceGroup group, String keyword, TitleGrammar grammar, BodyFlow flow, String persona) {
            this.group = group; this.keyword = keyword; this.grammar = grammar; this.flow = flow; this.persona = persona;
        }
    }

    /** PlaceHistory와 같은 패턴: SharedPreferences에 최근 (그룹, 문법, 전개, 문체)를 남겨서 연속 반복을 피합니다. */
    public static final class TitleHistory {
        private static final String PREFS = "title_history";
        private static final String KEY_GROUPS = "recent_groups", KEY_GRAMMARS = "recent_grammars",
            KEY_FLOWS = "recent_flows", KEY_PERSONAS = "recent_personas";
        private static final int MAX_ITEMS = 6;
        private TitleHistory() {}

        static List<String> recentGroups(Context c) { return readArray(c, KEY_GROUPS); }
        static List<String> recentGrammars(Context c) { return readArray(c, KEY_GRAMMARS); }
        static List<String> recentFlows(Context c) { return readArray(c, KEY_FLOWS); }
        static List<String> recentPersonas(Context c) { return readArray(c, KEY_PERSONAS); }

        static void remember(Context c, ServiceGroup group, TitleGrammar grammar, BodyFlow flow, String persona) {
            push(c, KEY_GROUPS, group.name());
            push(c, KEY_GRAMMARS, grammar.name());
            push(c, KEY_FLOWS, flow.name());
            push(c, KEY_PERSONAS, persona);
        }

        private static void push(Context c, String key, String value) {
            List<String> current = new ArrayList<>(readArray(c, key));
            current.add(0, value);
            List<String> trimmed = current.subList(0, Math.min(MAX_ITEMS, current.size()));
            JSONArray array = new JSONArray();
            for (String s : trimmed) array.put(s);
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(key, array.toString()).apply();
        }

        private static List<String> readArray(Context c, String key) {
            String raw = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key, null);
            if (raw == null) return Collections.emptyList();
            try {
                JSONArray array = new JSONArray(raw);
                List<String> out = new ArrayList<>();
                for (int i = 0; i < array.length(); i++) out.add(array.getString(i));
                return out;
            } catch (Exception e) { return Collections.emptyList(); }
        }
    }

    /** 이번 글에 쓸 (서비스 키워드 그룹, 제목 문법, 본문 전개, 문체) 조합을 고릅니다. 최근 쓴 것은
     * 최대한 피하고, 후보가 하나도 안 남으면(허용 그룹이 1~2개뿐인 증상) 전체 허용 목록으로 되돌아갑니다. */
    public static Selection plan(Context context, String symptom) { return plan(context, symptom, new Random()); }

    public static Selection plan(Context context, String symptom, Random random) {
        List<ServiceGroup> allowed = allowedGroups(classify(symptom));
        List<String> recentGroups = firstN(TitleHistory.recentGroups(context), 2);
        List<ServiceGroup> groupCandidates = new ArrayList<>();
        for (ServiceGroup g : allowed) if (!recentGroups.contains(g.name())) groupCandidates.add(g);
        if (groupCandidates.isEmpty()) groupCandidates = allowed;
        ServiceGroup group = groupCandidates.get(random.nextInt(groupCandidates.size()));
        String keyword = group.keywords.get(random.nextInt(group.keywords.size()));

        List<String> recentGrammars = firstN(TitleHistory.recentGrammars(context), 2);
        List<TitleGrammar> grammarCandidates = new ArrayList<>();
        for (TitleGrammar g : TitleGrammar.values()) if (!recentGrammars.contains(g.name())) grammarCandidates.add(g);
        if (grammarCandidates.isEmpty()) grammarCandidates = Arrays.asList(TitleGrammar.values());
        TitleGrammar grammar = grammarCandidates.get(random.nextInt(grammarCandidates.size()));

        List<String> recentFlows = firstN(TitleHistory.recentFlows(context), 2);
        List<BodyFlow> flowCandidates = new ArrayList<>();
        for (BodyFlow f : BodyFlow.values()) if (!recentFlows.contains(f.name())) flowCandidates.add(f);
        if (flowCandidates.isEmpty()) flowCandidates = Arrays.asList(BodyFlow.values());
        BodyFlow flow = flowCandidates.get(random.nextInt(flowCandidates.size()));

        List<String> recentPersonas = TitleHistory.recentPersonas(context);
        List<String> personaCandidates = new ArrayList<>();
        for (String p : WRITER_PERSONAS) if (!recentPersonas.contains(p)) personaCandidates.add(p);
        if (personaCandidates.isEmpty()) personaCandidates = WRITER_PERSONAS;
        String persona = personaCandidates.get(random.nextInt(personaCandidates.size()));

        return new Selection(group, keyword, grammar, flow, persona);
    }

    private static List<String> firstN(List<String> list, int n) { return list.subList(0, Math.min(n, list.size())); }

    public static void remember(Context context, Selection sel) {
        TitleHistory.remember(context, sel.group, sel.grammar, sel.flow, sel.persona);
    }

    public static String titleGuidanceBlock(Selection plan, String place, String symptom) {
        StringBuilder sb = new StringBuilder();
        sb.append("\n[제목 작성 지침 - 반드시 지켜주세요]\n");
        sb.append("이번 글의 제목에는 반드시 서비스 검색어 \"").append(plan.keyword).append("\"를 자연스럽게 포함해 주세요.\n");
        sb.append("제목 문장 구조: ").append(plan.grammar.label).append(" (").append(plan.grammar.description).append(").\n");
        sb.append("예시 형태(문장을 그대로 베끼지 말고 구조만 참고하세요): \"").append(plan.grammar.exampleTitle(place, plan.keyword, symptom)).append("\"\n");
        sb.append("절대 금지: \"지역 + ").append(symptom).append(", 설명\" 처럼 서비스 검색어 없이 지역과 증상만 이어붙인 제목은 쓰지 마세요.\n");
        sb.append("(예: \"고양시 백석동 차단기 내려감, 원인을 확인해보기\" 같은 형태는 사용하지 않습니다.)\n");
        return sb.toString();
    }

    public static String bodyExpressionGuidance(String symptom) {
        List<String> expressions = bodyExpressions(classify(symptom));
        StringBuilder sb = new StringBuilder();
        sb.append("\n[본문에서 우선 활용할 표현] (이 글의 증상과 관련 있는 것만, 자연스럽게 녹여서 사용)\n");
        sb.append(String.join(", ", expressions)).append("\n");
        sb.append("이 글과 관계없는 다른 고장 증상 표현(예: 배선 공사 글인데 두꺼비집, 콘센트 글인데 메인 차단기 등)을 억지로 넣지 마세요. 실제 현장 메모·증상과 관련 있는 표현만 사용해 주세요.\n");
        return sb.toString();
    }

    public static String bodyFlowGuidance(BodyFlow flow) {
        StringBuilder sb = new StringBuilder();
        sb.append("\n[본문 전개 방식 - 이번 글은 이 흐름으로 풀어주세요]\n");
        sb.append(flow.label).append(": ").append(flow.description).append(".\n");
        sb.append("매번 같은 순서(증상 -> 원인 -> 절연저항 -> 배선 -> 안전주의)로 반복하지 말고, 위 전개 방식에 맞춰 문단 순서와 강조점을 구성해 주세요.\n");
        return sb.toString();
    }

    public static String personaGuidanceBlock(String persona) {
        StringBuilder sb = new StringBuilder();
        sb.append("\n[글쓴이 문체 - 이번 글은 이 말투로 써주세요]\n");
        sb.append(persona).append("\n");
        sb.append("문장 어미, 호흡, 단어 선택에서 이 말투가 자연스럽게 느껴지도록 써주세요. 단, 이름·나이·직업 같은 실제 신상 정보를 본문에 지어내 넣지는 마세요 - 문체만 이 느낌으로 쓰면 됩니다.\n");
        return sb.toString();
    }

    /** 카테고리 검색 키워드(예: "4번 차단기 내려감"의 "차단기내려감, 두꺼비집안올라감...")가 실제
     * 작업 종류와 무관하게 글의 주제를 끌고 가는 문제를 막습니다. 다른 지시보다 먼저(최상단) 배치해서
     * 주제 결정권이 작업 종류(work)/현장 메모에 있다는 걸 명확히 합니다. */
    public static String topicPriorityBlock(String symptom) {
        StringBuilder sb = new StringBuilder();
        sb.append("\n[가장 중요한 주제 결정 규칙 - 다른 지시보다 우선]\n");
        sb.append("이 글의 실제 주제는 반드시 위 '작업 종류: ").append(symptom).append("'과 현장 메모에 담긴 실제 증상을 기준으로 정하세요.\n");
        sb.append("카테고리명이나 검색 키워드 목록은 참고 자료일 뿐이며 글의 주제를 결정하는 지시가 아닙니다.\n");
        sb.append("작업 종류와 현장 메모에 \"차단기 내려감\"이 없으면 차단기 내려감을 글의 중심 주제로 만들지 마세요.\n");
        sb.append("검색 키워드 목록에 \"차단기내려감\", \"두꺼비집안올라감\", \"누전차단기내려감\" 등이 포함되어 있다는 이유만으로 제목이나 본문에 그 표현을 넣지 마세요.\n");
        sb.append("제목의 우선순위: 1) 지역 2) 실제 작업 종류 또는 현장 메모의 핵심 증상 3) 위에서 지정한 서비스 검색어 4) 필요한 경우에만 관련 전기 증상.\n");
        sb.append("한 글에 서비스 검색어를 여러 개 나열하지 말고, 핵심 서비스 검색 의도는 하나만 선택하세요 (아래 [제목 작성 지침]에서 정확히 하나로 지정합니다).\n");
        return sb.toString();
    }
}
