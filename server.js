// server.js
'use strict';

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

// Security and performance middleware
app.use(helmet({
  contentSecurityPolicy: false, // keep simple for local app
}));
app.use(compression());
app.use(morgan('dev'));

// Static client files
app.use(express.static(path.join(__dirname, 'public')));

// Raw body for upload speed test (limit to 200MB)
app.use('/api/speedtest/upload', express.raw({ type: 'application/octet-stream', limit: '200mb' }));

// Utilities
const isWindows = process.platform === 'win32';

// Very strict host validation (IPv4, IPv6 shorthand chars, and hostnames)
function validateHost(input) {
  if (typeof input !== 'string') return null;
  const host = input.trim();
  if (!host || host.length > 255) return null;
  // Allow letters, digits, dots, hyphens, and colons (for IPv6)
  if (!/^[A-Za-z0-9.\-:]+$/.test(host)) return null;
  return host;
}

function runCommand(cmd, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { child.kill('SIGKILL'); } catch {}
        resolve({ code: null, stdout, stderr: stderr + '\n[Timed out]', timedOut: true });
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: String(err), timedOut: false });
      }
    });

    child.on('close', (code) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut: false });
      }
    });
  });
}

// Basic parsing for ping statistics (handles common Windows and Unix formats)
function parsePingResult(output) {
  const result = {
    transmitted: null,
    received: null,
    loss: null,
    min: null,
    avg: null,
    max: null,
    raw: output,
  };

  const lines = output.split(/\r?\n/);

  // Look for Unix-like summary: "packets transmitted, received, % packet loss"
  const unixStats = lines.find(l => /packets transmitted/i.test(l) && /received/i.test(l));
  if (unixStats) {
    const m = unixStats.match(/(\d+)\s+packets transmitted,\s+(\d+)\s+received.*?(\d+)%\s+packet loss/i);
    if (m) {
      result.transmitted = Number(m[1]);
      result.received = Number(m[2]);
      result.loss = Number(m[3]);
    }
  }

  // Look for Unix-like rtt line: "min/avg/max/..."
  const rttLine = lines.find(l => /(rtt|round-trip).*?min\/avg\/max/i.test(l));
  if (rttLine) {
    const m = rttLine.match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
    if (m) {
      result.min = Number(m[1]);
      result.avg = Number(m[2]);
      result.max = Number(m[3]);
    }
  }

  // Windows parsing
  const winStatLine = lines.find(l => /Packets: Sent =/i.test(l));
  if (winStatLine) {
    const sentMatch = winStatLine.match(/Sent\s*=\s*(\d+)/i);
    const recMatch = winStatLine.match(/Received\s*=\s*(\d+)/i);
    const lostMatch = winStatLine.match(/Lost\s*=\s*(\d+)/i);
    if (sentMatch) result.transmitted = Number(sentMatch[1]);
    if (recMatch) result.received = Number(recMatch[1]);
    if (lostMatch && result.transmitted != null) {
      const lost = Number(lostMatch[1]);
      result.loss = Math.round((lost / result.transmitted) * 100);
    }
  }

  const winTimeLine = lines.find(l => /Minimum =|Average =|Maximum =/i.test(l));
  if (winTimeLine) {
    // e.g., Minimum = 1ms, Maximum = 3ms, Average = 2ms
    const minMatch = winTimeLine.match(/Minimum\s*=\s*(\d+)\s*ms/i);
    const avgMatch = winTimeLine.match(/Average\s*=\s*(\d+)\s*ms/i);
    const maxMatch = winTimeLine.match(/Maximum\s*=\s*(\d+)\s*ms/i);
    if (minMatch) result.min = Number(minMatch[1]);
    if (avgMatch) result.avg = Number(avgMatch[1]);
    if (maxMatch) result.max = Number(maxMatch[1]);
  }

  return result;
}

// Routes

