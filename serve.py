import http.server
import socketserver
import os

class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    # 每次响应都禁止缓存，避免 cnb.run 隧道 / 浏览器缓存静态资源（app.js/style.css/index.html）
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    # SimpleHTTPRequestHandler 默认会列目录；这里保持默认行为即可（仅提供静态文件）

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('0.0.0.0', 8099), NoCacheHTTPRequestHandler) as httpd:
        print('livephoto-web serving on 0.0.0.0:8099 (no-store)')
        httpd.serve_forever()
