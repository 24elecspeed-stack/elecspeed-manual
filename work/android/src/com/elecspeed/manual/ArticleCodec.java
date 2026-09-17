package com.elecspeed.manual;

import java.util.*;
import java.util.regex.*;

/** ChatGPT clipboard format. No Android or network dependencies. */
public final class ArticleCodec {
    public static final String PROMPT_ID = "전기수리 워드프레스 글 작성 요청";
    /** MainActivity가 c.researchPrompt()로 치환하는 자리표시자. 프롬프트 맨 앞, 다른 모든 지침보다 먼저 오도록 둡니다. */
    public static final String RESEARCH_MARKER = "[사전 조사 자리표시자]";
    public static final class Article {
        public String title="", body="", symptom="", cause="", service="";
        public boolean fallback;
    }
    private static String cleanLine(String value) {
        return value.trim().replaceFirst("^#{1,6}\\s+", "").replaceFirst("^\\*\\*(.*?)\\*\\*$", "$1").trim();
    }
    private static String key(String line) {
        String clean=cleanLine(line);
        return clean.matches("\\[(제목|구간\\s*\\d+|본문|Q&A|QA|태그|해시태그|증상|원인|작업내용|작업 내용|서비스)\\]")
            ? clean.substring(1,clean.length()-1).replace(" ","") : null;
    }
    public static Article parse(String raw) {
        if(raw==null || raw.trim().isEmpty()) throw new IllegalArgumentException("복사된 글이 없습니다. ChatGPT 답변을 먼저 복사해 주세요.");
        String text=raw.replace("\r\n","\n").replace('\r','\n').replace("\uFEFF","").trim();
        if(text.length()>150000) throw new IllegalArgumentException("글이 너무 깁니다. 답변 한 편만 복사해 주세요.");
        if(text.contains(PROMPT_ID) || text.contains("[출력 형식]")) throw new IllegalArgumentException("답변 대신 요청문을 복사했습니다. ChatGPT가 작성한 답변을 복사해 주세요.");
        if(text.startsWith("```"))text=text.replaceFirst("^```[^\\n]*\\n","").replaceFirst("\\n```\\s*$","").trim();
        Article a=new Article();
        List<String[]> chunks=new ArrayList<>();String current=null;StringBuilder value=new StringBuilder();
        for(String line:text.split("\n",-1)) {
            String next=key(line);
            if(next!=null){if(current!=null)chunks.add(new String[]{current,value.toString().trim()});current=next;value.setLength(0);}
            else if(current!=null)value.append(line).append('\n');
        }
        if(current!=null)chunks.add(new String[]{current,value.toString().trim()});
        StringBuilder body=new StringBuilder();
        for(String[] chunk:chunks){String k=chunk[0],v=chunk[1];
            if(k.equals("제목")){if(!a.title.isEmpty())throw new IllegalArgumentException("여러 글이 함께 복사되었습니다. 한 편만 가져오세요.");a.title=cleanLine(v);}
            else if(k.equals("증상"))a.symptom=v;
            else if(k.equals("원인"))a.cause=v;
            else if(k.equals("작업내용")||k.equals("서비스"))a.service=v;
            else if(k.matches("구간\\d+")){
                if(v.isEmpty())throw new IllegalArgumentException(k+" 내용이 비어 있습니다. 완성된 답변 전체를 복사해 주세요.");
                int end=v.indexOf('\n');
                if(end>0){body.append("## ").append(cleanLine(v.substring(0,end))).append("\n\n").append(v.substring(end+1).trim()).append("\n\n");}
                else body.append(v).append("\n\n");
            } else if(k.equals("본문"))body.append(v).append("\n\n");
            else if(k.equals("Q&A")||k.equals("QA"))body.append("## 자주 묻는 질문\n\n").append(v).append("\n\n");
            // Region tags come from the Python template; do not duplicate pasted hashtags.
        }
        a.body=body.toString().trim();
        if(chunks.isEmpty()){
            int split=text.indexOf('\n');
            if(split<0)throw new IllegalArgumentException("제목과 본문이 포함된 답변 전체를 복사해 주세요.");
            a.title=cleanLine(text.substring(0,split)).replaceFirst("^제목\\s*[:：]\\s*", "");
            a.body=text.substring(split+1).trim();a.fallback=true;
        }
        if(a.title.isEmpty()||a.title.contains("\n")||a.title.length()>200||a.body.length()<30)
            throw new IllegalArgumentException("제목 또는 본문을 확인할 수 없습니다. [제목]과 [구간1] 등이 포함된 답변 전체를 복사해 주세요.");
        return a;
    }
    /** 지역을 안 넣었으면 ChatGPT가 지역명을 지어내지 않도록 못을 박습니다. */
    static String regionLine(String district,String dong) {
        String region=(district.trim()+" "+dong.trim()).trim();
        return region.isEmpty()
            ? "지역: 지정 안 함 — 글에 특정 지역명(서울, 경기, 무슨 구, 무슨 동 등)을 절대 넣지 마세요.\n"
            : "지역: "+region+"\n";
    }