// System info
app.get('/api/sysinfo', (req, res) => {
  const nets = os.networkInterfaces();
  const netArray = Object.entries(nets).map(([name, addrs]) => ({
    name,
    addresses: (addrs || []).map(a => ({
      address: a.address,
      family: a.family,
      mac: a.mac,
      internal: a.internal,
      netmask: a.netmask,
      cidr: a.cidr || null,
      scopeid: a.scopeid ?? null,
    })),
  }));

  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptimeSec: os.uptime(),
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    loadAvg: os.loadavg(), // [1, 5, 15] on Unix; [0,0,0] on Windows
    cpus: os.cpus().map(c => ({
      model: c.model,
      speedMHz: c.speed,
      times: c.times,
    })),
    network: netArray,
  });
});

// Ping
app.get('/api/ping', async (req, res) => {
  const host = validateHost(req.query.host);
  if (!host) {
    return res.status(400).json({ error: 'Invalid host' });
  }

  const args = isWindows
    ? ['-n', '4', '-w', '2000', host]     // 4 echo requests, 2s timeout each
    : ['-c', '4', host];                  // 4 echo requests (Unix)

  const { code, stdout, stderr, timedOut } = await runCommand(isWindows ? 'ping' : 'ping', args, { timeoutMs: 30000 });

  const parsed = parsePingResult(stdout + (stderr ? '\n' + stderr : ''));
  return res.json({
    ok: !timedOut && code === 0,
    exitCode: code,
    timedOut,
    stats: parsed,
  });
});

// Traceroute
app.get('/api/traceroute', async (req, res) => {
  const host = validateHost(req.query.host);
  if (!host) {
    return res.status(400).json({ error: 'Invalid host' });
  }

  let cmd;
  let args;
  if (isWindows) {
    cmd = 'tracert';
    args = ['-d', '-h', '30', host]; // -d: do not resolve names; -h: max hops 30
  } else {
    cmd = 'traceroute';
    args = ['-n', '-m', '30', host]; // -n: numeric; -m: max hops 30
  }

  const { code, stdout, stderr, timedOut } = await runCommand(cmd, args, { timeoutMs: 60000 });
  const output = (stdout || '') + (stderr ? '\n' + stderr : '');

  res.json({
    ok: !timedOut && code === 0,
    exitCode: code,
    timedOut,
    output,
  });
});

// Speed test - download (server -> client)
app.get('/api/speedtest/download', async (req, res) => {
  const sizeParam = Number(req.query.size || 25 * 1024 * 1024); // default 25MB
  const MAX_SIZE = 50 * 1024 * 1024; // 50MB limit for safety
  const size = Math.max(1024, Math.min(sizeParam, MAX_SIZE));

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', 'no-store');

  // Stream random-ish bytes without holding all in memory
  const CHUNK = 64 * 1024;
  let remaining = size;
  const chunk = Buffer.alloc(CHUNK);

  // Fill with pseudo-random data once; tweak first byte to change per send
  for (let i = 0; i < CHUNK; i++) chunk[i] = (i * 97 + 31) & 0xff;

  function writeMore() {
    while (remaining > 0) {
      const toWrite = Math.min(CHUNK, remaining);
      // mutate first byte slightly to avoid perfect repetition patterns
      chunk[0] = (chunk[0] + 1) & 0xff;
      const canContinue = res.write(chunk.subarray(0, toWrite));
      remaining -= toWrite;
      if (!canContinue) {
        res.once('drain', writeMore);
        return;
      }
    }
    res.end();
  }

  writeMore();
});

// Speed test - upload (client -> server)
app.post('/api/speedtest/upload', (req, res) => {
  const MAX_BYTES = 200 * 1024 * 1024; // 200MB safety cap (also enforced by body parser limit)
  const bytes = req.body?.length || 0;
  if (bytes > MAX_BYTES) {
    return res.status(413).json({ error: 'Payload too large' });
  }
  res.json({ receivedBytes: bytes });
});

// Fallback to index.html for root
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Network Utility App running at http://localhost:${PORT}`);
});
