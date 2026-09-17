package com.elecspeed.manual;

import android.app.*;import android.os.*;import android.content.*;import android.graphics.Color;import android.text.InputType;import android.view.*;import android.webkit.*;import android.widget.*;import org.json.*;import java.net.*;import java.io.*;import java.nio.charset.StandardCharsets;import java.util.*;

public class MainActivity extends Activity {
 boolean editorOpen=false; String accountName=""; Button loginButton;
 public void onCreate(Bundle b){super.onCreate(b);showLogin();}

 // ===== 화면 뼈대 =====
 // 색·카드·버튼 모양은 Ui.java에 모아 뒀습니다. 전기블로그 클립보드 앱과 같은 남색+노란색 디자인입니다.
 LinearLayout root;
 void newScreen(){root=Ui.screen(this);form=root;}

 void showLogin(){
  editorOpen=false;newScreen();
  LinearLayout head=Ui.header(this,root,"전기수리 수동등록","24elecspeed.com 사례 발행 도우미");
  Ui.chip(this,head,"로그인 → 글 작성 → 가져오기 → 등록");

  form=Ui.card(this,root,0,"사이트 로그인");
  Ui.hint(this,form,"전기수리 사례를 등록할 계정으로 연결하세요.");
  Ui.fieldLabel(this,form,"사이트 주소");
  EditText address=field("사이트 주소",false);address.setText(SITE);address.setFocusable(false);address.setTextColor(Ui.TEXT_DIM);
  Ui.fieldLabel(this,form,"아이디");
  user=field("워드프레스 사용자명",false);user.setSingleLine(true);user.setText(getSharedPreferences("draft",0).getString("f0","mymanowar"));
  Ui.fieldLabel(this,form,"애플리케이션 비밀번호");
  pass=field("애플리케이션 비밀번호 입력",false);pass.setInputType(129);pass.setSingleLine(true);pass.setSaveEnabled(false);
  CheckBox show=new CheckBox(this);show.setText("비밀번호 표시");show.setTextColor(Ui.TEXT_DIM);show.setTextSize(13);form.addView(show);
  show.setOnCheckedChangeListener((v,checked)->{pass.setInputType(checked?145:129);pass.setSelection(pass.length());});
  Ui.note(this,form,"워드프레스 프로필에서 발급한 애플리케이션 비밀번호를 입력하세요. 비밀번호는 기기에 저장하지 않습니다.");
  loginButton=Ui.primary(this,form,"로그인");
  status=Ui.hint(this,form,"");
  loginButton.setOnClickListener(v->login());
  spacer();
 }

 void spacer(){View v=new View(this);root.addView(v,new LinearLayout.LayoutParams(-1,Ui.dp(this,28)));}

 void login(){if(busy)return;if(value(user).isEmpty()||value(pass).isEmpty()){status.setText("아이디와 애플리케이션 비밀번호를 입력해 주세요.");return;}String username=value(user);String auth="Basic "+android.util.Base64.encodeToString((username+":"+value(pass).replace(" ","")).getBytes(StandardCharsets.UTF_8),android.util.Base64.NO_WRAP);busy=true;loginButton.setEnabled(false);user.setEnabled(false);pass.setEnabled(false);status.setText("사이트 연결과 계정을 확인하고 있습니다…");new Thread(()->{try{JSONObject me=new JSONObject(request("GET","users/me?context=edit",null,auth));if(me.optInt("id",0)<=0)throw new IOException("계정 확인에 실패했습니다.");request("GET","electric_case?context=edit&per_page=1&_fields=id",null,auth);String name=me.optString("name",username);runOnUiThread(()->{busy=false;accountName=name;getSharedPreferences("draft",0).edit().putString("f0",username).apply();showEditor();});}catch(Exception e){runOnUiThread(()->{busy=false;loginButton.setEnabled(true);user.setEnabled(true);pass.setEnabled(true);status.setText("로그인 실패\n"+e.getMessage()+"\n아이디와 애플리케이션 비밀번호, 사이트 연결을 확인해 주세요.");});}}).start();}
 static final String SITE="https://24elecspeed.com", API=SITE+"/wp-json/wp/v2/", PHONE="0507-1417-8239";
 /** 대표이미지(featured_media) 기본값 — 미디어 라이브러리의 24elecspeed_로고_520x520 (wp-admin/upload.php?item=2840). "elecfeatured" 검색어로 찾는 사진 풀이 비어 있을 때만 이 로고로 대체됩니다. */
 static final int FEATURED_IMAGE_ID=2840;
 static final String IMAGE=SITE+"/wp-content/uploads/2026/08/ChatGPT-Image-2026년-8월-19일-오후-12_41_19-3.png";
 static final String STYLE="margin:0 0 32px 0; padding:0; color:#1c2128; line-height:1.9; font-size:clamp(16px,4.2vw,18px); letter-spacing:-0.2px; word-break:keep-all; overflow-wrap:break-word;";
 EditText user,pass,gu,dong,title,body,symptom,cause,service; TextView status; Button preview; LinearLayout form; boolean busy=false; Spinner type;
 EditText notes; Spinner writingCategory; ArrayList<WritingCategory> categories; TextView categorySummary,articleSummary; LinearLayout articleFields; boolean authenticated=false;
 EditText bgKeyword,featuredKeyword;
 Spinner provinceSpinner; TextView regionUsedHint;

