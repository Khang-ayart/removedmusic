import { spawn } from 'node:child_process';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn('python3', ['-m', 'http.server', '8101', '--directory', '/home/claude/removedmusic'], { stdio: 'ignore' });
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new','--no-sandbox','--disable-gpu','--autoplay-policy=no-user-gesture-required','--remote-debugging-port=9334','--user-data-dir=/tmp/advprof_'+Date.now(),'--no-first-run','about:blank'],{stdio:'ignore'});
let targets; for (let i=0;i<50;i++){try{targets=await(await fetch('http://127.0.0.1:9334/json')).json();break}catch{await sleep(200)}}
const ws = new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend=new Map(); const errs=[];
ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result)} else if(m.method==='Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)); else if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error') errs.push(m.params.args.map(a=>a.value||a.description).join(' '))};
const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params}))});
const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('eval '+JSON.stringify(r.exceptionDetails));return r.result.value};
async function until(x,ms=60000){const t=Date.now();while(Date.now()-t<ms){try{if(await ev(x))return true}catch{}await sleep(100)}throw new Error('timeout '+x)}
await send('Page.enable');await send('Runtime.enable');await send('DOM.enable');
let failed=0; const check=(n,c,x='')=>{if(!c)failed++;console.log((c?'PASS ':'FAIL ')+n+(x?' → '+x:''))};
async function load(){await send('Page.navigate',{url:'http://localhost:8101/index.html'});await sleep(500);await until('document.readyState==="complete"')}
async function setFile(){const{root}=await send('DOM.getDocument');const{nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'#fileInput'});await send('DOM.setFileInputFiles',{files:['/home/claude/labtest/test48k.wav'],nodeId})}
const val=(id)=>ev(`document.getElementById("${id}").innerText`);

await load();
check('A1 mặc định chọn chế độ Nâng cao, hiện tuỳ chọn', await ev('modeSelect.value==="advanced" && getComputedStyle(advOptions).display!=="none"'));
check('A2 nút Huỷ và panel A/B ẩn lúc đầu', await ev('cancelBtn.hidden && abPanel.style.display==="none"'));
await setFile(); await until('!processBtn.disabled',5000);

// B. Nâng cao
const t0=Date.now();
await ev('processBtn.click()');
const seen=new Set(); 
while(true){const s=await val('status'); seen.add(s); if(s.startsWith('✅ Tách thành công')||s.startsWith('❌'))break; if(Date.now()-t0>90000)break; await sleep(60)}
const st=await val('status'); const dt=(Date.now()-t0)/1000;
check('B1 tách xong, không lỗi', st.startsWith('✅ Tách thành công (chế độ nâng cao)'), st);
check('B2 có hiện tiến độ %', [...seen].some(s=>/Đang tách vocal… \d+%/.test(s)), [...seen].slice(0,4).join(' | '));
check('B3 giao diện điều khiển + A/B hiện ra', await ev('controls.style.display==="block" && abPanel.style.display==="block"'));
check('B4 đủ buffer: vocal mono, music stereo, cùng độ dài', await ev('vocalBuffer.numberOfChannels===1 && musicBuffer.numberOfChannels===2 && vocalBuffer.length===musicBuffer.length && vocalBuffer.length===__RMstate.orig.length'));
check('B5 có vocal sạch riêng khác vocal thô', await ev('(()=>{const a=__RMstate.bufs.raw.getChannelData(0),b=__RMstate.bufs.clean.getChannelData(0);let d=0;for(let i=0;i<a.length;i+=50)d+=Math.abs(a[i]-b[i]);return d>1e-3})()'));
check('B6 vocal không NaN/vô hạn, có tín hiệu', await ev('(()=>{for(const b of [vocalBuffer,musicBuffer])for(let c=0;c<b.numberOfChannels;c++){const d=b.getChannelData(c);let e=0;for(let i=0;i<d.length;i++){if(!isFinite(d[i]))return false;e+=d[i]*d[i]}if(e<1e-6)return false}return true})()'));
console.log('  thời gian tách (desktop headless):',dt.toFixed(1),'s');
// UI không đơ: đo độ trễ vòng lặp sự kiện khi đang tách
// (chạy lại ở mục E)

