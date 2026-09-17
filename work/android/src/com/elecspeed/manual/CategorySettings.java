package com.elecspeed.manual;
import android.app.*;import android.content.*;import android.widget.*;import org.json.*;import java.util.*;

public final class CategorySettings {
 static final String[] KEYS={"id","name","searchKeyword","excludedTopics","publishPurpose","preferredTone","freshnessLevel","searchChannel","primarySearchProvider","fallbackSearchProvider"};
 static ArrayList<WritingCategory> load(Context context){
  ArrayList<WritingCategory> list=new ArrayList<>();String raw=context.getSharedPreferences("writer_categories",0).getString("list",null);
  if(raw==null){Collections.addAll(list,WritingCategory.presets());return list;}
  try{JSONArray a=new JSONArray(raw);for(int i=0;i<a.length();i++){JSONObject o=a.getJSONObject(i);WritingCategory c=new WritingCategory();for(String k:KEYS)WritingCategory.class.getField(k).set(c,o.optString(k,(String)WritingCategory.class.getField(k).get(c)));c.trustBlogAsSource=o.optBoolean("trustBlogAsSource",false);list.add(c);}}
  catch(Exception e){Collections.addAll(list,WritingCategory.presets());}return list;
 }
 static void persist(Context context,List<WritingCategory> list){try{JSONArray a=new JSONArray();for(WritingCategory c:list){JSONObject o=new JSONObject();for(String k:KEYS)o.put(k,WritingCategory.class.getField(k).get(c));o.put("trustBlogAsSource",c.trustBlogAsSource);a.put(o);}context.getSharedPreferences("writer_categories",0).edit().putString("list",a.toString()).apply();}catch(Exception e){throw new IllegalStateException(e);}}
 static void edit(Activity activity,WritingCategory existing,ArrayList<WritingCategory> list,Runnable refresh){
  WritingCategory old=existing==null?new WritingCategory():existing;ScrollView scroll=new ScrollView(activity);LinearLayout box=new LinearLayout(activity);box.setOrientation(1);box.setPadding(24,8,24,8);scroll.addView(box);
  String[] labels={"카테고리 이름","검색 키워드","제외할 주제","발행 목적","선호하는 톤"};String[] vals={old.name,old.searchKeyword,old.excludedTopics,old.publishPurpose,old.preferredTone};EditText[] fields=new EditText[5];
  for(int i=0;i<5;i++){TextView l=new TextView(activity);l.setText(labels[i]);box.addView(l);EditText e=new EditText(activity);e.setText(vals[i]);box.addView(e);fields[i]=e;}
  String[][] codes={{"auto","low","medium","high"},{"web","blog","news"},{"naver","google"},{"naver","google"}};
  String[][] options={{"자동","일반 정보","최근 1~3개월","최근 1~2주"},{"웹 전체","블로그","뉴스"},{"네이버","구글"},{"네이버","구글"}};
  String[] selected={old.freshnessLevel,old.searchChannel,old.primarySearchProvider,old.fallbackSearchProvider};String[] titles={"검색 최신성","검색 범위","우선 검색","보조 검색"};Spinner[] spins=new Spinner[4];
  for(int i=0;i<4;i++){TextView label=new TextView(activity);label.setText(titles[i]);box.addView(label);Spinner s=new Spinner(activity);s.setAdapter(new ArrayAdapter<String>(activity,android.R.layout.simple_spinner_dropdown_item,options[i]));s.setSelection(Math.max(0,Arrays.asList(codes[i]).indexOf(selected[i])));box.addView(s);spins[i]=s;}
  CheckBox trust=new CheckBox(activity);trust.setText("블로그를 참고 근거로 활용");trust.setChecked(old.trustBlogAsSource);box.addView(trust);
  AlertDialog dialog=new AlertDialog.Builder(activity).setTitle(existing==null?"카테고리 추가":"카테고리 수정").setView(scroll).setNegativeButton("취소",null).setPositiveButton("저장",null).create();
  dialog.setOnShowListener(v->dialog.getButton(-1).setOnClickListener(button->{String name=fields[0].getText().toString().trim();if(name.isEmpty()){fields[0].setError("이름을 입력해 주세요.");return;}WritingCategory c=new WritingCategory();c.id=existing==null?UUID.randomUUID().toString():old.id;c.name=name;c.searchKeyword=fields[1].getText().toString().trim();c.excludedTopics=fields[2].getText().toString().trim();c.publishPurpose=fields[3].getText().toString().trim();c.preferredTone=fields[4].getText().toString().trim();c.freshnessLevel=codes[0][spins[0].getSelectedItemPosition()];c.searchChannel=codes[1][spins[1].getSelectedItemPosition()];c.primarySearchProvider=codes[2][spins[2].getSelectedItemPosition()];c.fallbackSearchProvider=codes[3][spins[3].getSelectedItemPosition()];c.trustBlogAsSource=trust.isChecked();if(existing==null)list.add(c);else list.set(list.indexOf(existing),c);persist(activity,list);activity.getSharedPreferences("draft",0).edit().putString("category",c.id).apply();refresh.run();dialog.dismiss();}));dialog.show();
 }
}