 void showEditor(){
  editorOpen=true;authenticated=true;newScreen();
  LinearLayout head=Ui.header(this,root,"전기수리 · ChatGPT 글 작성",accountName+" 님 · 24elecspeed.com");
  Ui.chip(this,head,"카테고리 → 글 작성 → 가져오기 → 등록");
  LinearLayout headerButtons=new LinearLayout(this);headerButtons.setOrientation(LinearLayout.HORIZONTAL);
  LinearLayout.LayoutParams headerButtonsLp=new LinearLayout.LayoutParams(-1,-2);headerButtonsLp.topMargin=Ui.dp(this,8);
  head.addView(headerButtons,headerButtonsLp);
  Button resetArticle=Ui.tonal(this,headerButtons,"글 초기화");
  Button logout=Ui.accent(this,headerButtons,"로그아웃");
  ((LinearLayout.LayoutParams)resetArticle.getLayoutParams()).width=0;((LinearLayout.LayoutParams)resetArticle.getLayoutParams()).weight=1;((LinearLayout.LayoutParams)resetArticle.getLayoutParams()).rightMargin=Ui.dp(this,8);
  ((LinearLayout.LayoutParams)logout.getLayoutParams()).width=0;((LinearLayout.LayoutParams)logout.getLayoutParams()).weight=1;
  resetArticle.setOnClickListener(v->{if(busy){say("등록이 끝난 뒤 초기화해 주세요.");return;}new AlertDialog.Builder(this).setTitle("글 초기화").setMessage("지역·작성 중인 글·현장 메모를 모두 지울까요? 로그인과 카테고리는 유지됩니다.").setNegativeButton("취소",null).setPositiveButton("초기화",(x,y)->clearArticle()).show();});
  logout.setOnClickListener(v->{if(busy){status.setText("등록이 끝난 뒤 로그아웃해 주세요.");return;}save();pass.setText("");authenticated=false;showLogin();});

  // --- 1. 카테고리와 지역 ---
  form=Ui.card(this,root,1,"카테고리와 지역 선택");
  Ui.fieldLabel(this,form,"글 카테고리");
  categories=CategorySettings.load(this);writingCategory=new Spinner(this);form.addView(writingCategory,new LinearLayout.LayoutParams(-1,-2));Ui.styleSpinner(this,writingCategory);
  categorySummary=Ui.hint(this,form,"");
  refreshCategories();
  writingCategory.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener(){public void onNothingSelected(android.widget.AdapterView<?> a){} public void onItemSelected(android.widget.AdapterView<?> a,android.view.View v,int pos,long id){if(pos<categories.size()){WritingCategory c=categories.get(pos);String previous=getSharedPreferences("draft",0).getString("category","");if(type!=null&&!previous.equals(c.id))type.setSelection(WorkType.defaultIndexFor(c.id));categorySummary.setText(c.searchKeyword+"\n"+c.preferredTone);getSharedPreferences("draft",0).edit().putString("category",c.id).apply();}}});
  Button manage=Ui.tonal(this,form,"카테고리 추가 · 수정 · 삭제");manage.setOnClickListener(v->manageCategories());
  Ui.fieldLabel(this,form,"지역");
  gu=field("구 / 시",false);dong=field("동 / 읍 / 면",false);
  LinearLayout regionRow=new LinearLayout(this);regionRow.setOrientation(LinearLayout.HORIZONTAL);
  LinearLayout.LayoutParams regionRowLp=new LinearLayout.LayoutParams(-1,-2);regionRowLp.topMargin=Ui.dp(this,8);
  form.addView(regionRow,regionRowLp);
  provinceSpinner=new Spinner(this);provinceSpinner.setAdapter(new ArrayAdapter<String>(this,android.R.layout.simple_spinner_dropdown_item,RegionData.PROVINCES));
  regionRow.addView(provinceSpinner,new LinearLayout.LayoutParams(0,-2,1f));Ui.styleSpinner(this,provinceSpinner);
  Button randomRegionBtn=Ui.tonal(this,regionRow,"지역 무작위");
  ((LinearLayout.LayoutParams)randomRegionBtn.getLayoutParams()).width=-2;((LinearLayout.LayoutParams)randomRegionBtn.getLayoutParams()).leftMargin=Ui.dp(this,8);
  randomRegionBtn.setOnClickListener(v->{String[] picked=RegionData.randomRegion((String)provinceSpinner.getSelectedItem());gu.setText(picked[0]);dong.setText(picked[1]);});
  regionUsedHint=Ui.hint(this,form,"");
  android.text.TextWatcher regionWatcher=new android.text.TextWatcher(){public void beforeTextChanged(CharSequence s,int a,int b,int c){}public void onTextChanged(CharSequence s,int a,int b,int c){}public void afterTextChanged(android.text.Editable s){checkRegionUsed();}};
  gu.addTextChangedListener(regionWatcher);dong.addTextChangedListener(regionWatcher);
  Ui.fieldLabel(this,form,"작업 종류");
  type=new Spinner(this);type.setAdapter(new ArrayAdapter<String>(this,android.R.layout.simple_spinner_dropdown_item,WorkType.LABELS));form.addView(type,new LinearLayout.LayoutParams(-1,-2));Ui.styleSpinner(this,type);
  Ui.fieldLabel(this,form,"현장 메모 (선택)");
  notes=field("실제 증상이나 작업만 간단히 · 정보성 글이면 비워 두세요",true);notes.setMinLines(2);

