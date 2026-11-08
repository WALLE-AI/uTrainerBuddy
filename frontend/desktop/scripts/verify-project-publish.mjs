import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { connectDesktop } from './cdp-client.mjs';
const d=await connectDesktop();const fixture=fileURLToPath(new URL('project-publish-fixture.tsx',import.meta.url)).replaceAll('\\','/');
const text="document.querySelector('#project-publish-fixture')?.textContent";
const until=(expression,timeout=10000)=>d.until(expression,timeout);
const click=label=>d.evaluate(`Array.from(document.querySelectorAll('#project-publish-fixture button')).find(b=>b.textContent.includes(${JSON.stringify(label)}))?.click()`);
try {
 await d.evaluate(`import(${JSON.stringify('/@fs/'+fixture)}).then(async m=>{window.projectPublishTest=await m.mount()})`);
 await until("document.querySelector('#project-publish-fixture input')?.value === 'F:/fixture/project'");
 await click('保存项目绑定');await until("!Array.from(document.querySelectorAll('#project-publish-fixture button')).find(b=>b.textContent==='检查本地版本').disabled");await click('检查本地版本');await until(`${text}?.includes('本地有未提交')`);
 assert(await d.evaluate("Array.from(document.querySelectorAll('#project-publish-fixture button')).find(b=>b.textContent==='发布代码').disabled"));
 await d.evaluate('window.projectPublishTest.clean()');await click('检查本地版本');await until(`${text}?.includes('2 个文件')`);
 await click('启用上传服务');await until("!!document.querySelector('.arco-modal-simple')");
 assert(await d.evaluate("document.querySelector('.arco-modal-simple').textContent.includes('/workspace/.trainerbuddy/hosts/test/trainerbuddy-host')"));
 await d.evaluate("Array.from(document.querySelectorAll('.arco-modal-simple button')).find(b=>b.textContent.includes('安装并启用')).click()");
 await until(`${text}?.includes('上传服务已就绪')`);
 await click('发布代码');await until(`${text}?.includes('已完成')`,15000);await until(`${text}?.includes('最后发布的代码版本')`);
 const requests=await d.evaluate('window.projectPublishTest.requests');const publish=requests.find(r=>r.path.endsWith('/publish'));assert(publish.body.request_id);assert.equal(publish.body.commit,'a'.repeat(40));
 await d.evaluate('window.projectPublishTest.changeTarget()');await until(`${text}?.includes('当前服务器与项目绑定不一致')`);
 assert(await d.evaluate("Array.from(document.querySelectorAll('#project-publish-fixture button')).find(b=>b.textContent==='发布代码').disabled"));
 console.log('PASS project publish UI: binding, dirty-state block, version preview, reviewed host installation, publish progress, receipt and target isolation');
} finally {await d.evaluate('window.projectPublishTest?.cleanup()').catch(()=>{});d.close();}
