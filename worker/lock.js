const LOCK_FILE = path.join(__dirname, '..', 'data', 'position-monitor.lock');

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
      // Check if process still alive
      try { process.kill(pid, 0); return false; } catch { /* process dead, stale lock */ }
    }
    fs.writeFileSync(LOCK_FILE, process.pid.toString());
    return true;
  } catch { return true; }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// Usage: at start of main()
if (!acquireLock()) {
  console.log('[PositionMonitor] Already running, skipping...');
  process.exit(0);
}

// At end: releaseLock() — but since we use process.exit, we register on exit
process.on('exit', () => releaseLock());