  // --- 2. ChatGPT에서 글 작성 ---
  form=Ui.card(this,root,2,"ChatGPT에서 글 작성");
  // 두 버튼 다 같은 노란색입니다. 예전에는 하나만 노란색이라 남색 버튼이 '비활성'처럼 보였습니다.
  Button generate=Ui.accent(this,form,"출장 사례 글 요청문 복사 · ChatGPT 열기");generate.setOnClickListener(v->openWriter(false));
  Button infoWrite=Ui.accent(this,form,"정보성 글 요청문 복사 · ChatGPT 열기");infoWrite.setOnClickListener(v->openWriter(true));
  writeStatus=Ui.hint(this,form,"");
  Ui.note(this,form,"출장이 없던 날에는 [정보성 글]을 쓰세요. 실제 방문 사례를 지어내지 말고 일반적인 원인·점검 안내로만 쓰라고 ChatGPT에 지시합니다.\n정보성 글은 구/시·동과 현장 메모를 비워 둬도 됩니다. 비우면 글에 지역명을 넣지 말라고 지시합니다.");
  Ui.hint(this,form,"ChatGPT에 붙여넣어 전송한 뒤, 완성된 답변 전체를 복사하고 이 앱으로 돌아오세요.");

  // --- 3. 글 가져오기 ---
  form=Ui.card(this,root,3,"ChatGPT 글 가져오기");
  Button importButton=Ui.primary(this,form,"복사한 답변 가져오기");importButton.setOnClickListener(v->pasteArticle());
  articleSummary=Ui.statusChip(this,form,"가져온 글이 없습니다.");
  Button edit=Ui.outlined(this,form,"가져온 글 확인 · 수정");
  LinearLayout parent=form;articleFields=new LinearLayout(this);articleFields.setOrientation(1);parent.addView(articleFields,new LinearLayout.LayoutParams(-1,-2));form=articleFields;
  Ui.fieldLabel(this,form,"제목");title=field("가져온 제목",false);
  Ui.fieldLabel(this,form,"본문");body=field("가져온 본문",true);
  Ui.fieldLabel(this,form,"증상");symptom=field("증상 요약 (자동 입력)",false);
  Ui.fieldLabel(this,form,"원인");cause=field("원인 요약 (자동 입력)",false);
  Ui.fieldLabel(this,form,"작업 내용");service=field("작업 내용 요약 (자동 입력)",false);
  form=parent;
  articleFields.setVisibility(android.view.View.GONE);
  edit.setOnClickListener(v->articleFields.setVisibility(articleFields.getVisibility()==android.view.View.GONE?android.view.View.VISIBLE:android.view.View.GONE));

