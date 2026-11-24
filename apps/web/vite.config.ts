import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 开发期图片代理：B站 CDN 按 Referer 拦截。
// 生产构建为纯静态：所有图片在抓取时已下载到 public/img，无需代理。
function devImageProxy() {
  return {
    name: 'dev-image-proxy',
    configureServer(server: any) {
      // 只拦截带 ?u= 的远程图片代理请求；本地 public/img 静态资源继续交给 Vite 处理。
      server.middlewares.use('/img', async (req: any, res: any, next: any) => {
        try {
          const u = new URL(req.url, 'http://localhost').searchParams.get('u');
          if (!u) return next();
          const target = new URL(u);
          if (!/(^|\.)hdslb\.com$/.test(target.hostname)) { res.statusCode = 403; return res.end('forbidden host'); }
          const r = await fetch(target.href, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Referer': 'https://www.bilibili.com/' },
          });
          if (!r.ok) { res.statusCode = r.status; return res.end(); }
          res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e: any) { res.statusCode = 502; res.end(String(e?.message || e)); }
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  root: 'apps/web',
  base: './',                       // 相对路径，兼容项目页 /repo/ 子路径
  plugins: command === 'serve' ? [vue(), devImageProxy()] : [vue()],
  server: { host: '0.0.0.0', port: 5173 },
  build: {
    outDir: command === 'serve' ? '../../dist/web' : '../../docs',
    emptyOutDir: true,
  },
}));
