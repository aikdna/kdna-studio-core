"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const binding=require('./component-runtime-binding.json');
const {fail,hash,freeze,clone}=require('./component-input');
function getBoundRuntime(){
 const coreRoot=path.dirname(require.resolve('@aikdna/kdna-core/package.json'));
 const modules=path.dirname(path.dirname(coreRoot));
 for(const pkg of binding.packages){
  const root=path.join(modules,...pkg.name.split('/'));
  if(fs.realpathSync(root)!==root)fail('CREATION_DEPENDENCY_SYMLINK');
  const observed=[];
  function walk(dir,rel=''){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const name=rel?rel+'/'+e.name:e.name,p=path.join(dir,e.name);if(e.isDirectory())walk(p,name);else if(e.isFile())observed.push(name);else fail('CREATION_DEPENDENCY_MEMBER_KIND');}}
  walk(root);if(hash(observed.sort())!==hash(pkg.files.map(f=>f.path).sort()))fail('CREATION_DEPENDENCY_MEMBER_SET');
  for(const f of pkg.files){const bytes=fs.readFileSync(path.join(root,f.path));if(bytes.length!==f.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==f.sha256)fail('CREATION_DEPENDENCY_MEMBER_CHANGED');}
  const metadata=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if(metadata.version!==pkg.version||metadata.name!==pkg.name)fail('CREATION_DEPENDENCY_VERSION_CHANGED');
  for(const optional of Object.keys(metadata.optionalDependencies||{})){
   if(binding.packages.some(p=>p.name===optional))continue;
   // Package managers install optional dependencies by default, so their
   // presence is the normal case for a consumer that simply ran
   // `npm install`. Every CBOR operation in this package and in the bound Core
   // uses the pure-JS entry, so the bytes and the behaviour are the same either
   // way and an installed accelerator must not turn a working install into a
   // refusal. The resolution check is kept only to surface an unreadable
   // optional entry instead of hiding a broken install.
   try{require.resolve(optional,{paths:[root]});}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
  }
  for(const consumer of binding.packages){const resolved=require.resolve(pkg.name,{paths:[path.join(modules,...consumer.name.split('/'))]});if(!fs.realpathSync(resolved).startsWith(root+path.sep))fail('CREATION_DEPENDENCY_MULTIPLE_GRAPHS');}
 }
 const core=require('@aikdna/kdna-core'),components=require('@aikdna/kdna-core/components');
 if(hash(Object.keys(core).sort())!==hash(['admitBytes'])||hash(Object.keys(components).sort())!==hash(['getComponentSemanticsContract','getNativeMethodRequirements']))fail('CREATION_PUBLIC_API_MISMATCH');
 const authoringNode=require('@aikdna/kdna-core/authoring-node'),protectionNode=require('@aikdna/kdna-core/protection-node');
 if(!Object.hasOwn(authoringNode,'openSourceBytes')||!Object.hasOwn(protectionNode,'protectSourceBytes'))fail('CREATION_PUBLIC_API_MISMATCH');
 const descriptor=components.getComponentSemanticsContract();if(descriptor.definition_digest!==binding.definition_digest)fail('CREATION_COMPONENT_CONTRACT_MISMATCH');
 // Authoring vocabulary comes from the bound Core itself (r2_semantics in the
 // shipped generated contract; integrity is covered by the member walk above).
 // The judgment-side kinds include `composite`; component basic methods and the
 // role families are the sixteen base kinds defined by method_roles.
 const semanticsRaw=JSON.parse(fs.readFileSync(path.join(coreRoot,'src','public-contract','generated-contract.json'),'utf8')).r2_semantics;
 const baseKinds=Array.isArray(semanticsRaw&&semanticsRaw.method_kinds)?semanticsRaw.method_kinds.filter(k=>k!=='composite'):null;
 const methodRoles=semanticsRaw&&semanticsRaw.method_roles;
 if(!baseKinds||baseKinds.length!==16||!methodRoles||Object.keys(methodRoles).length!==16||baseKinds.some(k=>!methodRoles[k]))fail('CREATION_SEMANTICS_INVALID');
 return Object.freeze({admitBytes:core.admitBytes,descriptor,tuple:freeze(clone(binding.tuple)),coreVersion:binding.core_package_version,semantics:Object.freeze({baseKinds:Object.freeze(baseKinds),methodRoles:Object.freeze(methodRoles)})});
}
module.exports={getBoundRuntime};