  // --- 4. 미리보기 → 등록 ---
  form=Ui.card(this,root,4,"파이썬 서식 미리보기 → 등록");
  Ui.fieldLabel(this,form,"배너 배경사진 — 미디어 라이브러리 검색어 (선택)");
  bgKeyword=field("예: elecbg",false);bgKeyword.setSingleLine(true);bgKeyword.setText(getSharedPreferences("draft",0).getString("bgKeyword","elecbg"));
  Ui.note(this,form,"미디어 라이브러리에 저품질 작업 사진을 미리 여러 장 올려 두고, 파일명/제목에 이 글자를 공통으로 넣어 두세요. 미리보기를 열 때마다 이 글자로 검색되는 사진 중 하나를 무작위로 골라 본문 배너 배경사진으로 씁니다.");
  Ui.fieldLabel(this,form,"대표이미지 — 미디어 라이브러리 검색어 (선택)");
  featuredKeyword=field("예: elecfeatured",false);featuredKeyword.setSingleLine(true);featuredKeyword.setText(getSharedPreferences("draft",0).getString("featuredKeyword","elecfeatured"));
  Ui.note(this,form,"글자가 합성된 대표이미지 사진들을 미리 올려 두고, 이 글자로 찾게 하세요. 등록할 때마다 그중 하나를 무작위로 골라 워드프레스 대표이미지(featured image)로 지정합니다. 못 찾으면 24elecspeed_로고_520x520(미디어 ID 2840)으로 대체됩니다.");
  preview=Ui.accent(this,form,"미리보기 열기");preview.setOnClickListener(v->showPreview());
  status=Ui.hint(this,form,"");
  spacer();
  restore();notes.setText(getSharedPreferences("draft",0).getString("notes",""));updateArticleSummary();
 }
 void refreshCategories(){if(writingCategory==null)return;String selected=getSharedPreferences("draft",0).getString("category","");writingCategory.setAdapter(new ArrayAdapter<WritingCategory>(this,android.R.layout.simple_spinner_dropdown_item,categories));int index=0;for(int i=0;i<categories.size();i++)if(categories.get(i).id.equals(selected))index=i;if(!categories.isEmpty()){writingCategory.setSelection(index);categorySummary.setText(categories.get(index).searchKeyword+"\n"+categories.get(index).preferredTone);}else categorySummary.setText("카테고리를 추가해 주세요.");}
 void manageCategories(){if(busy)return;String[] actions={"새 카테고리 추가","선택한 카테고리 수정","선택한 카테고리 삭제","기본 카테고리 복원"};new AlertDialog.Builder(this).setTitle("카테고리 관리").setItems(actions,(d,which)->{WritingCategory c=categories.isEmpty()?null:categories.get(writingCategory.getSelectedItemPosition());if(which==0)CategorySettings.edit(this,null,categories,()->refreshCategories());else if(which==1){if(c!=null)CategorySettings.edit(this,c,categories,()->refreshCategories());}else if(which==2&&c!=null)new AlertDialog.Builder(this).setMessage(c.name+" 카테고리를 삭제할까요?").setNegativeButton("취소",null).setPositiveButton("삭제",(x,y)->{categories.remove(c);CategorySettings.persist(this,categories);refreshCategories();}).show();else if(which==3){for(WritingCategory preset:WritingCategory.presets()){boolean exists=false;for(WritingCategory row:categories)if(row.id.equals(preset.id))exists=true;if(!exists)categories.add(preset);}CategorySettings.persist(this,categories);refreshCategories();}}).show();}
 void updateArticleSummary(){articleSummary.setText(value(title).isEmpty()?"가져온 글이 없습니다.":"제목: "+value(title)+"\n본문 "+value(body).length()+"자 · 파이썬 배너와 관련 태그 자동 적용");}
 /** 로그인 정보와 카테고리 선택은 남기고, 지역·현장 메모·가져온 글 내용만 지웁니다. */
 void clearArticle(){gu.setText("");dong.setText("");notes.setText("");title.setText("");body.setText("");symptom.setText("");cause.setText("");service.setText("");articleFields.setVisibility(android.view.View.GONE);updateArticleSummary();android.content.SharedPreferences.Editor p=getSharedPreferences("draft",0).edit();for(String k:new String[]{"f1","f2","f3","f4","f5","f6","f7","notes"})p.remove(k);p.apply();say("글 내용을 초기화했습니다.");}

 /** 이미 발행한 구/동인지 확인해 알려줍니다. 막지는 않고 알려만 줍니다 — 발행은 upload() 성공 시 markRegionUsed()로 기록됩니다. */
 void checkRegionUsed(){if(regionUsedHint==null)return;String g=value(gu),d=value(dong);if(g.isEmpty()||d.isEmpty()){regionUsedHint.setText("");return;}if(isRegionUsed(g,d)){regionUsedHint.setText("⚠ 이미 발행한 지역입니다: "+g+" "+d);regionUsedHint.setTextColor(Color.parseColor("#D9534F"));}else{regionUsedHint.setText("아직 안 쓴 지역입니다.");regionUsedHint.setTextColor(Ui.TEXT_DIM);}}
 boolean isRegionUsed(String g,String d){String history=getSharedPreferences("draft",0).getString("usedRegions","");String key=g.trim()+"|"+d.trim();for(String line:history.split("\n"))if(line.equals(key))return true;return false;}
 void markRegionUsed(String g,String d){if(g==null||g.trim().isEmpty()||d==null||d.trim().isEmpty())return;if(isRegionUsed(g,d))return;String history=getSharedPreferences("draft",0).getString("usedRegions","");String updated=history.isEmpty()?(g.trim()+"|"+d.trim()):history+"\n"+g.trim()+"|"+d.trim();getSharedPreferences("draft",0).edit().putString("usedRegions",updated).apply();}

 /**
  * 안내 메시지. status는 화면 맨 아래 4번 카드에 있어서 2번 카드에서 버튼을 누르면
  * 글자가 안 보입니다("버튼이 안 눌린다"로 보임). 그래서 항상 토스트로도 같이 띄웁니다.
  */
 void say(String message){if(status!=null)status.setText(message);if(writeStatus!=null)writeStatus.setText(message);Toast.makeText(this,message,Toast.LENGTH_LONG).show();}
 TextView writeStatus;

 /**
  * info=true면 출동이 없을 때 쓰는 정보성 글 요청문을 만듭니다.
  * 정보성 글은 실제 방문 글이 아니라서 구/동을 안 넣어도 됩니다(사용자 요청).
  * 출장 사례 글만 지역을 요구합니다.
  */
 void openWriter(boolean info){if(busy){say("잠시만요, 진행 중인 작업이 끝난 뒤에 눌러 주세요.");return;}if(!info&&(value(gu).isEmpty()||value(dong).isEmpty())){say("출장 사례 글에는 1번 카드의 구/시와 동이 필요합니다. (정보성 글은 안 넣어도 됩니다)");return;}if(categories.isEmpty()){say("카테고리를 추가해 주세요.");return;}save();getSharedPreferences("draft",0).edit().putBoolean("lastInfo",info).apply();WritingCategory c=categories.get(writingCategory.getSelectedItemPosition());android.content.SharedPreferences prefs=getSharedPreferences("draft",0);String work=WorkType.labelAt(type.getSelectedItemPosition());int variation=prefs.getInt("variation",0);TitleEngine.Selection titleSel=info?null:TitleEngine.plan(this,work);String prompt=(info?ArticleCodec.infoPrompt(value(gu),value(dong),work,prefs.getString("history",""),variation):ArticleCodec.prompt(value(gu),value(dong),work,value(notes),prefs.getString("history",""),variation,titleSel)).replace(ArticleCodec.RESEARCH_MARKER,c.researchPrompt());if(titleSel!=null)TitleEngine.remember(this,titleSel);prefs.edit().putString("lastPrompt",prompt).putInt("variation",variation+1).apply();((android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("ChatGPT 글 작성 요청문",prompt));say((info?"정보성 글 ":"출장 사례 글 ")+"요청문을 복사했습니다. ChatGPT에 붙여넣어 전송하고 답변을 복사한 뒤 '가져오기'를 누르세요.");
  // ChatGPT 앱을 못 여는 경우가 ActivityNotFoundException 말고도 있어서(보안 정책 등)
  // Exception 전체를 받습니다. 요청문 복사는 이미 끝났으니 여기서 실패해도 손해는 없습니다.
  try{Intent launch=getPackageManager().getLaunchIntentForPackage("com.openai.chatgpt");if(launch==null)launch=new Intent(Intent.ACTION_VIEW,android.net.Uri.parse("https://chatgpt.com/"));startActivity(launch);}catch(Exception e){new AlertDialog.Builder(this).setMessage("요청문은 복사됐습니다. ChatGPT 앱이나 브라우저를 직접 열어 붙여넣어 주세요.").setPositiveButton("확인",null).show();}}

 void pasteArticle(){if(busy)return;android.content.ClipboardManager clipboard=(android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);ClipData clip=clipboard.getPrimaryClip();if(clip==null||clip.getItemCount()==0){status.setText("ChatGPT가 작성한 답변 전체를 먼저 복사해 주세요.");return;}CharSequence text=clip.getItemAt(0).getText();if(text==null){status.setText("텍스트 답변을 복사해 주세요. 사진이나 링크 공유가 아닌 답변 복사를 사용하세요.");return;}try{ArticleCodec.Article a=ArticleCodec.parse(text.toString());Runnable apply=()->{title.setText(a.title);body.setText(a.body);symptom.setText(a.symptom.isEmpty()?WorkType.labelAt(type.getSelectedItemPosition()):a.symptom);cause.setText(a.cause.isEmpty()?"미확인 — 현장 점검 필요":a.cause);service.setText(a.service.isEmpty()?"미확인 — 현장 점검 필요":a.service);String history=getSharedPreferences("draft",0).getString("history","");ArrayList<String> items=new ArrayList<>(Arrays.asList(history.split("\n")));items.remove(a.title);items.add(0,a.title);StringBuilder recent=new StringBuilder();for(String item:items){if(item.trim().isEmpty())continue;if(recent.toString().split("\n").length>=8)break;recent.append(item).append('\n');}getSharedPreferences("draft",0).edit().putString("history",recent.toString()).apply();save();updateArticleSummary();status.setText("글을 가져왔습니다. 제목·본문·요약을 자동 입력했습니다. 아래 미리보기에서 확인해 주세요.");};if(!value(body).isEmpty()||a.fallback)new AlertDialog.Builder(this).setTitle("가져온 글 확인").setMessage("제목: "+a.title+"\n본문 "+a.body.length()+"자\n"+(a.fallback?"표식이 없어 첫 줄을 제목으로 인식했습니다.\n":"")+(!value(body).isEmpty()?"현재 작성 중인 글을 이 답변으로 바꿀까요?":"이 글을 가져올까요?")).setNegativeButton("취소",null).setPositiveButton("가져오기",(x,y)->apply.run()).show();else apply.run();}catch(Exception e){status.setText(e.getMessage());}}

 TextView label(String t,int size){TextView v=new TextView(this);v.setText(t);v.setTextSize(size);v.setTextColor(size>=20?Ui.TEXT:Ui.TEXT_DIM);v.setPadding(0,12,0,12);form.addView(v);return v;}
 EditText field(String hint,boolean multi){EditText e=new EditText(this);e.setHint(hint);e.setInputType(InputType.TYPE_CLASS_TEXT|(multi?InputType.TYPE_TEXT_FLAG_MULTI_LINE:0));if(multi){e.setMinLines(9);e.setGravity(Gravity.TOP);}form.addView(e,new LinearLayout.LayoutParams(-1,-2));Ui.styleField(this,e);return e;}
 String value(EditText e){return e.getText().toString().trim();} EditText[] saved(){return new EditText[]{user,gu,dong,title,body,symptom,cause,service};}
 void restore(){android.content.SharedPreferences p=getSharedPreferences("draft",0);EditText[] a=saved();for(int i=0;i<a.length;i++)if(p.contains("f"+i))a[i].setText(p.getString("f"+i,""));int t=p.getInt("type",0);type.setSelection(t<WorkType.LABELS.length?t:0);}
 void save(){if(!editorOpen)return;android.content.SharedPreferences.Editor p=getSharedPreferences("draft",0).edit();EditText[] a=saved();for(int i=0;i<a.length;i++)p.putString("f"+i,value(a[i]));p.putInt("type",type.getSelectedItemPosition());if(notes!=null)p.putString("notes",value(notes));if(bgKeyword!=null)p.putString("bgKeyword",value(bgKeyword));if(featuredKeyword!=null)p.putString("featuredKeyword",value(featuredKeyword));p.apply();}protected void onPause(){save();super.onPause();}
 /** 미디어 라이브러리에서 keyword로 검색되는 사진 중 하나를 무작위로 골라 원본 URL을 반환합니다(본문 배너 배경사진용). 없거나 실패하면 null(호출한 쪽에서 기본 배경으로 대체). */
 String pickRandomBackgroundUrl(String keyword,String auth){if(keyword==null||keyword.trim().isEmpty())return null;try{JSONArray media=new JSONArray(request("GET","media?search="+URLEncoder.encode(keyword.trim(),"UTF-8")+"&per_page=100&_fields=source_url",null,auth));if(media.length()==0)return null;String url=media.getJSONObject(new Random().nextInt(media.length())).optString("source_url","");return url.isEmpty()?null:url;}catch(Exception e){return null;}}
 /** 미디어 라이브러리에서 keyword로 검색되는 사진 중 하나를 무작위로 골라 미디어ID를 반환합니다(대표이미지용). 없거나 실패하면 0 — 호출한 쪽에서 FEATURED_IMAGE_ID(로고)로 대체합니다. */
 int pickRandomMediaId(String keyword,String auth){if(keyword==null||keyword.trim().isEmpty())return 0;try{JSONArray media=new JSONArray(request("GET","media?search="+URLEncoder.encode(keyword.trim(),"UTF-8")+"&per_page=100&_fields=id",null,auth));if(media.length()==0)return 0;return media.getJSONObject(new Random().nextInt(media.length())).optInt("id",0);}catch(Exception e){return 0;}}
 static String esc(String s){return s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;").replace("'","&#x27;");}
 /** 지역을 안 넣은 정보성 글이면 배너의 지역 줄은 빈 칸이 됩니다(빈 div라 높이 0이라 자리를 안 차지함). */
 String template(String name,String g,String d,String bgUrl)throws Exception{ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream in=getAssets().open(name+".html")){byte[] a=new byte[4096];int n;while((n=in.read(a))!=-1)out.write(a,0,n);}String region=(g+" "+d).trim();return out.toString("UTF-8").replace("{PHONE_NUMBER}",PHONE).replace("{location_text}",esc(region)).replace("{safe_image_url}",bgUrl).replace("{image_url}",bgUrl);}
 /** bgUrl이 비어 있으면(검색어 미지정·검색 실패) 원래 쓰던 고정 배경으로 대체합니다. */
 String content(String g,String d,String text,String bgUrl)throws Exception{String bg=(bgUrl==null||bgUrl.isEmpty())?IMAGE:bgUrl;ArrayList<String> blocks=new ArrayList<>();for(String p:text.split("\\n\\s*\\n")){p=p.trim();if(p.isEmpty())continue;if(p.startsWith("### "))blocks.add("<h3>"+esc(p.substring(4))+"</h3>");else if(p.startsWith("## "))blocks.add("<h2>"+esc(p.substring(3))+"</h2>");else if(p.startsWith("- ")){StringBuilder list=new StringBuilder("<ul>");for(String line:p.split("\\n"))list.append("<li>").append(esc(line.replaceFirst("^-\\s*",""))).append("</li>");blocks.add(list+"</ul>");}else{String[] sentences=p.replaceAll("\\s+"," ").split("(?<=[.!?。！？])\\s+");for(int i=0;i<sentences.length;i+=2)blocks.add("<p style=\""+STYLE+"\">"+esc(sentences[i]+(i+1<sentences.length?" "+sentences[i+1]:""))+"</p>");}}
 StringBuilder result=new StringBuilder(template("top",g,d,bg));for(int i=0;i<blocks.size();i++){result.append(blocks.get(i));if(i==Math.max(0,blocks.size()/2-1))result.append(template("mid",g,d,bg));}result.append("<h2 style=\"font-size:18px;font-weight:900;color:#1c2128;margin:38px 0 14px;\">관련 태그</h2><div style=\"display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;\">");String[] tags={"전기수리","누전수리","차단기수리","콘센트수리","분전반수리","두꺼비집수리","누전차단기교체","전기설비공사","전기증설","24시간전기수리","긴급전기출동","전기누전점검","차단기내려감","메인차단기내려감","두꺼비집안올라감","두꺼비집내려감","차단기고장교체","차단기트립","콘센트스파크","콘센트타는냄새","분전반탄냄새","분전반그을림","누전차단기오작동","콘센트과열"};// 지역을 안 넣은 정보성 글이면 앞쪽 지역 태그 6개는 건너뜁니다.
 // 안 그러면 일반 태그와 똑같은 태그가 6개 중복으로 붙습니다.
 String place=(g+d).replace(" ","");boolean hasPlace=!place.isEmpty();
 for(int i=hasPlace?0:6;i<30;i++){boolean region=i<6;String t=region?place+tags[i]:tags[i-6];result.append("<span style=\"background:"+(region?"#e8f3ff;color:#0a5fb4":"#eef1f5;color:#333")+";font-size:13px;padding:7px 14px;border-radius:20px;\">#"+esc(t)+"</span>");}return result+"</div>"+template("bottom",g,d,bg);}
 // 지역은 정보성 글이면 비어 있을 수 있으므로 여기서는 제목·본문만 확인합니다.
 /** 배경사진 검색어가 있으면 미리보기를 열기 전에 미디어 라이브러리에서 무작위로 하나 골라옵니다(네트워크 필요). */
 void showPreview(){if(busy)return;if(value(title).isEmpty()||value(body).isEmpty()){say("제목과 본문을 먼저 가져와 주세요.");return;}save();String g=value(gu),d=value(dong),t=value(title),raw=value(body);JSONObject acf;try{acf=new JSONObject().put("district",g).put("dong",d).put("symptom",value(symptom)).put("cause",value(cause)).put("service",value(service));}catch(Exception e){status.setText("미리보기 오류: "+e.getMessage());return;}String tax=WorkType.slugAt(type.getSelectedItemPosition());String bgKw=value(bgKeyword);boolean hasAuth=!value(user).isEmpty()&&!value(pass).isEmpty();String auth=hasAuth?("Basic "+android.util.Base64.encodeToString((value(user)+":"+value(pass).replace(" ","")).getBytes(StandardCharsets.UTF_8),android.util.Base64.NO_WRAP)):null;busy=true;preview.setEnabled(false);status.setText("배경사진을 고르는 중…");new Thread(()->{String bgUrl=(hasAuth&&!bgKw.isEmpty())?pickRandomBackgroundUrl(bgKw,auth):null;runOnUiThread(()->{busy=false;preview.setEnabled(true);try{String html=content(g,d,raw,bgUrl);WebView w=new WebView(this);w.getSettings().setJavaScriptEnabled(false);w.getSettings().setAllowFileAccess(false);w.setWebViewClient(new WebViewClient(){public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return true;}});w.loadDataWithBaseURL(SITE,"<meta name='viewport' content='width=device-width, initial-scale=1'><main style='padding:12px'><h1>"+esc(t)+"</h1>"+html+"</main>","text/html","UTF-8",null);new AlertDialog.Builder(this).setTitle("게시글 미리보기").setView(w).setNegativeButton("돌아가기",(a,b)->w.destroy()).setNeutralButton("임시저장",(a,b)->{w.destroy();upload(g,d,t,raw,html,acf,tax,"draft");}).setPositiveButton("공개 등록",(a,b)->{w.destroy();new AlertDialog.Builder(this).setMessage("이 글을 24elecspeed.com에 공개 등록할까요?").setNegativeButton("취소",null).setPositiveButton("공개 등록",(x,y)->upload(g,d,t,raw,html,acf,tax,"publish")).show();}).show();}catch(Exception e){status.setText("미리보기 오류: "+e.getMessage());}});}).start();}
 String request(String method,String path,JSONObject payload,String auth)throws Exception{HttpURLConnection c=(HttpURLConnection)new URL(API+path).openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(20000);c.setReadTimeout(45000);c.setRequestMethod(method);c.setRequestProperty("Authorization",auth);try{if(payload!=null){c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json; charset=UTF-8");try(OutputStream out=c.getOutputStream()){out.write(payload.toString().getBytes(StandardCharsets.UTF_8));}}int code=c.getResponseCode();InputStream stream=code>=200&&code<300?c.getInputStream():c.getErrorStream();ByteArrayOutputStream out=new ByteArrayOutputStream();if(stream!=null)try(InputStream in=stream){byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1)out.write(b,0,n);}String response=out.toString("UTF-8");if(code<200||code>=300){String message="요청 실패";try{message=new JSONObject(response).optString("message",message);}catch(Exception ignored){}throw new IOException("HTTP "+code+": "+message);}return response;}finally{c.disconnect();}}
 void upload(String g,String d,String t,String raw,String html,JSONObject acf,String tax,String state){if(busy)return;if(value(user).isEmpty()||value(pass).isEmpty()){status.setText("사용자명과 애플리케이션 비밀번호를 입력한 뒤 다시 등록해 주세요.");return;}String auth="Basic "+android.util.Base64.encodeToString((value(user)+":"+value(pass).replace(" ","")).getBytes(StandardCharsets.UTF_8),android.util.Base64.NO_WRAP);final String featuredKw=value(featuredKeyword);busy=true;preview.setEnabled(false);status.setText("등록 중…");new Thread(()->{try{String slug=t.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}\\s-]","").trim().replaceAll("[\\s-]+","-");if(slug.isEmpty())slug="case-"+System.currentTimeMillis();JSONArray duplicate=new JSONArray(request("GET","electric_case?slug="+URLEncoder.encode(slug,"UTF-8")+"&context=edit&status=publish,draft,pending,future,private",null,auth));if(duplicate.length()>0)throw new IOException("같은 제목의 글이 이미 있습니다. 중복 등록을 막았습니다. 제목을 확인해 주세요.");JSONArray terms=new JSONArray(request("GET","case_type?slug="+URLEncoder.encode(tax,"UTF-8"),null,auth));if(terms.length()==0)throw new IOException("사이트에서 작업 유형을 찾지 못했습니다: "+tax);int featuredId=pickRandomMediaId(featuredKw,auth);if(featuredId<=0)featuredId=FEATURED_IMAGE_ID;String excerpt=raw.replaceAll("\\s+"," ");if(excerpt.length()>160)excerpt=excerpt.substring(0,160);JSONObject meta=new JSONObject().put("_yoast_wpseo_title",t.substring(0,Math.min(70,t.length()))).put("_yoast_wpseo_metadesc",excerpt).put("_yoast_wpseo_focuskw",((g+" "+d).trim()+" 전기수리").trim());JSONObject payload=new JSONObject().put("title",t).put("slug",slug).put("content",html).put("excerpt",excerpt).put("status",state).put("acf",acf).put("case_type",new JSONArray().put(terms.getJSONObject(0).getInt("id"))).put("meta",meta).put("featured_media",featuredId);JSONObject result=new JSONObject(request("POST","electric_case",payload,auth));String link=result.optString("link");runOnUiThread(()->{markRegionUsed(g,d);checkRegionUsed();status.setText((state.equals("draft")?"임시저장":"공개 등록")+" 완료\n"+link);new AlertDialog.Builder(this).setTitle("등록 완료").setMessage(link).setPositiveButton("확인",null).show();});}catch(Exception e){runOnUiThread(()->status.setText("등록 확인 필요: "+e.getMessage()+"\n연결이 끊긴 경우 워드프레스 글 목록에서 등록 여부를 먼저 확인해 주세요."));}finally{runOnUiThread(()->{busy=false;preview.setEnabled(true);});}}).start();}
}
