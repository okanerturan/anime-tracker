const fs=require('fs');
const PORT=Number(process.env.PORT||8108);
const DELAY_MS=Number(process.env.DELAY_MS||700);
const MAX_RETRIES=Number(process.env.MAX_RETRIES||4);

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function syncOne(malId,title){
  const url=`http://localhost:${PORT}/api/sync-episodes?malId=${malId}&title=${encodeURIComponent(title||'')}`;
  for(let i=0;i<=MAX_RETRIES;i++){
    const res=await fetch(url);
    if(res.status===429||res.status>=500){await sleep(1200*(i+1)); continue;}
    if(!res.ok){const t=await res.text(); throw new Error(`HTTP ${res.status}: ${t.slice(0,160)}`);}
    return res.json();
  }
  throw new Error('retry_exhausted');
}

(async()=>{
  const added=JSON.parse(fs.readFileSync('data/relations-added.json','utf8'));
  const uniq=[]; const seen=new Set();
  for(const a of added){ if(!seen.has(a.malId)){seen.add(a.malId); uniq.push(a);} }
  console.log(`to_sync=${uniq.length}`);
  const ok=[]; const failed=[];
  for(let i=0;i<uniq.length;i++){
    const a=uniq[i];
    try{
      const s=await syncOne(a.malId,a.title);
      ok.push({malId:a.malId,title:a.title,episodes:s.episodesCount,watched:s.watchedCount,unwatched:s.unwatchedCount});
    }catch(e){
      failed.push({malId:a.malId,title:a.title,error:String(e.message||e)});
    }
    if((i+1)%10===0||i+1===uniq.length){
      const e=ok.reduce((n,x)=>n+(x.episodes||0),0);
      const w=ok.reduce((n,x)=>n+(x.watched||0),0);
      console.log(`progress ${i+1}/${uniq.length} ok=${ok.length} failed=${failed.length} watched=${w}/${e}`);
    }
    await sleep(DELAY_MS);
  }
  fs.writeFileSync('data/relations-sync-ok.json',JSON.stringify(ok,null,2));
  fs.writeFileSync('data/relations-sync-failed.json',JSON.stringify(failed,null,2));
  console.log(JSON.stringify({ok:ok.length,failed:failed.length},null,2));
})();
