#!/usr/bin/env python3
"""
Log Viewer Service - Provides HTTP access to MCP server logs with mTLS authentication
"""
import os
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
import ssl
from datetime import datetime
from pathlib import Path

# Configuration
LOG_DIR = os.getenv('LOG_DIR', '/var/log/mcp')
PORT = int(os.getenv('LOG_VIEWER_PORT', '8888'))
CERT_FILE = os.getenv('CERT_FILE', '/app/certs/server.crt')
KEY_FILE = os.getenv('KEY_FILE', '/app/certs/server.key')
CA_FILE = os.getenv('CA_FILE', '/app/certs/ca.crt')


class LogViewerHandler(BaseHTTPRequestHandler):
    """HTTP request handler for log viewing"""

    def do_GET(self):
        """Handle GET requests"""
        if self.path == '/logs':
            self.serve_logs()
        elif self.path == '/logs/stream':
            self.serve_logs_stream()
        elif self.path == '/health':
            self.serve_health()
        elif self.path.startswith('/logs/'):
            # Serve specific log file
            log_file = self.path.replace('/logs/', '')
            self.serve_specific_log(log_file)
        else:
            self.send_error(404, "Not Found")

    def serve_health(self):
        """Health check endpoint"""
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        response = {
            'status': 'healthy',
            'service': 'log-viewer',
            'timestamp': datetime.utcnow().isoformat()
        }
        self.wfile.write(json.dumps(response, indent=2).encode())

    def serve_logs(self):
        """Serve all available logs"""
        try:
            log_dir = Path(LOG_DIR)
            if not log_dir.exists():
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                response = {
                    'error': 'Log directory not found',
                    'log_dir': LOG_DIR,
                    'available_logs': []
                }
                self.wfile.write(json.dumps(response, indent=2).encode())
                return

            log_files = list(log_dir.glob('*.log'))
            logs_data = {}

            for log_file in sorted(log_files):
                try:
                    with open(log_file, 'r') as f:
                        # Read last 1000 lines
                        lines = f.readlines()
                        logs_data[log_file.name] = {
                            'lines': lines[-1000:],
                            'total_lines': len(lines),
                            'size_bytes': log_file.stat().st_size,
                            'modified': datetime.fromtimestamp(log_file.stat().st_mtime).isoformat()
                        }
                except Exception as e:
                    logs_data[log_file.name] = {
                        'error': str(e)
                    }

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response = {
                'log_dir': LOG_DIR,
                'timestamp': datetime.utcnow().isoformat(),
                'logs': logs_data
            }
            self.wfile.write(json.dumps(response, indent=2).encode())

        except Exception as e:
            self.send_error(500, f"Error reading logs: {str(e)}")

    def serve_logs_stream(self):
        """Serve logs as plain text (easier to read)"""
        try:
            log_dir = Path(LOG_DIR)
            if not log_dir.exists():
                self.send_error(404, "Log directory not found")
                return

            log_files = sorted(log_dir.glob('*.log'))

            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()

            for log_file in log_files:
                try:
                    self.wfile.write(f"\n{'='*80}\n".encode())
                    self.wfile.write(f"LOG FILE: {log_file.name}\n".encode())
                    self.wfile.write(f"SIZE: {log_file.stat().st_size} bytes\n".encode())
                    self.wfile.write(f"MODIFIED: {datetime.fromtimestamp(log_file.stat().st_mtime).isoformat()}\n".encode())
                    self.wfile.write(f"{'='*80}\n\n".encode())

                    with open(log_file, 'r') as f:
                        # Read last 1000 lines
                        lines = f.readlines()
                        for line in lines[-1000:]:
                            self.wfile.write(line.encode())

                    self.wfile.write(b"\n\n")
                except Exception as e:
                    self.wfile.write(f"Error reading {log_file.name}: {str(e)}\n".encode())

        except Exception as e:
            self.send_error(500, f"Error reading logs: {str(e)}")

    def serve_specific_log(self, log_file_name):
        """Serve a specific log file"""
        try:
            log_path = Path(LOG_DIR) / log_file_name

            if not log_path.exists() or not log_path.is_file():
                self.send_error(404, f"Log file not found: {log_file_name}")
                return

            # Prevent directory traversal
            if '..' in log_file_name or '/' in log_file_name:
                self.send_error(403, "Invalid log file name")
                return

            with open(log_path, 'r') as f:
                content = f.read()

            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(content.encode())

        except Exception as e:
            self.send_error(500, f"Error reading log: {str(e)}")

    def log_message(self, format, *args):
        """Override to add timestamp to logs"""
        print(f"[{datetime.utcnow().isoformat()}] {format % args}")


def main():
    """Start the log viewer server with mTLS"""
    server_address = ('0.0.0.0', PORT)
    httpd = HTTPServer(server_address, LogViewerHandler)

    # Check if certificate files exist
    cert_files = [CERT_FILE, KEY_FILE, CA_FILE]
    missing_files = [f for f in cert_files if not os.path.exists(f)]

    if missing_files:
        print(f"WARNING: Missing certificate files: {missing_files}")
        print("Starting server WITHOUT mTLS (insecure mode)")
        print(f"Server listening on http://0.0.0.0:{PORT}")
        print("Endpoints:")
        print(f"  - http://localhost:{PORT}/health")
        print(f"  - http://localhost:{PORT}/logs")
        print(f"  - http://localhost:{PORT}/logs/stream")
        httpd.serve_forever()
    else:
        # Create SSL context with mTLS
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(CERT_FILE, KEY_FILE)
        context.load_verify_locations(CA_FILE)
        context.verify_mode = ssl.CERT_REQUIRED

        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

        print(f"Server started with mTLS on https://0.0.0.0:{PORT}")
        print("Endpoints:")
        print(f"  - https://localhost:{PORT}/health")
        print(f"  - https://localhost:{PORT}/logs")
        print(f"  - https://localhost:{PORT}/logs/stream")
        print(f"\nAccess with client certificate:")
        print(f"  curl --cert {CA_FILE.replace('/app/', './')}:client.crt --key {KEY_FILE.replace('/app/', './')}:client.key --cacert {CA_FILE.replace('/app/', './')}:ca.crt https://localhost:{PORT}/logs/stream")

        httpd.serve_forever()


if __name__ == '__main__':
    main()
