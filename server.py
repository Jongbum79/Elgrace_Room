#!/usr/bin/env python3
"""주은혜교회 공간예약시스템 로컬 개발용 정적 웹 서버 스크립트"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent

class RoomReservationHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # ROOT 디렉토리를 문서 루트로 설정하여 정적 파일 서빙
        super().__init__(*args, directory=str(ROOT), **kwargs)

def main():
    port = 8000
    server_address = ('', port)
    
    print(f"🚀 로컬 개발 서버를 구동합니다...")
    print(f"🔗 http://localhost:{port} 주소로 접속해 주십시오.")
    print("💡 종료하려면 [Ctrl + C]를 누르십시오.")
    
    server = ThreadingHTTPServer(server_address, RoomReservationHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 서버를 안전하게 종료했습니다.")

if __name__ == "__main__":
    main()
