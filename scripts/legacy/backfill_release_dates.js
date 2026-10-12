const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('data/anime-tracker.db');
const delayMs=Number(process.env.DELAY_MS||450);
const maxRetries=Number(process.env.MAX_RETRIES||4);
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function fetchDetails(id){
  const url=`https://api.jikan.moe/v4/anime/${id}`;
  for(let i=0;i<=maxRetries;i++){
    const res=await fetch(url,{headers:{'User-Agent':'anime-tracker-local/1.0'}});
    if(res.status===429||res.status>=500){await sleep(1000*(i+1));continue;}
    if(!res.ok){const t=await res.text(); throw new Error(`HTTP ${res.status}: ${t.slice(0,120)}`);} 
    return (await res.json()).data;
  }
  throw new Error('retry_exhausted');
}
const update=db.prepare('update anime set release_date=?, updated_at=CURRENT_TIMESTAMP where mal_id=?');
(async()=>{
 const rows=db.prepare("select mal_id from anime where release_date is null or trim(release_date)='' order by mal_id").all();
 let ok=0,fail=0;
 for(let i=0;i<rows.length;i++){
   const id=rows[i].mal_id;
   try{const d=await fetchDetails(id); update.run(d?.aired?.from||null,id); ok++;}
   catch{fail++;}
   if((i+1)%50===0||i+1===rows.length) console.log(`progress ${i+1}/${rows.length} ok=${ok} fail=${fail}`);
   await sleep(delayMs);
 }
 const rem=db.prepare("select count(*) n from anime where release_date is null or trim(release_date)='' ").get().n;
 console.log(JSON.stringify({processed:rows.length,ok,fail,remainingNull:rem},null,2));
})();
