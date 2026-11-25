import {afterEach,expect,it,vi} from 'vitest';
import {libraryRows} from '../src/AssetLibrary';

afterEach(()=>vi.unstubAllGlobals());
const query='?ownerType=project&ownerId=app';
const binding={ownerType:'project',ownerId:'app',assetId:'notes',versionPolicy:'pinned',versionId:'v1'};
const version={id:'v1',downloads:[]};
function servePinned(statuses:number[]){
 const fetch=vi.fn(async(url:string)=>{
  const path=url.replace('/api/v2/assets','');
  if(path===query)return Response.json([{id:'notes',kind:'document',headVersionId:'v2'}]);
  if(path==='/bindings'+query)return Response.json([binding]);
  if(path==='/notes/versions/v1'){
   const status=statuses.shift()??200;
   return Response.json(status===200?version:{error:'pin failed'},{status});
  }
  throw new Error('Unexpected URL '+url);
 });
 vi.stubGlobal('fetch',fetch);
}

it('propagates a temporary pinned-version failure and retries the project pin on the next load',async()=>{
 servePinned([503,200]);
 await expect(libraryRows('project','app',true)).rejects.toMatchObject({status:503});
 await expect(libraryRows('project','app',true)).resolves.toMatchObject([{binding,pinned:version}]);
});

it.each([403,404])('keeps unavailable pins distinct from the head for HTTP %s',async status=>{
 servePinned([status]);
 await expect(libraryRows('project','app',true)).resolves.toMatchObject([{binding,pinned:null}]);
});
