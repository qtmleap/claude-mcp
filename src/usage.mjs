// Bounded usage reporting. `usage` is per invocation; `modelUsage` and total_cost_usd are
// conversation-cumulative. Cost is client-estimated. Only allowlisted finite >= 0 numbers pass.
const MAX_MODELS=16;
const MODEL_KEY=/^[A-Za-z][A-Za-z0-9._\[\]-]{0,63}$/;
const INVOCATION={input_tokens:'inputTokens',output_tokens:'outputTokens',cache_read_input_tokens:'cacheReadInputTokens',cache_creation_input_tokens:'cacheCreationInputTokens'};
const MODEL_FIELDS=['inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','costUSD','thinkingTokens'];
const num=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:undefined;
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:undefined;
const get=(o,k)=>{try{return o?.[k]}catch{return undefined}};
const put=(o,k,v)=>{if(v!==undefined)o[k]=v};
const looksSecret=k=>/^(sk-|ghp_|xox|eyJ)/i.test(k)||/[A-Za-z0-9+\/_-]{32,}/.test(k);

export function normalizeUsage(result,previousCost){
 const invocation={};
 try{
  const u=obj(get(result,'usage'));
  if(u){
   for(const [from,to] of Object.entries(INVOCATION))put(invocation,to,num(get(u,from)));
   const c=obj(get(u,'cache_creation'));
   put(invocation,'cacheCreation5mInputTokens',num(get(c,'ephemeral_5m_input_tokens')));
   put(invocation,'cacheCreation1hInputTokens',num(get(c,'ephemeral_1h_input_tokens')));
   put(invocation,'thinkingTokens',num(get(obj(get(u,'output_tokens_details')),'thinking_tokens')));
  }
 }catch{}
 const conversationModelUsage={};
 try{
  const mu=obj(get(result,'modelUsage'));
  if(mu)for(const k of Object.keys(mu)){
   if(Object.keys(conversationModelUsage).length>=MAX_MODELS)break;
   if(!MODEL_KEY.test(k)||looksSecret(k))continue;
   const m=obj(get(mu,k));if(!m)continue;
   const e={};for(const f of MODEL_FIELDS)put(e,f,num(get(m,f)));
   conversationModelUsage[k]=e;
  }
 }catch{}
 const conversationCostUSD=num(get(result,'total_cost_usd'))??null;
 const base=num(previousCost);
 const invocationCostDeltaUSD=conversationCostUSD!==null&&base!==undefined&&base<=conversationCostUSD?conversationCostUSD-base:null;
 return {invocation,conversationModelUsage,conversationCostUSD,invocationCostDeltaUSD};
}
