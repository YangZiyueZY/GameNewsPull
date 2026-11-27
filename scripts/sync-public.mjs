// 把已提交的构建产物（docs/img、docs/api）递归同步到 apps/web/public/，
// 否则 `vite build` 清空 docs/ 后只从 public/ 拷回文件，图片与 API 会整体丢失。
// 使用场景：GitHub Actions、Cloudflare/帽子云等 PaaS 的「干净克隆后构建」。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const pairs = [
  { from: path.join(ROOT, 'docs', 'img'), to: path.join(ROOT, 'apps', 'web', 'public', 'img') },
  { from: path.join(ROOT, 'docs', 'api'), to: path.join(ROOT, 'apps', 'web', 'public', 'api') },
];

/** 递归拷贝目录内容（保持子目录结构），返回拷贝的文件数 */
function copyTree(from, to) {
  let count = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      count += copyTree(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      count += 1;
    }
  }
  return count;
}

let copied = 0;
let skipped = 0;
for (const { from, to } of pairs) {
  if (!fs.existsSync(from)) {
    console.warn('[sync-public] 跳过（源目录不存在）:', path.relative(ROOT, from));
    skipped += 1;
    continue;
  }
  copied += copyTree(from, to);
}
console.log('[sync-public] 已递归同步 ' + copied + ' 个文件到 apps/web/public/（跳过 ' + skipped + ' 个目录）');