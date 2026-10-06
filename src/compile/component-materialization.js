'use strict';

// Versioned authoring-to-wire mapping, not a component interpreter or Core parser.
const {own,fail,hash,clone,freeze,local} = require('../creation-engine/component-input');
const {canonicalStringify} = require('../evidence/component-json');
const RULE = 'kdna.studio-materialization/2';
const D = 'sha256:37e857cc4e43f7283a51ee6abe1f6e8401803902e8dc47f6d14d712aa7d7b089';
const utf8 = (a,b) => Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'));
function semantic(v) {
  if (v === null) return {kind:'null',value:null};
  if (typeof v === 'string') return {kind:'text',value:v};
  if (typeof v === 'number') return {kind:'number',value:v};
  if (typeof v === 'boolean') return {kind:'boolean',value:v};
  if (Array.isArray(v)) return {kind:'list',items:v.map(semantic)};
  return {kind:'record',fields:Object.keys(v).sort().map(name => ({name,value:semantic(v[name])}))};
}
function descriptorCheck(d) {
  if (d.contract_id !== 'kdna.component-semantics/2' || d.contract_version !== '2.0.0' || d.definition_digest !== D) fail('CREATION_COMPONENT_CONTRACT_MISMATCH');
}
function buildMaterialization(input, descriptor, decision) {
  descriptorCheck(descriptor);
  const s = clone(input), contextDigest = hash(s), ids = new Map();
  if(typeof s.corePackageVersion!=='string' || !s.corePackageVersion)fail('CREATION_CORE_VERSION_UNBOUND');
  const mint = (kind, ...keys) => {
    keys.forEach(local); const domain = [RULE,kind,s.asset.asset_id,...keys];
    const id = kind + ':' + hash(domain).slice(7);
    if (ids.has(id)) fail('CREATION_GENERATED_ID_COLLISION');
    ids.set(id,domain); return id;
  };
  const extension = (kind,value) => {
    const carrier = descriptor.carriers[kind];
    return {id:carrier.id,critical:carrier.critical,definition:carrier.definition,value:semantic(value)};
  };
  const judgments=[], reasons=[], sources=[], sourceUses=[], materials=[], declarations=[], presence=[], forms=new Set();
  const expectedComponents=[]; const groupKeys = new Set();
  for (const selected of s.selected) {
    const key=selected.judgmentLocalKey,a=selected.alternative;
    if (groupKeys.has(key)) fail('CREATION_JUDGMENT_KEY_DUPLICATE'); groupKeys.add(key);
    const jid=mint('judgment',key),rid=mint('reason',key),rcid=mint('result-contract',key);
    // R2-required judgment face. form/answer_kind/core_expression (and the empty
    // ports/inputs/content_uses) are derived defaults for this path; explicit studio
    // model values must flow here once they exist (W-2 follow-up item). method is
    // always present; the declared branch below overwrites the empty default.
    const judgment={id:jid,focus:a.title,form:'conclusion',answer_kind:'preference',core_expression:{kind:'authored',statement:a.statement,qualification_refs:[]},parent_ref:null,subject:{actor_ids:[],statement:a.subject},scope:{statement:a.scope},result_contract:{id:rcid,form:{term:'text'},shape:{kind:'scalar',scalar_type:'text'},minimum:1,maximum:1,allowed_result_types:[{term:'text'}]},result:{contract_ref:rcid,result_type:{term:'text'},value:{kind:'text',value:a.statement}},method:{},material_refs:[],reason_refs:[rid],ports:[],inputs:[],content_uses:[]};
    if(own(a,'formationRule')){delete judgment.result;judgment.form='rule';judgment.formation_rule={statement:a.statement,condition_refs:[],output_contract_ref:rcid};}
    reasons.push({id:rid,role:'support',judgment_ref:jid,statement:a.rationale,component_refs:[]});
    const componentIds=new Map();
    for (const c of a.method?.components || []) componentIds.set(c.localKey,mint('component',key,c.localKey));
    if (own(a,'method')) {
      // The method is mandatory and complete at authoring (component method ==
      // judgment term, roles covering the kind's required family); the native
      // shape mirrors it. Bindings stay empty on this path: R2 bindings are
      // typed edges to exceptions/conditions, not links back to the judgment.
      const state={judgment_ref:jid,components_state:'declared'};
      judgment.method={method:clone(a.method.method),components:[],bindings:[]};
      for (const c of a.method.components || []) {
        const cid=componentIds.get(c.localKey), content=clone(c.content);
        if(c.type==='discriminator-set') {
          const target=(a.method.components || []).find(t=>t.localKey===content.candidateSetLocalKey && t.type==='candidate-set');
          if(!target) fail('CREATION_COMPONENT_TARGET_UNKNOWN');
          content.candidateSetRef=componentIds.get(target.localKey);delete content.candidateSetLocalKey;
        }
        // CS2 carries authored statements only; the mechanical representation
        // form is retired with the /2 generation.
        const origin='authored';
        const native={id:cid,method:{term:c.method.term},role:c.role,statement:c.statement,material_refs:[]};
        judgment.method.components.push(native);
        const bindings=[];
        const profile=descriptor.profiles.find(p=>p.component_type===c.type);if(!profile)fail('CREATION_COMPONENT_TYPE_UNSUPPORTED');
        const proposal={rule:RULE,context_digest:contextDigest,asset:clone(s.asset),judgmentLocalKey:key,alternativeLocalKey:a.localKey,componentLocalKey:c.localKey,profile:clone(profile),definition_digest:D,authored_candidate_digest:hash(a),content,native_component:native,statement_origin:origin,bindings,presence:state};
        const carrier={contract_id:descriptor.contract_id,contract_version:descriptor.contract_version,definition_digest:D,judgment_ref:jid,component_ref:cid,component_type:c.type,profile_id:profile.profile_id,content,content_digest:hash(content),component_declaration_digest:hash({component:native,statement_origin:origin}),statement_origin:origin,bindings_digest:hash(bindings),adoption_proposal_digest:hash(proposal)};
        (judgment.extensions ||= []).push(extension('component',carrier));declarations.push(carrier);
        expectedComponents.push({proposal,carrier,native_component:native,bindings,presence:state});
      }
    }
    const sourceIds=new Map();
    for(const src of a.publicSources || []) {
      const id=mint('source',key,src.localKey);sourceIds.set(src.localKey,id);
      sources.push({id,identity:src.identity,...(own(src,'version')?{version:src.version}:{}),...(own(src,'digest')?{digest:src.digest}:{})});
      for(const u of src.uses) {
        const component=own(u,'componentLocalKey'),target=component?componentIds.get(u.componentLocalKey):jid;
        if(!target)fail('CREATION_SOURCE_TARGET_UNKNOWN');
        sourceUses.push({id:mint('source-use',key,src.localKey,u.localKey),role:u.role,source_ref:id,target_kind:component?'method_component':'judgment',target_ref:target});
      }
    }
    if(own(a,'publicNotices')) {
      judgment.material_refs=[];
      for(const notice of a.publicNotices) {
        const refs=notice.sourceLocalKeys.map(k=>sourceIds.get(k));if(refs.some(x=>!x))fail('CREATION_NOTICE_SOURCE_UNKNOWN');
        const id=mint('material',key,notice.localKey);judgment.material_refs.push(id);
        materials.push({id,kind:'attachment',statement:notice.statement,source_refs:refs});
      }
    }
    judgments.push(judgment);
    forms.add(judgment.form);
  }
  declarations.sort((a,b)=>utf8(a.judgment_ref,b.judgment_ref)||utf8(a.component_ref,b.component_ref));
  const proposalDigests=[...new Set(declarations.map(x=>x.adoption_proposal_digest))].sort(utf8);
  const payload={profile:'kdna.payload.judgment',profile_version:'0.5.1',asset:{asset_id:s.asset.asset_id,asset_version:s.asset.version,judgment_version:s.asset.version},actors:[],scope:{statement:s.brief.scope},judgments,reasons,asset_capability:forms.has('rule')?(forms.has('conclusion')?'mixed':'result_forming_rules'):'asserted_answers',declarations:{highest_question:{state:'provided',value:s.brief.highest_question},boundaries:{state:'none',value:null}},kernel:{purpose:{kind:'summary'},foundation_refs:[]},shared_declarations:[],resources:[],relationships:[],dependencies:[],contracts:[],conditions:[],exceptions:[],misuse:[],examples:[],sources,source_uses:sourceUses,materials};
  let adoption=null;
  if(declarations.length) {
    if(!decision || !['human_claim_unverified','delegated_agent_editorial'].includes(decision.adoption_kind)) fail('CREATION_DECISION_REQUIRED');
    adoption={contract_id:descriptor.contract_id,contract_version:descriptor.contract_version,definition_digest:D,declaration_set_digest:hash(declarations),proposal_set_digest:hash(proposalDigests),decision_digest:hash(decision),adoption_kind:decision.adoption_kind};
    payload.extensions=[extension('adoption',adoption)];
  }
  // summary/languages are product-face defaults for this path (W-2 follow-up item:
  // explicit values must flow once the studio model carries them).
  const manifest={format_version:'0.5.0',asset_id:s.asset.asset_id,asset_uid:s.asset.asset_uid,asset_type:s.synthetic_fixture?'fixture':'domain',title:s.brief.title,summary:s.brief.scope,languages:['en'],version:s.asset.version,judgment_version:s.asset.version,created_at:s.createdAt,updated_at:s.createdAt,history:{coverage:'complete',statement:'Initial creation; no prior revisions.',entries:[]},compatibility:{min_loader_version:s.corePackageVersion,profile:'kdna.payload.judgment',profile_version:'0.5.1'},payload:{path:'payload.kdnab',encoding:'cbor',encrypted:false},runtime:{mandatory_entries:[]}};
  return freeze({rule:RULE,context_digest:contextDigest,manifest,payload,expectedComponents,presence,adoption,proposalDigests,decision:clone(decision),generated_ids:[...ids.keys()]});
}
module.exports={buildMaterialization,descriptorCheck,RULE,D};
