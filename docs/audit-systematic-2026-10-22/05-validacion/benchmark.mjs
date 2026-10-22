import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
const before = await import(pathToFileURL(process.argv[2]).href);
import * as after from '../../../src/provider-translator.js';
const frame = Buffer.from('data: '+JSON.stringify({ choices: [{ delta: {content: 'Zażółć 🧪'.repeat(20)}, finish_reason: 'stop'}]})+'\n\n');
const result={node:process.version,iterations:1000,scope:'one complete SSE frame, local Transform; no network/SLO claim'};
for (const [name, mod] of [['before',before],['after',after]]) {
  const times=[];
  global.gc();
  const memoryStart=process.memoryUsage().heapUsed;
  const cpuStart=process.cpuUsage();
  for(let i=0;i<1020;i++) {
    const begin=performance.now();
    const stream=mod.createOpenAIToAnthropicTransformStream();
    const done=new Promise((resolve,reject)=>{stream.on('end',resolve);stream.on('error',reject);});
    stream.resume();stream.end(frame);await done;
    if(i>=20)times.push(performance.now()-begin);
  }
  times.sort((a,b)=>a-b);
  result[name]={p50_ms:times[499],p95_ms:times[949],p99_ms:times[989],cpu_us:process.cpuUsage(cpuStart),heap_delta_bytes:process.memoryUsage().heapUsed-memoryStart};
}
console.log(JSON.stringify(result,null,2));
