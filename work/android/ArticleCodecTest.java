import com.elecspeed.manual.*;
public class ArticleCodecTest {
 static int checks;
 static void check(boolean result,String label){checks++;if(!result)throw new AssertionError(label);}
 static void rejects(String value){try{ArticleCodec.parse(value);throw new AssertionError("Expected rejection");}catch(IllegalArgumentException expected){checks++;}}
 public static void main(String[] args){
 String sample="[제목]\n강남구 역삼동 누전 점검\n[증상]\n차단기 내려감\n[원인]\n미확인\n[작업내용]\n현장 점검 필요\n[구간1]\n왜 차단기가 내려갈까요\n\n첫 번째 문단입니다. 원인은 확인이 필요합니다.\n\n[Q&A]\nQ. 반복되면 어떻게 하나요?\nA. 점검이 필요합니다.\n\n[구간2]\n확인할 사항\n\n두 번째 구간의 본문입니다. 상태를 확인합니다.\n[구간3]\n마무리 안내\n\n세 번째 구간의 본문입니다. 전문가에게 문의합니다.\n[태그]\n#전기수리";
 ArticleCodec.Article a=ArticleCodec.parse(sample);check(a.title.equals("강남구 역삼동 누전 점검"),"title");check(a.body.contains("## 왜 차단기가 내려갈까요\n\n"),"section heading");check(a.body.indexOf("Q. 반복")<a.body.indexOf("## 확인"),"Q&A position");check(!a.body.contains("[구간")&&!a.body.contains("#전기수리"),"markers and duplicate tags excluded");check(a.symptom.equals("차단기 내려감")&&a.cause.equals("미확인"),"metadata");
 check(ArticleCodec.parse(sample.replace("\n","\r\n")).body.equals(a.body),"CRLF");check(ArticleCodec.parse(sample.replace("\n","\r")).body.equals(a.body),"CR");check(ArticleCodec.parse("```text\n"+sample+"\n```").body.equals(a.body),"code fence");check(ArticleCodec.parse(sample.replace("[제목]","**[제목]**").replace("[구간1]","### [구간1]")).title.equals(a.title),"markdown markers");
 ArticleCodec.Article plain=ArticleCodec.parse("# 제목 예시\n\n충분한 길이의 본문입니다. 이 문장은 가져오기에서 본문으로 유지되어야 합니다.");check(plain.fallback&&plain.title.equals("제목 예시"),"plain reply fallback");
 rejects("");rejects("https://chatgpt.com/share/something");rejects("[제목]\n제목만 있는 응답");rejects(sample+"\n[제목]\n다른 글");
 String prompt=ArticleCodec.prompt("강남구","역삼동","콘센트","실제 접속부 점검","기존 제목",2);rejects(prompt);check(prompt.contains("기존 제목")&&prompt.contains("실제 접속부 점검"),"prompt context");
 WritingCategory[] cats=WritingCategory.presets();check(cats.length==3&&cats[2].freshnessLevel.equals("high"),"reference presets");WritingCategory c=cats[0];c.primarySearchProvider="google";c.fallbackSearchProvider="naver";c.preferredTone="CUSTOM_TONE";String block=c.researchPrompt();check(block.contains("구글 / 웹 전체")&&block.contains("부족하면 네이버")&&block.contains("CUSTOM_TONE"),"category routing and tone");
 System.out.println("PASS: "+checks+" checks");
 }
}
