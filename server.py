#!/usr/bin/env python3
"""Локальний HTTP-сервер і проксі Jev API. Потрібен тільки Python 3."""

import json
import os
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'public'
API_BASE = 'https://jev-ai.pro/api/v1'
MAX_PAYLOAD = 64 * 1024

try:
    from local_config import API_KEY
except ImportError:
    API_KEY = ''

API_KEY = os.getenv('JEV_AI_API_KEY', API_KEY).strip()
PORT = int(os.getenv('PORT', '8787'))


def is_valid_payload(payload):
    return (
        isinstance(payload, dict)
        and payload.get('model') == 'jev-latest'
        and isinstance(payload.get('state'), dict)
        and isinstance(payload['state'].get('description'), str)
        and 30 <= len(payload['state']['description']) <= 6500
        and isinstance(payload.get('questions'), dict)
        and 1 <= len(payload['questions']) <= 64
    )


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def send_json(self, code, value):
        body = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy(self, method, target, body=None):
        if not API_KEY:
            self.send_json(503, {'error': {'message': 'Jev API-ключ не задано у local_config.py або JEV_AI_API_KEY.'}})
            return
        headers = {
            'Authorization': f'Bearer {API_KEY}',
            'Accept': 'application/json',
        }
        if body is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(API_BASE + target, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=55) as response:
                result = response.read(MAX_PAYLOAD * 4)
                status = response.status
        except urllib.error.HTTPError as error:
            result = error.read(MAX_PAYLOAD * 4)
            status = error.code
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            self.send_json(502, {'error': {'message': 'Не вдалося зв’язатися з Jev API. Перевірте інтернет-з’єднання.'}})
            return
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(result)))
        self.end_headers()
        self.wfile.write(result)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/api/jev/models':
            self.proxy('GET', '/models')
        elif path.startswith('/api/'):
            self.send_json(404, {'error': {'message': 'Маршрут не знайдено.'}})
        else:
            super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != '/api/jev/analyze':
            self.send_json(404, {'error': {'message': 'Маршрут не знайдено.'}})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = -1
        if not 0 < length <= MAX_PAYLOAD:
            self.send_json(413, {'error': {'message': 'Неприпустимий розмір запиту.'}})
            return
        try:
            body = self.rfile.read(length)
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            self.send_json(400, {'error': {'message': 'Некоректний JSON.'}})
            return
        if not is_valid_payload(payload):
            self.send_json(422, {'error': {'message': 'Некоректний вміст запиту.'}})
            return
        self.proxy('POST', '/systemone', body)


if __name__ == '__main__':
    httpd = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'CarRisk Lab: http://127.0.0.1:{PORT}')
    print('Зупинити сервер: Ctrl+C')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nСервер зупинено.')
    finally:
        httpd.server_close()
