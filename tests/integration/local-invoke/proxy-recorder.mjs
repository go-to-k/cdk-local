// Minimal recording forward proxy for the HTTPS_PROXY integ step (issue
// #634). Listens on an OS-ASSIGNED loopback port (never a hard-coded one —
// issue #591's disease), prints that port on stdout, and appends the first
// request line of every connection (the `CONNECT <host>:<port> HTTP/1.1`
// a proxied TLS client sends) to the log file given as argv[2]. It answers
// 502 so the tunnel never opens: the assertion is that the CLI TRIED to
// tunnel through the proxy, not that AWS was reached.
import net from 'node:net';
import fs from 'node:fs';

const logFile = process.argv[2];
if (!logFile) {
  console.error('usage: node proxy-recorder.mjs <log-file>');
  process.exit(1);
}

const server = net.createServer((sock) => {
  sock.once('data', (buf) => {
    const line = buf.toString('utf8').split('\r\n')[0];
    fs.appendFileSync(logFile, line + '\n');
    sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  // The client may abort the socket after the 502; never crash the recorder.
  sock.on('error', () => {});
});

server.listen(0, '127.0.0.1', () => {
  console.log(String(server.address().port));
});