    /**
     * 정보성 글 요청문 — 출동(작업)이 없을 때 씁니다.
     * 출력 형식과 표식은 사례 글과 똑같이 두어 '글 가져오기' 파싱이 그대로 동작합니다.
     * 다른 점은 작성 기준뿐입니다: 방문 사례를 만들어내지 말고 정보 안내로만 쓰게 합니다.
     * 지역(구/동)은 선택입니다 — 비워 두면 지역 없는 정보 글로 씁니다.
     */
    public static String infoPrompt(String district,String dong,String topic,String history,int variation) {
        String[] starts={"독자가 궁금해하는 점을 질문으로 시작", "이 증상이 왜 생기는지 원리부터 설명하며 시작", "미리 알아두면 좋은 점을 짚으며 시작"};
        boolean hasRegion=!(district.trim()+dong.trim()).isEmpty();
        return PROMPT_ID+"\n\n"+RESEARCH_MARKER
            +"\n24elecspeed.com에 올릴 전기 정보 안내 글 한 편을 작성해 주세요. 실제 출장 사례가 아니라 정보성 글입니다.\n"
            +regionLine(district,dong)+"주제: "+topic+"\n"
            +"\n[작성 기준]\n- 주택·아파트·빌라 중심, 자연스러운 한국어, 본문 약 1,600자 이상.\n"
            +"- "+starts[Math.floorMod(variation,starts.length)]+". 제목과 도입 문장을 반복하지 마세요.\n"
            +"- **이번 글은 실제 방문 사례가 아닙니다.** 특정 집을 방문했다거나 무엇을 교체했다는 식으로 쓰지 마세요.\n"
            +"  '저희가 점검해 보니', '이번 현장에서는' 같은 표현을 쓰지 말고, 일반적인 원인과 점검 순서를 설명하세요.\n"
            +"- 가격, 측정값, 시공 결과, 자격 사항을 지어내지 마세요. 원인은 가능성으로 표현하세요.\n"
            +"- 비전문가가 활선이나 배선을 직접 만지도록 안내하지 마세요. 집에서 확인할 수 있는 선까지만 안내하고, 그 다음은 전문가 점검으로 넘기세요.\n"
            +(hasRegion
                ?"- 제목은 지역과 주제가 자연스럽게 드러나게 쓰세요. 지역은 제공된 구/시와 동을 사용하세요.\n"
                :"- 제목은 주제가 드러나게 쓰세요. **지역명은 제목에도 본문에도 넣지 마세요.**\n")
            +"- 각 구간은 짧은 소제목 한 줄 다음에 빈 줄을 두고 본문을 작성하세요. 2~3문장마다 빈 줄로 나누세요.\n"
            +"- Q&A 두 개를 작성하세요. 질문과 답변은 각각 Q. / A.로 시작하세요.\n"
            +"- 앱이 파이썬의 배너·전화 연결·관련 태그·HTML 서식을 붙입니다. HTML, 이미지, 배너, 전화번호, 해시태그를 만들지 마세요.\n"
            +"- [증상]은 주제를 한 줄로 요약하세요. [원인]과 [작업내용]에는 '정보 안내 글 — 실제 방문 사례 아님'이라고만 쓰세요.\n"
            +(history.trim().isEmpty()?"":"\n최근 가져온 제목(제목과 표현을 반복하지 마세요):\n"+history+"\n")
            +"\n[출력 형식]\n설명이나 코드블록 없이 아래 표식과 완성 내용만 출력하세요. 표식을 빠뜨리지 마세요.\n"
            +"[제목]\n완성 제목 한 줄\n\n[증상]\n주제 한 줄 요약\n\n[원인]\n정보 안내 글 — 실제 방문 사례 아님\n\n[작업내용]\n정보 안내 글 — 실제 방문 사례 아님\n\n"
            +"[구간1]\n소제목\n\n완성 본문\n\n[구간2]\n소제목\n\n완성 본문\n\n[구간3]\n소제목\n\n완성 본문\n\n[Q&A]\nQ. 질문\nA. 답변\n\nQ. 질문\nA. 답변";
    }
    public static String prompt(String district,String dong,String work,String notes,String history,int variation) {
        return prompt(district,dong,work,notes,history,variation,null);
    }
    /** sel: TitleEngine.plan()으로 미리 뽑아둔 이번 글의 서비스 키워드/문법/전개/문체 조합. null이면 그 부분은 생략합니다. */
    public static String prompt(String district,String dong,String work,String notes,String history,int variation,TitleEngine.Selection sel) {
        String[] starts={"독자가 겪는 증상을 질문으로 시작", "반복되는 증상과 원인 구분을 중심으로 시작", "점검이 필요한 상황을 설명하며 시작"};
        String place=(district+" "+dong).trim();
        String topicPriority=TitleEngine.topicPriorityBlock(work);
        String titleGuidance=sel==null?"":TitleEngine.titleGuidanceBlock(sel,place,work);
        String bodyExpr=TitleEngine.bodyExpressionGuidance(work);
        String bodyFlow=sel==null?"":TitleEngine.bodyFlowGuidance(sel.flow);
        String persona=sel==null?"":TitleEngine.personaGuidanceBlock(sel.persona);
        return PROMPT_ID+"\n\n"+RESEARCH_MARKER
            +"\n24elecspeed.com의 전기수리 사례 게시판에 올릴 완성 글 한 편을 작성해 주세요.\n"
            +"지역: "+district+" "+dong+"\n작업 종류: "+work+"\n현장 메모: "+(notes.trim().isEmpty()?"제공 없음. 실제 방문 사례를 꾸며내지 말고 일반적인 점검 안내로 작성.":notes.trim())
            +"\n"+topicPriority
            +titleGuidance
            +(history.trim().isEmpty()?"":"\n최근 가져온 제목(제목과 표현을 반복하지 마세요):\n"+history+"\n")
            +"\n[작성 기준]\n- 주택·아파트·빌라 중심, 자연스러운 한국어, 본문 약 1,600자 이상.\n"
            +"- "+starts[Math.floorMod(variation,starts.length)]+". 제목과 도입 문장을 반복하지 마세요.\n"
            +"- 제공된 메모 이외의 실제 경험, 가격, 측정값, 자격, 시공 결과를 지어내지 마세요. 가능한 원인은 가능성으로 표현하세요.\n"
            +"- 비전문가가 활선이나 배선을 직접 만지도록 안내하지 마세요.\n"
            +"- 지역은 제공된 구/시와 동을 사용하세요. 제목 구성은 위 [제목 작성 지침]을 따르세요.\n"
            +"- 각 구간은 짧은 소제목 한 줄 다음에 빈 줄을 두고 본문을 작성하세요. 2~3문장마다 빈 줄로 나누세요.\n"
            +"- Q&A 두 개를 작성하세요. 질문과 답변은 각각 Q. / A.로 시작하세요.\n"
            +"- 앱이 파이썬의 배너·전화 연결·관련 태그·HTML 서식을 붙입니다. HTML, 이미지, 배너, 전화번호, 해시태그를 만들지 마세요.\n"
            +"- [증상]은 주제를 한 줄로 요약, [원인]과 [작업내용]은 확인된 메모만 요약하세요. 미확인 내용은 '미확인 — 현장 점검 필요'로 쓰세요.\n"
            +bodyExpr+bodyFlow+persona
            +"\n[출력 형식]\n설명이나 코드블록 없이 아래 표식과 완성 내용만 출력하세요. 표식을 빠뜨리지 마세요.\n"
            +"[제목]\n완성 제목 한 줄\n\n[증상]\n증상 요약\n\n[원인]\n확인된 원인 또는 미확인 표시\n\n[작업내용]\n확인된 작업 또는 미확인 표시\n\n"
            +"[구간1]\n소제목\n\n완성 본문\n\n[구간2]\n소제목\n\n완성 본문\n\n[구간3]\n소제목\n\n완성 본문\n\n[Q&A]\nQ. 질문\nA. 답변\n\nQ. 질문\nA. 답변";
    }
}
