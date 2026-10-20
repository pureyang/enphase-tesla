const ring = [];

function push(level, tag, msg) {
  const line = { t: Date.now(), level, tag, msg: String(msg) };
  ring.push(line);
  if (ring.length > 300) ring.shift();
  const out = `${new Date(line.t).toISOString()} ${level.toUpperCase()} [${tag}] ${line.msg}`;
  (level === 'error' ? console.error : console.log)(out);
}

export const log = {
  info: (tag, msg) => push('info', tag, msg),
  warn: (tag, msg) => push('warn', tag, msg),
  error: (tag, msg) => push('error', tag, msg),
  recent: () => ring.slice(-100),
};
