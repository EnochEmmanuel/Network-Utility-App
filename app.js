// public/app.js

const $ = (sel) => document.querySelector(sel);

const hostInput = $('#hostInput');
const netOutput = $('#netOutput');
const speedOutput = $('#speedOutput');
const sysOutput = $('#sysOutput');

const btnPing = $('#btnPing');
const btnTrace = $('#btnTrace');
const btnSpeed = $('#btnSpeed');
const btnSysinfo = $('#btnSysinfo');

const dlSel = $('#downloadSize');
const ulSel = $('#uploadSize');

const dlMbpsEl = $('#dlMbps');
const ulMbpsEl = $('#ulMbps');
const latencyEl = $('#latency');

function prettyJson(obj) {
  return JSON.stringify(obj, null, 2);
}

function setStatus(el, text) {
  el.textContent = text;
}

function toMbps(bytes, ms) {
  if (ms <= 0) return 0;
  const bits = bytes * 8;
  const seconds = ms / 1000;
  return bits / seconds / 1_000_000;
}

// Ping
btnPing.addEventListener('click', async () => {
  const host = hostInput.value.trim();
  netOutput.textContent = 'Pinging...';
  if (!host) {
    netOutput.textContent = 'Please enter a host.';
    return;
  }
  try {
    const res = await fetch(`/api/ping?host=${encodeURIComponent(host)}`);
    const data = await res.json();
    const lines = [];
    lines.push(`ok: ${data.ok}, exitCode: ${data.exitCode}, timedOut: ${data.timedOut}`);
    if (data.stats) {
      const s = data.stats;
      lines.push(`Packets: sent=${s.transmitted ?? 'n/a'}, received=${s.received ?? 'n/a'}, loss=${s.loss ?? 'n/a'}%`);
      lines.push(`Latency ms: min=${s.min ?? 'n/a'}, avg=${s.avg ?? 'n/a'}, max=${s.max ?? 'n/a'}`);
      lines.push('');
      lines.push(s.raw || '');
      if (s.avg != null) {
        latencyEl.textContent = `${s.avg.toFixed(1)} ms`;
      }
    }
    netOutput.textContent = lines.join('\n');
  } catch (err) {
    netOutput.textContent = `Error: ${err}`;
  }
});

// Traceroute
btnTrace.addEventListener('click', async () => {
  const host = hostInput.value.trim();
  netOutput.textContent = 'Running traceroute...';
  if (!host) {
    netOutput.textContent = 'Please enter a host.';
    return;
  }
  try {
    const res = await fetch(`/api/traceroute?host=${encodeURIComponent(host)}`);
    const data = await res.json();
    const lines = [];
    lines.push(`ok: ${data.ok}, exitCode: ${data.exitCode}, timedOut: ${data.timedOut}`);
    lines.push('');
    lines.push(data.output || '');
    netOutput.textContent = lines.join('\n');
  } catch (err) {
    netOutput.textContent = `Error: ${err}`;
  }
});

// Speed test helpers
async function runDownloadTest(sizeBytes) {
  const start = performance.now();
  const res = await fetch(`/api/speedtest/download?size=${sizeBytes}`, { cache: 'no-store' });
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
  }
  const ms = performance.now() - start;
  return { bytes: received, ms, mbps: toMbps(received, ms) };
}

function makeRandomBlob(sizeBytes) {
  // Fill with pseudo-random data in chunks to avoid huge allocations
  const chunkSize = 64 * 1024;
  const chunks = Math.ceil(sizeBytes / chunkSize);
  const parts = [];
  let remaining = sizeBytes;
  let seed = 0;
  for (let i = 0; i < chunks; i++) {
    const len = Math.min(chunkSize, remaining);
    const buf = new Uint8Array(len);
    for (let j = 0; j < len; j++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      buf[j] = seed & 0xff;
    }
    parts.push(buf);
    remaining -= len;
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

async function runUploadTest(sizeBytes) {
  const blob = makeRandomBlob(sizeBytes);
  const start = performance.now();
  const res = await fetch('/api/speedtest/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob
  });
  const data = await res.json();
  const ms = performance.now() - start;
  const bytes = data.receivedBytes || sizeBytes;
  return { bytes, ms, mbps: toMbps(bytes, ms) };
}

btnSpeed.addEventListener('click', async () => {
  const dlSize = Number(dlSel.value);
  const ulSize = Number(ulSel.value);
  speedOutput.textContent = 'Running download test...';

  // Reset UI
  dlMbpsEl.textContent = '—';
  ulMbpsEl.textContent = '—';

  try {
    const dl = await runDownloadTest(dlSize);
    dlMbpsEl.textContent = `${dl.mbps.toFixed(2)} Mbps`;
    speedOutput.textContent =
      `Download: ${ (dl.bytes / (1024*1024)).toFixed(2) } MB in ${dl.ms.toFixed(0)} ms => ${dl.mbps.toFixed(2)} Mbps\n` +
      'Running upload test...';

    const ul = await runUploadTest(ulSize);
    ulMbpsEl.textContent = `${ul.mbps.toFixed(2)} Mbps`;
    speedOutput.textContent +=
      `\nUpload: ${ (ul.bytes / (1024*1024)).toFixed(2) } MB in ${ul.ms.toFixed(0)} ms => ${ul.mbps.toFixed(2)} Mbps`;
  } catch (err) {
    speedOutput.textContent = `Speed test error: ${err}`;
  }
});

// System info
btnSysinfo.addEventListener('click', async () => {
  sysOutput.textContent = 'Loading...';
  try {
    const res = await fetch('/api/sysinfo');
    const data = await res.json();
    // Make large arrays more compact for display
    const summary = {
      hostname: data.hostname,
      platform: data.platform,
      release: data.release,
      arch: data.arch,
      uptimeSec: data.uptimeSec,
      totalMem: data.totalMem,
      freeMem: data.freeMem,
      loadAvg: data.loadAvg,
      cpuCount: data.cpus.length,
      sampleCpu: data.cpus.slice(0, Math.min(2, data.cpus.length)),
      network: data.network
    };
    sysOutput.textContent = prettyJson(summary);
  } catch (err) {
    sysOutput.textContent = `Error: ${err}`;
  }
});
