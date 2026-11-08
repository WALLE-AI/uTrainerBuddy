import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { connectDesktop } from './cdp-client.mjs';
const desktop=await connectDesktop();
const {evaluate,until,cdp}=desktop;
const fixture=fileURLToPath(new URL('remote-files-fixture.tsx',import.meta.url)).replaceAll('\\','/');
const text='document.querySelector("#remote-files-fixture")?.textContent';
const clickLabel=async label=>evaluate(`Array.from(document.querySelectorAll('#remote-files-fixture button')).find(b=>b.textContent.includes(${JSON.stringify(label)}))?.click()`);
try {
  await evaluate(`import(${JSON.stringify('/@fs/'+fixture)}).then(async m=>{window.remoteFilesTest=await m.mount()})`);
  await until(`${text}?.includes('config.json')`);
  await clickLabel('加载更多');await until(`${text}?.includes('more.txt')`);
  await clickLabel('data');await until(`${text}?.includes('samples.jsonl')`);
  await clickLabel('samples.jsonl');await until(`document.querySelector('.remote-file-text')?.textContent.includes('训练样本')`);
  assert.equal(await evaluate(`document.querySelector('.remote-file-text').textContent`),'{"question":"训练样本"}\n');
  assert.equal(await evaluate(`document.querySelector('.remote-file-download').getAttribute('download')`),'samples.jsonl');
  await evaluate(`Array.from(document.querySelectorAll('.arco-modal-footer button')).find(b=>b.textContent.includes('关闭')).click()`);
  await clickLabel('上一级');await until(`${text}?.includes('large.bin')`);
  await clickLabel('large.bin');await until(`${text}?.includes('文件超过预览限制')`);
  await evaluate('window.remoteFilesTest.disconnect()');await until(`${text}?.includes('重新登录')`);
  await evaluate('window.remoteFilesTest.reconnect()');await until(`${text}?.includes('config.json')`);
  const requests=await evaluate('window.remoteFilesTest.requests');
  assert(requests.some(path=>path.includes('cursor=3')));
  assert(requests.some(path=>path.includes('connection_id=ui-b')));
  await cdp('Emulation.setDeviceMetricsOverride',{width:420,height:760,deviceScaleFactor:1,mobile:false});
  assert(await evaluate(`document.querySelector('#remote-files-fixture').scrollWidth <= 420`));
  console.log('PASS remote files UI: directory navigation, paging, UTF-8 preview, download link, size error, disconnect/reconnect, narrow viewport');
} finally {
  await evaluate('window.remoteFilesTest?.cleanup()').catch(()=>{});
  await cdp('Emulation.clearDeviceMetricsOverride').catch(()=>{});desktop.close();
}
