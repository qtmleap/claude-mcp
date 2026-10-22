import {pathToFileURL} from 'node:url';

const HOST='ghcr.io';
const SEMVER=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const REPOSITORY=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const MANIFEST_TYPES=['application/vnd.oci.image.index.v1+json','application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.list.v2+json','application/vnd.docker.distribution.manifest.v2+json'];

// Messages carry only statuses, never response bodies, tokens or underlying error text.
async function send(fetchImpl,what,url,init){
 try{return await fetchImpl(url,init);}catch{throw new Error(`GHCR ${what} request failed`);}
}

// Resolves only when GHCR answers 404 for the exact version tag; every other outcome throws.
export async function assertVersionAvailable({repository,version,actor,token,fetchImpl=fetch}){
 if(typeof version!=='string'||!SEMVER.test(version))throw new Error('Invalid version: expected plain semver without build metadata');
 if(typeof repository!=='string'||!REPOSITORY.test(repository))throw new Error('Invalid repository: expected lowercase owner/name');
 if(typeof token!=='string'||!token.trim())throw new Error('Missing GitHub token');
 if(typeof actor!=='string'||!actor.trim())throw new Error('Missing GitHub actor');

 const tokenUrl=new URL(`https://${HOST}/token`);
 tokenUrl.searchParams.set('service',HOST);
 tokenUrl.searchParams.set('scope',`repository:${repository}:pull`);
 const auth=await send(fetchImpl,'token',tokenUrl,{headers:{authorization:`Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}`},redirect:'error'});
 if(auth.status!==200)throw new Error(`GHCR token request failed with status ${auth.status}`);
 let bearer;
 try{bearer=(await auth.json()).token;}catch{bearer=undefined;}
 if(typeof bearer!=='string'||!bearer)throw new Error('GHCR token response did not contain a token');

 const manifest=await send(fetchImpl,'manifest',new URL(`https://${HOST}/v2/${repository}/manifests/${version}`),{method:'HEAD',headers:{authorization:`Bearer ${bearer}`,accept:MANIFEST_TYPES.join(', ')},redirect:'error'});
 if(manifest.status===200)throw new Error(`Version ${version} already exists in ${HOST}/${repository}; refusing to overwrite`);
 if(manifest.status!==404)throw new Error(`GHCR manifest lookup failed with status ${manifest.status}`);
 return {status:404};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const {GITHUB_REPOSITORY:repository,VERSION:version,GITHUB_ACTOR:actor,GITHUB_TOKEN:token}=process.env;
  await assertVersionAvailable({repository,version,actor,token});
  console.log(`Version ${version} is not yet published`);
 }catch(error){
  console.error(error.message);
  process.exitCode=1;
 }
}