// C. A/B
await ev('abPlayBtn.click()'); await sleep(400);
check('C1 bấm Nghe → đang phát, nút đổi chữ', await ev('document.getElementById("abPlayBtn").innerText.includes("Tạm dừng")'));
const nodes1=await ev('__RMstate.bufs && Object.keys(__RMstate.bufs).length');
await ev('document.querySelector("[data-ab=orig]").click()'); await sleep(200);
check('C2 chuyển sang Gốc tức thì (vẫn đang phát)', await ev('document.querySelector("[data-ab=orig]").classList.contains("on") && abPlayBtn.innerText.includes("Tạm dừng")'));
await ev('abPlayBtn.click()');
check('C3 dừng được', await ev('abPlayBtn.innerText.includes("Nghe")'));
await ev('playBtn.click()'); await sleep(200);
check('C4 phát chính (Play) vẫn chạy với buffer nâng cao', await ev('isPlaying===true'));
await ev('abPlayBtn.click()'); await sleep(200);
check('C5 bật A/B tự tắt phát chính (không chồng tiếng)', await ev('isPlaying===false'));
await ev('abPlayBtn.click()');

// D. tắt/bật làm sạch sau khi tách
await ev('cleanupChk.click()'); await until('document.getElementById("status").innerText.includes("vocal thô")',20000);
check('D1 tắt làm sạch → vocalBuffer = vocal thô, nút "Vocal sạch" bị khoá', await ev('vocalBuffer===__RMstate.bufs.raw && document.querySelector("[data-ab=clean]").disabled'));
await ev('cleanupChk.click()'); await until('document.getElementById("status").innerText.includes("Đã áp dụng làm sạch")',20000);
check('D2 bật lại → vocalBuffer = vocal sạch', await ev('vocalBuffer===__RMstate.bufs.clean && !document.querySelector("[data-ab=clean]").disabled'));
await ev('cleanupPreset.value="manh"; cleanupPreset.dispatchEvent(new Event("change"))'); await until('document.getElementById("status").innerText.includes("Đã áp dụng làm sạch")',20000);
check('D3 đổi mức làm sạch chạy được', true);

// E. UI không đơ khi tách + Huỷ
await ev('window.__lag=0;window.__last=performance.now();window.__iv=setInterval(()=>{const n=performance.now();window.__lag=Math.max(window.__lag,n-window.__last-50);window.__last=n},50)');
await ev('processBtn.click()'); await until('!cancelBtn.hidden',5000);
await sleep(300);
await ev('cancelBtn.click()'); await sleep(300);
const lag=await ev('window.__lag');
check('E1 Huỷ: nút mở lại, trạng thái "Đã huỷ"', await ev('!processBtn.disabled && document.getElementById("status").innerText.includes("Đã huỷ") && cancelBtn.hidden'));
check('E2 luồng giao diện không bị chặn khi tách (độ trễ tối đa < 250 ms)', lag<250, lag.toFixed(0)+' ms');
await ev('processBtn.click()'); await until('document.getElementById("status").innerText.includes("Tách thành công")',90000);
check('E3 tách lại sau khi huỷ vẫn được', true);

// F. Chế độ Cơ bản giữ nguyên
await ev('modeSelect.value="basic"; modeSelect.dispatchEvent(new Event("change"))');
check('F0 chọn Cơ bản ẩn tuỳ chọn nâng cao', await ev('getComputedStyle(advOptions).display==="none"'));
await ev('processBtn.click()'); await until('document.getElementById("status").innerText.startsWith("✅ Tách thành công!")',20000);
check('F1 Cơ bản: Mid/Side cũ, 2 buffer mono', await ev('vocalBuffer.numberOfChannels===1&&musicBuffer.numberOfChannels===1'));
check('F2 Cơ bản đúng công thức (L+R)/2', await ev('(()=>{const L=__RMstate.orig.getChannelData(0),R=__RMstate.orig.getChannelData(1),v=vocalBuffer.getChannelData(0);for(let i=0;i<L.length;i+=997)if(Math.abs(v[i]-(L[i]+R[i])/2)>1e-6)return false;return true})()'));
await ev('playBtn.click()'); await sleep(200); check('F3 Play/Pause cũ chạy', await ev('isPlaying'));
await ev('playBtn.click()');
// Tải về
check('F4 nút tải vẫn tạo WAV', await ev('(()=>{try{const b=audioBufferToWav(musicBuffer);return b.size>1000}catch(e){return false}})()'));

check('G không có lỗi JS/console', errs.length===0, errs.join(' || '));
console.log(failed?`\n${failed} FAIL`:'\nALL ADV INTEGRATION CHECKS PASSED');
chrome.kill();srv.kill();process.exit(failed?1:0);
