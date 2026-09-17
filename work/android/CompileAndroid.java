import javax.tools.*;
import java.io.*;
import java.util.*;

/** Keep the file manager alive until process exit: JDK 25 zipfs close fails in this sandbox. */
public final class CompileAndroid {
 public static void main(String[] args) throws Exception {
  JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();
  StandardJavaFileManager manager=compiler.getStandardFileManager(null,null,java.nio.charset.StandardCharsets.UTF_8);
  List<File> sources=new ArrayList<>();for(int i=2;i<args.length;i++)sources.add(new File(args[i]));
  boolean ok=compiler.getTask(null,manager,null,Arrays.asList("-encoding","UTF-8","-source","8","-target","8","-classpath",args[0],"-d",args[1]),null,manager.getJavaFileObjectsFromFiles(sources)).call();
  if(!ok)System.exit(1);
  System.out.println("Android Java compilation completed successfully.");
 }
}
