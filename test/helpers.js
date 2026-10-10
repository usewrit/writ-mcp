'use strict';
/*
 * Test harness: a mock Streamable-HTTP MCP server plus a driver that runs the
 * REAL connector binary as a subprocess and speaks stdio JSON-RPC to it.
 *
 * Everything is exercised end to end through the same path an MCP client uses —
 * spawn, write newline-delimited JSON to stdin, read it back from stdout. No
 * module internals are reached into, because the wire behaviour IS the contract.
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, '..', 'index.js');

/**
 * Start a mock server. `handler(msg, req)` returns:
 *   { status?, headers?, body? }   — body may be a string or a JSON value
 * or undefined for a default 200 JSON-RPC "method not found".
 * Resolves to { port, url, requests, close }.
 */
function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let msg = null;
      try { msg = JSON.parse(raw); } catch (_) { /* leave null */ }
      requests.push({ method: req.method, url: req.url, headers: req.headers, raw, msg });

      const reply = (out) => {
        if (!out) {
          out = { status: 200, body: { jsonrpc: '2.0', id: msg && msg.id, error: { code: -32601, message: 'no handler' } } };
        }
        const status = out.status || 200;
        const headers = Object.assign(
          { 'Content-Type': out.contentType || 'application/json' },
          out.headers || {}
        );
        if (out.body === undefined || out.body === null) {
          res.writeHead(status, headers);
          return res.end();
        }
        const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
        res.writeHead(status, headers);
        res.end(body);
      };

      // Handlers may be async — the drain test needs a genuinely slow reply.
      Promise.resolve()
        .then(() => handler(msg, req, requests.length))
        .then(reply)
        .catch((err) => { res.writeHead(500); res.end(String(err && err.message)); });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: 'http://127.0.0.1:' + port,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Run the connector.
 *   opts.args      extra argv (array)
 *   opts.env       extra env vars
 *   opts.send      array of values written to stdin as JSON lines (strings are
 *                  written verbatim, so malformed input can be tested)
 *   opts.expect    resolve as soon as this many stdout lines have arrived
 *   opts.timeoutMs overall cap (default 20000, or $WRIT_TEST_TIMEOUT_MS)
 * Resolves to { out, err, lines, code }.
 *
 * TIMING. Every case here spawns a real `node` process and, usually, an HTTP
 * server beside it. The cap used to be 5s and a timeout resolved SILENTLY with
 * whatever had arrived — so on a loaded machine a test failed as
 * `Cannot read properties of undefined (reading 'id')` on line 0 of an empty
 * array, which says nothing about the cause. Six different cases failed that way
 * on one run and none on the next, and the publish script runs this suite as a
 * release guard, so the flake blocked publishing at random.
 *
 * Now: the cap is generous (a real hang is still caught, just later), and a
 * timeout that did not produce the expected output REJECTS with what was
 * actually seen, including the connector's stderr.
 */
function runConnector(opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || Number(process.env.WRIT_TEST_TIMEOUT_MS || 20000);
  const expect = o.expect === undefined ? 0 : o.expect;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN].concat(o.args || []), {
      env: Object.assign({}, process.env, { WRIT_API_KEY: '' }, o.env || {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let settled = false;
    let timedOut = false;
    const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch (_) { /* already closed */ }
      // Give the process a moment to exit cleanly, then report.
      const done = () => {
        const got = out.split('\n').filter(Boolean).length;
        if (timedOut && expect > 0 && got < expect) {
          return reject(new Error(
            'the connector produced ' + got + ' of ' + expect + ' expected stdout line(s) ' +
            'within ' + timeoutMs + 'ms.\n--- stdout ---\n' + out + '\n--- stderr ---\n' + err));
        }
        resolve({ out, err, lines: lines(), code: child.exitCode });
      };
      if (child.exitCode !== null) return done();
      child.once('exit', done);
      setTimeout(() => { try { child.kill(); } catch (_) {} done(); }, 400);
    };

    const timer = setTimeout(() => { timedOut = true; finish(); }, timeoutMs);

    const queue = (o.send || []).slice();
    const write = (m) => child.stdin.write(typeof m === 'string' ? m : JSON.stringify(m) + '\n');

    child.stdout.on('data', (d) => {
      out += d;
      const got = out.split('\n').filter(Boolean).length;
      // `staged` models a real MCP client, which waits for each reply before
      // sending the next request (notably: nothing goes out before initialize
      // returns, which is how session pinning can work at all).
      if (o.staged && queue.length) write(queue.shift());
      if (expect > 0 && got >= expect) {
        // Let any trailing write flush before we tear down.
        setTimeout(finish, 60);
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => { if (expect === 0) setTimeout(finish, 30); });

    if (o.staged) {
      if (queue.length) write(queue.shift());
    } else {
      while (queue.length) write(queue.shift());
    }
    if (!expect) child.stdin.end();
  });
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

const okResult = (id, result) => ({ jsonrpc: '2.0', id, result });

module.exports = { startServer, runConnector, BIN, INIT, okResult };
