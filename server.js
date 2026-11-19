'use strict';
/*
 * Hostless front proxy — raw TCP level, zero dependencies.
 *
 * Why raw TCP instead of Node's http server?
 * Node's http parser buffers request-body bytes internally. For a
 * plain (non-upgrade) request the parser hands us the socket but
 * keeps whatever body bytes it already read, so a raw socket pipe
 * silently drops the start of the body. WebSocket upgrade was fine
 * because Node gives us those bytes as `head`, but XHTTP's POST
 * upload stream lost its first bytes and the xray session never
 * established (client saw "unexpected status 404" after the
 * server-side session wait timed out). Parsing the header block
 * ourselves keeps every byte: we forward the exact header block
 * plus any already-read body bytes, then pipe the rest verbatim.
 *
 * Routing (per connection, request loop for health checks):
 *   - GET / and GET /health  -> 200 "ok" (health check)
 *   - any request whose path is WS_PATH or starts with WS_PATH + '/'
 *     (XHTTP appends /{sessionId} and /{sessionId}/{seq} to the path,
 *     so exact matching 404s every XHTTP request)
 *     -> raw TCP proxy to xray on 127.0.0.1:$XRAY_PORT
 *        (works for WebSocket Upgrade 101 and for XHTTP packet-up)
 *   - everything else -> 404
 *
 * Secrets are never logged here. Do not log UUID or WS_PATH values.
 */
const net = require('net');

const PORT = parseInt(process.env.PORT || '8080', 10);
const XRAY_PORT = parseInt(process.env.XRAY_PORT || '10001', 10);
const WS_PATH = process.env.WS_PATH || '/ws';
const TRANSPORT = (process.env.TRANSPORT || 'ws').toLowerCase();

function log(msg) {
  console.log(new Date().toISOString() + ' [proxy] ' + msg);
}

const MAX_HEADER = 65536;

function handleConnection(socket) {
  let buf = Buffer.alloc(0);
  let piped = false;

  socket.on('data', (chunk) => {
    if (piped) return; // socket is owned by the pipes now
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_HEADER) {
      try { socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n'); } catch (_) {}
      return;
    }
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return; // wait for the full header block
    const headBlock = buf.subarray(0, idx + 4);
    const leftover = buf.subarray(idx + 4);
    buf = Buffer.alloc(0);

    const text = headBlock.toString('latin1');
    const firstLine = text.split('\r\n')[0] || '';
    const parts = firstLine.split(' ');
    const method = (parts[0] || '').toUpperCase();
    const rawUrl = parts[1] || '/';
    const path = rawUrl.split('?')[0];

    if (path === WS_PATH || path.startsWith(WS_PATH + '/')) {
      // TEMP DIAGNOSTIC (2026-11-19): log shape only, never the path or UUID.
      const rest = path.slice(WS_PATH.length);
      const segs = rest.split('/').filter(Boolean).length;
      const startedAt = Date.now();
      log('proxied ' + method + ' segs=' + segs + ' headBytes=' + headBlock.length + ' leftover=' + leftover.length);
      piped = true;
      const target = net.connect(XRAY_PORT, '127.0.0.1', () => {
        target.write(headBlock);
        if (leftover.length) target.write(leftover);
        socket.pipe(target);
        target.pipe(socket);
      });
      target.on('error', (err) => {
        log('xray connect error: ' + (err && err.code ? err.code : err));
        try { socket.destroy(); } catch (_) {}
      });
      socket.on('close', () => {
        log('closed ' + method + ' segs=' + segs + ' up=' + socket.bytesRead + ' down=' + socket.bytesWritten + ' ms=' + (Date.now() - startedAt));
      });
      socket.on('error', () => {
        try { target.destroy(); } catch (_) {}
      });
      return;
    }

    if (method === 'GET' && (path === '/' || path === '/health')) {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 3\r\nConnection: keep-alive\r\n\r\nok\n');
      // stay in the request loop: a health checker may reuse the socket
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 10\r\nConnection: keep-alive\r\n\r\nnot found\n');
  });

  socket.on('error', () => {
    try { socket.destroy(); } catch (_) {}
  });
}

const server = net.createServer(handleConnection);
server.on('error', (err) => {
  log('listen failed: ' + err.code);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  log('listening on 0.0.0.0:' + PORT + ' transport=' + TRANSPORT + ' xray=127.0.0.1:' + XRAY_PORT);
  log('health endpoints: GET / and GET /health return 200');
});

process.on('SIGTERM', () => {
  log('SIGTERM, shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
