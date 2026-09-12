export type JSONValue = null | boolean | number | string | readonly JSONValue[] | {readonly [key:string]: JSONValue};
export type LocalKey = string;
export type TermRef = import('@aikdna/kdna-core').TermRef;
export type ComponentItem = import('@aikdna/kdna-core').ComponentItem;
export type BroaderEdge = import('@aikdna/kdna-core').ComponentBroaderEdge;
export type Discriminator = import('@aikdna/kdna-core').ComponentDiscriminator;
export type ComponentDraft = {readonly localKey:LocalKey;readonly statement?:string} & (
 {readonly type:'taxonomy';readonly content:{readonly items:readonly ComponentItem[];readonly broader:readonly BroaderEdge[]}} |
 {readonly type:'candidate-set';readonly content:{readonly items:readonly ComponentItem[]}} |
 {readonly type:'discriminator-set';readonly content:{readonly candidateSetLocalKey:LocalKey;readonly items:readonly Discriminator[]}});
export interface MethodDraft {readonly method:TermRef;readonly components?:readonly ComponentDraft[];readonly bindings?:readonly {readonly componentLocalKey:LocalKey;readonly role:string}[]}
export interface PublicSourceDraft {readonly localKey:LocalKey;readonly identity:string;readonly version?:string;readonly digest?:string;readonly uses:readonly {readonly localKey:LocalKey;readonly role:import('@aikdna/kdna-core').SourceUseRole;readonly componentLocalKey?:LocalKey}[]}
export interface PublicNoticeDraft {readonly localKey:LocalKey;readonly statement:string;readonly sourceLocalKeys:readonly LocalKey[]}
export interface AlternativeDraft {readonly localKey:LocalKey;readonly title:string;readonly subject:string;readonly scope:string;readonly statement:string;readonly rationale:string;readonly materialRefs:readonly string[];readonly method?:MethodDraft;readonly formationRule?:{readonly conditions:readonly {readonly kind:'interpreted';readonly statement:string}[]};readonly publicSources?:readonly PublicSourceDraft[];readonly publicNotices?:readonly PublicNoticeDraft[]}
export interface JudgmentDraft {readonly localKey:LocalKey;readonly alternatives:readonly AlternativeDraft[]}
export interface MaterialInput {readonly kind:'text'|'interview';readonly title:string;readonly content:string;readonly coordinate:string}
export interface MaterialRecord extends MaterialInput {readonly id:string;readonly content_digest:string;readonly recorded_at:string}
export interface AdoptionResponse {readonly id:string;readonly role:'agent'|'human';readonly channel:string;readonly review_id:string;readonly text:string}
export type AdoptionIntent = {readonly kind:'select';readonly choices:readonly {readonly judgmentLocalKey:LocalKey;readonly alternativeLocalKey:LocalKey}[]} | {readonly kind:'confirm'|'reject'|'note'};
export type AdoptionKind = 'human_claim_unverified'|'delegated_agent_editorial';
export interface AdoptionReview {readonly review_id:string;readonly session_id:string;readonly revision:number;readonly kind:AdoptionKind;readonly channel:string;readonly groups:readonly (JudgmentDraft & {readonly revision:number})[];readonly preview:JSONValue|null}
export type AdoptionInput = {readonly channel:string;readonly receive:(review:AdoptionReview)=>Promise<AdoptionResponse>|AdoptionResponse} & ({readonly kind:'human_claim_unverified'}|{readonly kind:'delegated_agent_editorial';readonly authorization:{readonly coordinate:string;readonly statement:string}});
export interface CreateSessionOptions {readonly agent:{readonly name:string;readonly version:string};readonly adoptionInput:AdoptionInput;readonly interpretReply:(text:string,review:AdoptionReview)=>Promise<AdoptionIntent>|AdoptionIntent;readonly syntheticFixture?:boolean}
export interface EvidenceBinding {readonly session_id:string;readonly asset_digest:string;readonly evidence_digest:string}
export interface ExportedAsset {readonly bytes:Uint8Array;readonly evidence:JSONValue;readonly binding:EvidenceBinding;readonly verification:{readonly status:'pending_saved_readback';readonly creation_accepted:'not_evaluated'}}
export interface LiveSaveVerification {readonly status:'accepted_with_live_context';readonly scope:string;readonly asset_digest:string;readonly evidence_digest:string;readonly adoption_kind:AdoptionKind;readonly identity:'not_verified';readonly action_authorization:'not_evaluated';readonly filesystem_durability:'not_proven_by_library'}
export interface CreationSession {readonly agent:{setBrief(input:{readonly title:string;readonly scope:string}):JSONValue;recordMaterial(input:MaterialInput):MaterialRecord;propose(input:JudgmentDraft):JudgmentDraft & {readonly revision:number};revise(localKey:LocalKey,input:{readonly baseRevision:number;readonly alternatives:readonly AlternativeDraft[];readonly explanation:string}):JudgmentDraft & {readonly revision:number};compilePreview():JSONValue};receiveAdoptionReply():Promise<JSONValue>;exportAsset():ExportedAsset;completeSave(actualReadbackBytes:Uint8Array):LiveSaveVerification;inspect():JSONValue;abort():JSONValue}
export declare function createSession(options:CreateSessionOptions):CreationSession;
export declare function verifyCreationEvidence(bytes:Uint8Array,evidence:unknown,expectedBinding:EvidenceBinding):{readonly status:'consistent'|'inconsistent';readonly reason?:string;readonly creation_accepted:'not_evaluated';readonly live_context:'unavailable';readonly identity:'not_verified';readonly action_authorization:'not_evaluated'};
