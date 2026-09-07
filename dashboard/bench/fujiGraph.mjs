import ts from 'typescript';import fs from 'node:fs';
const out={};for(const file of ['src/lib/AgentDetail.svelte','src/App.svelte','src/lib/ResponseTimeline.svelte']){
 const full=fs.readFileSync(file,'utf8'),match=full.match(/<script[^>]*>([\s\S]*?)<\/script>/),script=match[1],offset=full.slice(0,match.index+match[0].indexOf(script)).split('\n').length-1;
 const sf=ts.createSourceFile(file+'.ts',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),nodes=[];
 function refs(n){const set=new Set();function walk(x){if(ts.isTypeNode(x))return;if(ts.isIdentifier(x)&&!(ts.isPropertyAccessExpression(x.parent)&&x.parent.name===x))set.add(x.text);ts.forEachChild(x,walk)}walk(n);return [...set]}
 for(const n of sf.statements){const line=sf.getLineAndCharacterOfPosition(n.getStart()).line+1+offset;
 if(ts.isVariableStatement(n))for(const d of n.declarationList.declarations){if(!ts.isIdentifier(d.name)||!d.initializer)continue;nodes.push({name:d.name.text,line,kind:d.initializer.getText(sf).startsWith('$derived')?'derived':'binding',deps:refs(d.initializer)})}
 if(ts.isFunctionDeclaration(n)&&n.name)nodes.push({name:n.name.text,line,kind:'function',deps:refs(n.body)});
 if(ts.isExpressionStatement(n)&&n.expression.getText(sf).startsWith('$effect'))nodes.push({name:'effect@'+line,line,kind:'effect',deps:refs(n.expression)});
 }
 const functions=new Map(nodes.filter(n=>n.kind==='function').map(n=>[n.name,n]));function expand(deps,seen=new Set()){for(const x of deps){if(seen.has(x))continue;seen.add(x);if(functions.has(x))expand(functions.get(x).deps,seen)}return seen}
 const roots={};for(const root of ['instruction','logs','agents','envelope','now']){const affected=new Set([root]);let changed=true;while(changed){changed=false;for(const n of nodes.filter(n=>n.kind==='derived'||n.kind==='effect'))if(!affected.has(n.name)&&[...expand(n.deps)].some(d=>affected.has(d))){affected.add(n.name);changed=true}}
 roots[root]=nodes.filter(n=>affected.has(n.name)&&n.name!==root).map(n=>({name:n.name,kind:n.kind,line:n.line}));}
 out[file]={note:'Lexical candidate graph; untrack, async continuations, short-circuit branches and function parameters need manual validation.',counts:{derived:nodes.filter(n=>n.kind==='derived').length,effect:nodes.filter(n=>n.kind==='effect').length},roots,nodes};
}fs.writeFileSync('/tmp/fuji304-measure/reactive-graph.json',JSON.stringify(out,null,2));console.log(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k,v])=>[k,{counts:v.counts,roots:v.roots}]))));
