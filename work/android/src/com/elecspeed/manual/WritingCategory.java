package com.elecspeed.manual;

/** Same research/style settings as the reference APK. */
public final class WritingCategory {
 public String id="",name="",searchKeyword="",excludedTopics="",publishPurpose="",preferredTone="";
 public String freshnessLevel="medium",searchChannel="web",primarySearchProvider="naver",fallbackSearchProvider="google";
 public boolean trustBlogAsSource=false;
 public String toString(){return name;}
 public String researchPrompt(){
   String freshness="high".equals(freshnessLevel)?"최근 1~2주":"low".equals(freshnessLevel)?"일반적으로 알려진 정보":"medium".equals(freshnessLevel)?"최근 1~3개월":"가능하면 최신 정보";
   String channel="blog".equals(searchChannel)?"블로그":"news".equals(searchChannel)?"뉴스":"웹 전체(제조사·공공기관·전문 자료 포함)";
   return "[필수 실행 순서 — 절대 생략 금지]\n"
    +"아래 순서를 반드시 지키세요. 이 순서는 제목·분량·카테고리·출력 형식 등 다른 모든 지침보다 먼저 실행합니다.\n"
    +"1. 웹 검색 도구를 사용할 수 있는 경우 반드시 검색한다. 검색 도구가 실제로 제공되지 않는 환경에서만 이 단계를 생략한다.\n"
    +"2. 카테고리: "+name+" / 검색 키워드: "+searchKeyword+" 중심으로, "+freshness+" 이내에 나온 자료를 우선 찾는다.\n"
    +"   (이 키워드 목록은 검색 범위를 정하는 참고 자료일 뿐입니다. 작업 종류·현장 메모에 없는 증상이 이 목록에 있다는 이유만으로 제목이나 본문의 중심 주제로 쓰지 마세요.)\n"
    +"3. "+provider(primarySearchProvider)+" / "+channel+"에서 찾되, 부족하면 "+provider(fallbackSearchProvider)+"도 함께 확인한다. 블로그뿐 아니라 제조사·공공기관·전문가 자료도 함께 확인한다.\n"
    +"4. "+(trustBlogAsSource?"블로그도 참고 근거로 활용하되, 블로그 글의 기술적·안전 관련 주장은 반드시 공식 자료(제조사·공공기관·전문가)와 대조해 확인한다.":"블로그는 문체 참고로만 사용하고, 기술적·안전 관련 사실 근거는 공식 기관·전문 자료로 확인한다.")+"\n"
    +"5. 최근 비슷한 글들의 제목·구성 경향을 확인한다.\n"
    +"6. 아래 \"최근 가져온 제목\" 목록과 비교해 같은 표현·구성을 반복하지 않도록 한다.\n"
    +"7. 위 1~6번을 모두 마친 뒤에만 글을 작성한다.\n"
    +"검색을 실제로 하지 않았다면 검색했다고 표현하지 마세요. 완성된 글 본문 끝에 검색 결과나 출처 목록을 따로 붙이지 마세요 — 참고만 하고 본문에는 자연스럽게 녹여 쓰세요.\n"
    +"제외할 주제: "+excludedTopics+"\n발행 목적: "+publishPurpose+"\n선호하는 톤: "+preferredTone+"\n";
 }
 private static String provider(String p){return "google".equals(p)?"구글":"네이버";}
 public static WritingCategory[] presets(){
   String[][] rows={
    {"preset_1_breaker","1번 차단기·정전","누전 차단기 내려감 두꺼비집 부분정전 전기수리","상가·공장 전기공사, 농업용 전기, 전기요금 절약","차단기가 내려가거나 정전된 집에서 검색해 찾아오게 하고 출장 문의로 이어지게 함","차분하고 친절한 설명체, 불안을 키우지 않고 순서대로 알려주는 말투"},
    {"preset_2_outlet","2번 콘센트·조명·스위치","콘센트 전기 안됨 스위치 교체 조명 깜빡임 전등 안켜짐","상가·공장 전기공사, 인테리어 시공, 가전제품 수리","콘센트·조명 같은 생활 전기 고장으로 검색한 사람에게 점검 방법과 출장 안내","쉬운 생활 설명체, 전문용어는 풀어서 한 번 더 설명"},
    {"preset_3_wiring","3번 배선·분전반·증설공사","전기배선수리 분전반 교체 인덕션 전용선 전기차 충전기 배선 승압","상가·공장 전기공사, 농업용 전기, 셀프 시공 권유","배선·분전반 교체나 전용선 증설이 필요한 집에서 검색해 찾아오게 함","신뢰감 있는 전문가 설명체, 과장 없이 근거 위주"},
    // 4번은 사용자가 직접 지정한 카테고리입니다. 검색 키워드는 사용자가 준 목록 그대로이니 임의로 빼거나 바꾸지 마세요.
    {"preset_4_breaker_down","4번 차단기 내려감","차단기내려감, 두꺼비집안올라감, 누전차단기내려감, 메인차단기내려감, 누전수리, 24시전기수리기사, 두꺼비집교체, 차단기안올라감, 전기쇼트, 두꺼비집화재, 콘센트전기안됨, 콘센트화재, 차단기화재, 분전반화재","상가·공장 전기공사, 농업용 전기, 셀프 시공 권유","차단기가 내려가거나 두꺼비집이 안 올라가는 집에서 검색해 찾아오게 하고 긴급 출장 문의로 이어지게 함","차분하고 친절한 설명체, 불안을 키우지 않고 순서대로 알려주는 말투"}
   };WritingCategory[] out=new WritingCategory[rows.length];for(int i=0;i<rows.length;i++){WritingCategory c=new WritingCategory();String[] r=rows[i];c.id=r[0];c.name=r[1];c.searchKeyword=r[2];c.excludedTopics=r[3];c.publishPurpose=r[4];c.preferredTone=r[5];c.trustBlogAsSource=(i!=2);c.freshnessLevel=(i==2)?"high":"medium";out[i]=c;}return out;
 }
}
