import { RunnerError, childEnvironment } from './runner.mjs';
async function boundedJson(response, max) {
  const chunks=[];let bytes=0;
  for await (const chunk of response.body) {
    bytes+=chunk.length;if(bytes>max) throw new Error('oversized');chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function listModels(config, signal) {
  let reason='models_api_not_configured';
  if (config.env.ANTHROPIC_BASE_URL) {
    try {
      const base=new URL(config.env.ANTHROPIC_BASE_URL);
      if (!['https:','http:'].includes(base.protocol)||base.username||base.password||base.search||base.hash) throw new Error();
      const trimmed=base.toString().replace(/\/$/,'');
      const url=new URL(trimmed+(base.pathname.replace(/\/$/,'').endsWith('/v1')?'/models':'/v1/models'));
      const env=childEnvironment(config.env);
      const headers={'anthropic-version':'2023-06-01'};
      if (env.ANTHROPIC_AUTH_TOKEN) headers.Authorization='Bearer '+env.ANTHROPIC_AUTH_TOKEN;
      else if (env.ANTHROPIC_API_KEY) headers['x-api-key']=env.ANTHROPIC_API_KEY;
      for (const line of (env.ANTHROPIC_CUSTOM_HEADERS??'').split('\n')) {
        const at=line.indexOf(':');if(at>0) headers[line.slice(0,at).trim()]=line.slice(at+1).trim();
      }
      const combined=AbortSignal.any([AbortSignal.timeout(config.modelsTimeoutMs),...(signal?[signal]:[])]);
      const models=[];
      for (let page=0;page<20;page++) {
        const response=await fetch(url,{headers,signal:combined,redirect:'error'});
        if (!response.ok) {
          reason=`models_api_http_${response.status}`;await response.body?.cancel();throw new Error();
        }
        const data=await boundedJson(response,config.maxOutput);
        if(!Array.isArray(data.data)||!data.data.length||!data.data.every(x=>typeof x.id==='string'&&x.id.length)) throw new Error();
        models.push(...data.data.map(x=>({id:x.id,...(typeof x.display_name==='string'?{name:x.display_name}:{})})));
        if(!data.has_more) return {source:'api',models};
        if(typeof data.last_id!=='string'||!data.last_id||data.last_id===url.searchParams.get('after_id')) throw new Error();
        url.searchParams.set('after_id',data.last_id);
      }
      throw new Error();
    } catch {
      if(signal?.aborted) throw new RunnerError('cancelled','Models request cancelled');
      if(reason==='models_api_not_configured') reason='models_api_invalid';
    }
  }
  if(config.models.length) return {source:'configured',models:config.models.map(id=>({id})),warning:reason};
  throw new RunnerError('models_unavailable',reason+'; configure CLAUDE_MCP_MODELS when the gateway has no list API');
}
