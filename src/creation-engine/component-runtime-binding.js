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
   try{require.resolve(optional,{paths:[root]});fail('CREATION_OPTIONAL_DEPENDENCY_UNBOUND');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
  }
  for(const consumer of binding.packages){const resolved=require.resolve(pkg.name,{paths:[path.join(modules,...consumer.name.split('/'))]});if(!fs.realpathSync(resolved).startsWith(root+path.sep))fail('CREATION_DEPENDENCY_MULTIPLE_GRAPHS');}
 }
 const core=require('@aikdna/kdna-core'),components=require('@aikdna/kdna-core/components');
 if(hash(Object.keys(core).sort())!==hash(['admitBytes'])||hash(Object.keys(components).sort())!==hash(['getComponentSemanticsContract']))fail('CREATION_PUBLIC_API_MISMATCH');
 const descriptor=components.getComponentSemanticsContract();if(descriptor.definition_digest!==binding.definition_digest)fail('CREATION_COMPONENT_CONTRACT_MISMATCH');
 return Object.freeze({admitBytes:core.admitBytes,descriptor,tuple:freeze(clone(binding.tuple)),coreVersion:binding.core_package_version});
}
module.exports={getBoundRuntime};
